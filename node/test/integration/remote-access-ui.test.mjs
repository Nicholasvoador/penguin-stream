/**
 * Remote access through the local UI API: off by default, switched on only
 * through its own endpoint, auto-approves only viewers that completed the
 * handshake with the code, shows every session, and never leaks the code.
 * Fake host/viewer classes stand in for the network (no capture, no sockets).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import './isolated-config.mjs';

const hosts = [];
class FakeHost extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.permissions = { kbm: opts.allowInput === true, pad: opts.allowGamepad === true };
    hosts.push(this);
  }
  setPermissions(p) { this.permissions = { ...this.permissions, ...p }; this.emit('permissions', this.permissions); }
  async start(approve) {
    this.approve = approve;
    return new Promise((resolve, reject) => { this.resolveStart = resolve; this.rejectStart = reject; });
  }
  notifyViewer(text) { (this.notices ??= []).push(text); }
  close(reason = 'fake closed', notice = null) {
    if (this.closedWith) return;
    this.closedWith = reason;
    this.closedNotice = notice;
    this.rejectStart?.(new Error(reason));
    this.emit('closed', reason);
  }
}
const viewers = [];
class FakeViewer extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; viewers.push(this); }
  async start() { return new Promise((resolve, reject) => { this.resolveStart = resolve; this.rejectStart = reject; }); }
  close(reason = 'closed') { if (this.closedWith) return; this.closedWith = reason; this.emit('closed', reason); }
  setInput() {}
}

const notified = [];
const remoteStates = [];
const desktop = {
  notify: (title, body) => notified.push({ title, body }),
  onRemoteAccess: (st) => remoteStates.push(st),
};

const { startUi } = await import('../../src/ui/server.mjs');
const { cleanupTransport } = await import('../../src/transport/peer.mjs');
const { generateAccessCode, generateShareCode } = await import('../../src/signal/code.mjs');
const { configDir } = await import('../../src/crypto/identity.mjs');

const CODE_RE = /^PA(-[0-9A-HJKMNP-TV-Z]{4}){8}$/;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await wait(10); }
  throw new Error('condition not met in time');
}

let ui;
const start = () => startUi({ port: 0, open: false, quiet: true, HostClass: FakeHost, ViewerClass: FakeViewer,
  consentTimeoutMs: 100, desktop, remoteMediaStartMs: 30_000 });
test.before(async () => { ui = await start(); });
test.after(async () => { await ui?.close?.(); cleanupTransport(); });

const call = async (p, body, method) => {
  const res = await fetch(`http://127.0.0.1:${ui.port}${p}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ui.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const remote = (action, extra = {}) => call('/api/remote-access', { action, ...extra });
const state = async () => (await call('/api/state')).body;
const listener = (code) => hosts.filter((h) => h.opts.code === code && !h.closedWith).at(-1);
const request = (fp = 'AAAA-BBBB-CCCC') => ({ fingerprint: fp, sas: 'apple banana cherry date', trusted: false,
  label: null, transport: { relayed: false, localType: 'host', remoteType: 'host' } });

test('remote access is off by default, and the generic settings API cannot switch it on or plant a code', async () => {
  const r = await call('/api/remote-access');
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, false);
  assert.equal(r.body.code, null);
  assert.equal((await state()).remote.enabled, false);
  const planted = generateAccessCode();
  await call('/api/settings', { remoteAccess: true, accessCode: planted, fps: 60 });
  assert.equal((await call('/api/remote-access')).body.enabled, false);
  assert.equal(hosts.length, 0, 'no listener');
  const on = await remote('enable');
  assert.notEqual(on.body.code, planted, 'the planted code was ignored');
  await remote('disable');
});

test('switching it on listens for the access code with control allowed, and the code stays out of state and settings', async () => {
  const on = await remote('enable');
  assert.equal(on.status, 200);
  assert.match(on.body.code, CODE_RE);
  const code = on.body.code;
  const l = await until(() => listener(code));
  assert.ok(l, 'a listener waits for the access code');
  assert.equal(l.opts.allowInput, true);
  assert.equal(typeof l.opts.restoreToken, 'function', 'the screen grant is read when capture starts, not now');
  assert.ok(l.opts.spentPartners instanceof Set, 'anti-replay memory');
  assert.ok(l.opts.mediaStartTimeoutMs > 0, 'an unattended capture that cannot start is reported, not left hanging');
  const st = await call('/api/state');
  const body = code.slice(3);
  assert.ok(!JSON.stringify(st.body).includes(body), 'not in the broadcast state');
  assert.equal(st.body.remote.enabled, true);
  assert.ok(!JSON.stringify((await call('/api/settings')).body).includes(body), 'not in settings');
  assert.equal((await call('/api/remote-access')).body.code, code, 'only its own endpoint hands it out');
  assert.equal(remoteStates.at(-1).enabled, true, 'the desktop shell is told (tray, keep awake)');
  assert.equal(remoteStates.at(-1).keepAwake, true, 'keeps the PC awake by default');
});

test('a viewer that completed the handshake with the code gets in without a prompt, and the PC shows it', async () => {
  const code = (await call('/api/remote-access')).body.code;
  const l = await until(() => listener(code));
  notified.length = 0;
  const verdict = await l.approve(request('DDDD-EEEE-FFFF'));
  assert.equal(verdict, true);
  let s = await state();
  assert.equal(s.pendingConsent, null, 'nobody was asked');
  assert.equal(s.mode, 'hosting-live');
  assert.equal(s.remote.live.fingerprint, 'DDDD-EEEE-FFFF');
  assert.equal(s.remote.status, 'live');
  l.emit('secure', { relayed: false, localType: 'host', remoteType: 'srflx', protocol: 'udp' });
  assert.match(notified.at(-1)?.title ?? '', /using this PC remotely/);
  assert.match(notified.at(-1).body, /DDDD-EEEE-FFFF/);
  assert.match((await call('/api/logs')).body.text, /remote access: device DDDD-EEEE-FFFF connected directly/);

  // End it from the PC: the viewer is told, the PC listens again.
  const before = hosts.length;
  assert.equal((await remote('end-session')).status, 200);
  assert.equal(l.closedWith, 'ended at this PC');
  assert.match(l.closedNotice, /ended at the remote computer/);
  await until(() => hosts.length > before && listener(code));
  s = await state();
  assert.equal(s.mode, 'idle');
  assert.equal(s.remote.live, null);
  assert.equal((await remote('end-session')).status, 409, 'nothing left to end');
});

test('a remote viewer is refused while this PC is in another session, with a reason it can show', async () => {
  const code = (await call('/api/remote-access')).body.code;
  const l = await until(() => listener(code));
  const c = await call('/api/connect', { code: generateShareCode() });
  assert.equal(c.status, 200);
  notified.length = 0;
  const verdict = await l.approve(request());
  assert.deepEqual(verdict, { ok: false, reason: 'the remote computer is busy with another session' });
  assert.equal((await state()).mode, 'connecting', 'the running session is untouched');
  assert.match(notified.at(-1).title, /refused/);
  await call('/api/stop', {});
});

test('a waiting share steps aside for a remote session and comes back with the same invitation', async () => {
  const code = (await call('/api/remote-access')).body.code;
  await call('/api/host', { allowInput: false });
  let s = await state();
  assert.equal(s.mode, 'hosting-waiting');
  const shareCode = s.code;
  const shareHost = hosts.filter((h) => h.opts.code === shareCode).at(-1);
  const l = await until(() => listener(code));
  assert.equal(await l.approve(request()), true);
  assert.equal(shareHost.closedWith, 'paused for a remote access session');
  s = await state();
  assert.equal(s.mode, 'hosting-live');
  assert.ok(s.remote.live);

  const before = hosts.length;
  l.emit('closed', 'viewer left');
  await until(() => hosts.length >= before + 2);
  s = await state();
  assert.equal(s.mode, 'hosting-waiting', 'the share is back');
  assert.equal(s.code, shareCode, 'with the same invitation');
  assert.ok(hosts.slice(before).some((h) => h.opts.code === shareCode), 'a new share attempt');
  assert.ok(listener(code), 'and remote access listens again');
  await call('/api/stop', {});
  assert.ok(listener(code), 'Stop ends the share, not remote access');
});

test('during a live share the listener steps aside completely, and comes back when it ends', async () => {
  const code = (await call('/api/remote-access')).body.code;
  const l = await until(() => listener(code));
  await call('/api/host', { allowInput: false });
  const shareHost = hosts.at(-1);
  await shareHost.approve(request('SHAR-EVIE-WER0'));       // pending consent -> answer it
  await until(async () => (await state()).pendingConsent);
  await call('/api/consent', { approve: true });
  shareHost.emit('secure', { relayed: false });
  assert.equal(l.closedWith, 'paused during another session', 'no relay sockets next to a live stream');
  let s = await state();
  assert.equal(s.remote.status, 'paused');
  assert.equal(listener(code), undefined);
  // A settings change while paused does not wake it up.
  await call('/api/settings', { fps: 30 });
  assert.equal(listener(code), undefined);
  const before = hosts.length;
  await call('/api/stop', {});
  await until(() => hosts.length > before && listener(code));
  s = await state();
  assert.notEqual(s.remote.status, 'paused');
});

test('Stop during a remote session ends it and the PC listens again', async () => {
  const code = (await call('/api/remote-access')).body.code;
  const l = await until(() => listener(code));
  assert.equal(await l.approve(request()), true);
  const before = hosts.length;
  await call('/api/stop', {});
  assert.equal(l.closedWith, 'stopped by user');
  assert.match(l.closedNotice ?? '', /ended at the remote computer/);
  await until(() => hosts.length > before && listener(code));
  assert.equal((await state()).remote.live, null);
});

test('a new code works at once, the old one stops, and a session using it ends', async () => {
  const old = (await call('/api/remote-access')).body.code;
  const l = await until(() => listener(old));
  assert.equal(await l.approve(request()), true);
  const r = await remote('new-code');
  assert.equal(r.status, 200);
  assert.match(r.body.code, CODE_RE);
  assert.notEqual(r.body.code, old);
  assert.equal(l.closedWith, 'access code changed');
  assert.match(l.closedNotice, /access code .* was changed/);
  await until(() => listener(r.body.code));
  assert.equal(listener(old), undefined, 'nothing listens for the old code');
  assert.equal((await call('/api/remote-access')).body.code, r.body.code);
});

test('an access code is remembered for one-click reconnect only when the user asks', async () => {
  const other = generateAccessCode();
  await call('/api/connect', { code: other });
  let v = viewers.at(-1);
  assert.equal(v.opts.code, other);
  assert.equal((await state()).viewerAccess, true, 'the UI shows no words to compare');
  v.emit('secure', { relayed: false });
  assert.notEqual((await state()).lastInvitation, other, 'not remembered by default');
  await call('/api/stop', {});
  await call('/api/connect', { code: other.toLowerCase(), remember: true });
  v = viewers.at(-1);
  v.emit('secure', { relayed: false });
  assert.equal((await state()).lastInvitation, other.toLowerCase());
  await call('/api/stop', {});
  // Its own code is refused as a viewer code on this PC.
  const own = (await call('/api/remote-access')).body.code;
  const r = await call('/api/connect', { code: own });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /access code of this PC/);
});

test('the viewer sees why the remote PC ended the session', async () => {
  await call('/api/connect', { code: generateAccessCode() });
  const v = viewers.at(-1);
  v.emit('notice', 'The session was ended at the remote computer.');
  assert.match((await call('/api/logs')).body.text, /remote computer: The session was ended at the remote computer/);
  await call('/api/stop', {});
});

test('turning it off stops listening, ends a live session with a notice, and is remembered', async () => {
  const code = (await call('/api/remote-access')).body.code;
  const l = await until(() => listener(code));
  assert.equal(await l.approve(request()), true);
  const before = hosts.length;
  const off = await remote('disable');
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  assert.equal(l.closedWith, 'remote access turned off');
  assert.match(l.closedNotice, /switched off/);
  await wait(100);
  assert.equal(hosts.length, before, 'nothing listens any more');
  assert.equal(hosts.filter((h) => !h.closedWith && h.opts.code === code).length, 0);
  const s = await state();
  assert.equal(s.mode, 'idle');
  assert.equal(s.remote.enabled, false);
  assert.equal(remoteStates.at(-1).enabled, false);
  const saved = JSON.parse(fs.readFileSync(path.join(configDir(), 'settings.json'), 'utf8'));
  assert.equal(saved.remoteAccess, false);
});

test('remote access comes back on by itself after a restart, with the same code', async () => {
  const code = (await remote('enable')).body.code;
  await ui.close();
  const before = hosts.length;
  ui = await start();
  await until(() => hosts.length > before && listener(code));
  const r = await call('/api/remote-access');
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.code, code);
});

test('the troubleshooting log never contains the access code', async () => {
  const code = (await call('/api/remote-access')).body.code;
  const logs = await call('/api/logs');
  const dir = logs.body.dir;
  let all = '';
  for (const f of fs.readdirSync(dir)) all += fs.readFileSync(path.join(dir, f), 'utf8');
  assert.ok(all.length > 0);
  assert.match(all, /remote access/);
  assert.ok(!all.includes(code.slice(3)), 'no code in any log file');
  const settingsFile = path.join(configDir(), 'settings.json');
  assert.equal(fs.statSync(settingsFile).mode & 0o077, 0, 'the settings file holding it is owner-only');
});

test('start at login is offered only where the app can do it', async () => {
  assert.equal((await state()).remote.startAtLogin, null, 'no desktop shell hook: not offered');
  const r = await remote('start-at-login', { on: true });
  assert.equal(r.status, 409);
});


test('Wayland: a grant that no longer works is forgotten and the card asks for setup again', async () => {
  // A remote session whose capture never started means the desktop asked for
  // screen permission with nobody at the PC: the saved grant is dead (revoked,
  // reset, or saved under another app identity). The card must go back to
  // "one-time setup" and the owner must be told.
  process.env.XDG_SESSION_TYPE = 'wayland';
  process.env.WAYLAND_DISPLAY = 'wayland-test';
  try {
    await remote('disable');
    const on = await remote('enable');
    assert.equal(on.body.needsSetup, true, 'no grant yet: the one-time setup is asked for');
    const code = on.body.code;
    const l = await until(() => listener(code), 15_000);
    assert.equal(await l.approve(request()), true);
    l.emit('restore-token', 'grant-1');          // this is how a real grant is saved
    notified.length = 0;
    l.emit('closed', 'screen capture did not start in time');
    let st;
    for (let i = 0; i < 100 && !(st = (await call('/api/remote-access')).body).needsSetup; i++) await wait(20);
    assert.equal(st.needsSetup, true, 'the card asks for the setup again');
    assert.match(st.setupReason ?? '', /once, while you are at the PC/);
    assert.match((await call('/api/logs')).body.text, /the saved screen permission no longer works/);
    assert.match(notified.at(-1)?.title ?? '', /needs your OK once/);
    const saved = JSON.parse(fs.readFileSync(path.join(configDir(), 'settings.json'), 'utf8'));
    assert.deepEqual(Object.keys(saved.portalTokens ?? {}), [], 'the dead grant is gone');
  } finally {
    delete process.env.XDG_SESSION_TYPE;
    delete process.env.WAYLAND_DISPLAY;
  }
});

test('Wayland: an ordinary ending keeps the saved grant', async () => {
  process.env.XDG_SESSION_TYPE = 'wayland';
  process.env.WAYLAND_DISPLAY = 'wayland-test';
  try {
    const code = (await call('/api/remote-access')).body.code;
    const l = await until(() => listener(code), 15_000);
    assert.equal(await l.approve(request()), true);
    l.emit('restore-token', 'grant-2');
    l.emit('closed', 'viewer left');
    await wait(200);
    const saved = JSON.parse(fs.readFileSync(path.join(configDir(), 'settings.json'), 'utf8'));
    assert.deepEqual(Object.values(saved.portalTokens ?? {}), ['grant-2'], 'the grant is kept');
    assert.equal((await remote('enable')).body.needsSetup, false, 'no setup needed any more');
  } finally {
    delete process.env.XDG_SESSION_TYPE;
    delete process.env.WAYLAND_DISPLAY;
  }
});
