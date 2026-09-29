/**
 * Drives the local UI's HTTP API the way a browser would, including the
 * defences that matter because this endpoint can start a screen share.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import http from 'node:http';
import { EventEmitter } from 'node:events';
// Settings (the saved invitation code, the last host) go to a throwaway
// config dir. Must run before the server module is loaded (dynamic import below).
import './isolated-config.mjs';

const hosts = [];
class FakeHost extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.permissions = { kbm: opts.allowInput === true, pad: opts.allowGamepad === true };
    hosts.push(this);
  }
  setPermissions(p) {
    this.permissions = { kbm: p.kbm ?? this.permissions.kbm, pad: p.pad ?? this.permissions.pad };
    this.emit('permissions', this.permissions);
  }
  async start(approve) {
    this.approve = approve;
    return new Promise((resolve, reject) => { this.resolveStart = resolve; this.rejectStart = reject; });
  }
  close(reason = 'fake closed') {
    if (this.closedWith) return;
    this.closedWith = reason;
    this.emit('closed', reason);
  }
}

class FakeViewer extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; viewers.push(this); }
  async start() { return new Promise((resolve, reject) => { this.resolveStart = resolve; this.rejectStart = reject; }); }
  close(reason = 'closed') {
    if (this.closedWith) return;
    this.closedWith = reason;
    this.emit('closed', reason);
  }
  setInput() {}
}
const viewers = [];

const { startUi } = await import('../../src/ui/server.mjs');
import { cleanupTransport } from '../../src/transport/peer.mjs';

let ui;

test.before(async () => {
  ui = await startUi({ port: 0, open: false, HostClass: FakeHost, ViewerClass: FakeViewer, consentTimeoutMs: 100 });
});

test.after(async () => {
  await ui?.close?.();
  cleanupTransport();
});

const call = (path, { token = ui.token, method = 'GET', body, headers = {} } = {}) =>
  fetch(`http://127.0.0.1:${ui.port}${path}`, {
    method: body ? 'POST' : method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

test('serves the UI over plain HTTP with no certificate warning to click through', async () => {
  const res = await fetch(`http://127.0.0.1:${ui.port}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Share this screen/);
  assert.match(html, /Connect to a screen/);
  // The security-critical prompt must exist in the shipped markup.
  assert.match(html, /Verification words/);
});

test('static responses carry a restrictive CSP and nosniff', async () => {
  const res = await fetch(`http://127.0.0.1:${ui.port}/`);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.ok(!/unsafe-inline/.test(csp), 'CSP must not allow inline script');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('the API rejects requests with no token', async () => {
  const res = await call('/api/state', { token: null });
  assert.equal(res.status, 401);
});

test('the API rejects a wrong token, including one of the same length', async () => {
  assert.equal((await call('/api/state', { token: 'wrong' })).status, 401);
  const sameLength = 'A'.repeat(ui.token.length);
  assert.equal((await call('/api/state', { token: sameLength })).status, 401);
});

test('the API accepts the real token', async () => {
  const res = await call('/api/state');
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.equal(state.mode, 'idle');
  assert.match(state.identity.fingerprint, /^[0-9A-Z-]+$/);
});

test('state never exposes the private key or the UI token', async () => {
  const body = await (await call('/api/state')).text();
  assert.ok(!body.includes('privateKey'));
  assert.ok(!body.includes(ui.token), 'the state must not echo the bearer token');
  assert.ok(!/"d"\s*:/.test(body), 'no JWK private component');
});

// fetch() refuses to let us set Host, so this uses the raw client to make sure
// the rebinding defence is genuinely exercised rather than silently skipped.
function rawRequest(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: ui.port, path: pathname, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('a non-loopback Host header is refused (DNS rebinding defence)', async () => {
  const res = await rawRequest('/api/state', {
    host: 'evil.example.com',
    authorization: `Bearer ${ui.token}`,
  });
  assert.equal(res.status, 403);
});

test('a cross-site Origin is refused (CSRF defence)', async () => {
  const res = await call('/api/state', { headers: { origin: 'http://evil.example.com' } });
  assert.equal(res.status, 403);
});

test('consent cannot be granted when nothing is pending', async () => {
  const res = await call('/api/consent', { body: { approve: true } });
  assert.equal(res.status, 409, 'must not accept a consent nobody asked for');
});

test('connect without a code is rejected', async () => {
  const res = await call('/api/connect', { body: {} });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /share code/i);
});

test('connect with a malformed code is rejected', async () => {
  const res = await call('/api/connect', { body: { code: 'nope' } });
  assert.equal(res.status, 400);
});

test('stop is safe when nothing is running', async () => {
  const res = await call('/api/stop', { body: {} });
  assert.equal(res.status, 200);
});

test('oversized request bodies are refused', async () => {
  const res = await fetch(`http://127.0.0.1:${ui.port}/api/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ui.token}` },
    body: JSON.stringify({ code: 'A'.repeat(200_000) }),
  });
  assert.ok(res.status === 413 || res.status === 400, `expected rejection, got ${res.status}`);
});

test('path traversal cannot escape the public directory', async () => {
  for (const p of ['/../package.json', '/../../package.json', '/..%2f..%2fpackage.json',
                   '/%2e%2e/%2e%2e/package.json', '/subdir/../../package.json']) {
    const res = await rawRequest(p, { host: `127.0.0.1:${ui.port}` });
    assert.ok(res.status !== 200, `traversal succeeded for ${p}`);
    assert.ok(!res.body.includes('penguin-stream'), `${p} leaked file contents`);
  }
});

test('the websocket refuses a bad token', async () => {
  const { WebSocket } = await import('ws');
  const closed = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ui.port}/ws?token=nope`);
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => resolve(-1));
    setTimeout(() => resolve(0), 3000).unref();
  });
  assert.ok(closed === 4001 || closed === -1, `expected rejection, got close code ${closed}`);
});

test('methods, token transport, and capability reporting are explicit', async () => {
  for (const route of ['host', 'connect', 'stop', 'consent', 'revoke']) {
    assert.equal((await call(`/api/${route}`)).status, 405);
  }
  assert.equal((await call('/api/state', { body: {} })).status, 405);
  assert.equal((await call(`/api/state?token=${ui.token}`, { token: null })).status, 401);
  const res = await call('/api/state');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const state = await res.json();
  assert.equal(state.permissions, null, 'no permissions exist before sharing');
  assert.equal(typeof state.platform, 'string');
  assert.ok(new URL(ui.url).hash.startsWith('#token='));
  assert.equal(new URL(ui.url).search, '');
});

test('websocket upgrade rejects cross-site Origin and non-loopback Host even with valid token', async () => {
  const { WebSocket } = await import('ws');
  for (const headers of [{ Origin: 'https://evil.example' }, { Host: 'evil.example' }]) {
    const status = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ui.port}/ws?token=${ui.token}`, { headers });
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('upgrade timeout')); }, 2000);
      ws.on('unexpected-response', (_, res) => { clearTimeout(timer); res.resume(); ws.terminate(); resolve(res.statusCode); });
      ws.on('error', () => {});
      ws.on('open', () => { clearTimeout(timer); ws.terminate(); reject(new Error('unsafe upgrade accepted')); });
    });
    assert.equal(status, 401);
  }
});

const getState = async () => (await call('/api/state')).json();
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test('stopping pending consent cancels it; old callbacks cannot mutate a new session', async () => {
  await call('/api/host', { body: {} });
  const old = hosts.at(-1);
  const decision = old.approve({ sas: 'old words', fingerprint: 'AAAA' });
  assert.equal((await getState()).mode, 'hosting-consent');
  await call('/api/stop', { body: {} });
  assert.equal(await decision, false);
  assert.equal((await getState()).mode, 'idle');
  await call('/api/host', { body: {} });
  const current = hosts.at(-1);
  const count = hosts.length;
  old.emit('code', 'STALE'); old.emit('closed', 'late'); old.rejectStart(new Error('late failure'));
  assert.equal(await old.approve({ sas: 'stale', fingerprint: 'AAAA' }), false);
  await settle(130);
  const state = await getState();
  assert.equal(state.mode, 'hosting-waiting');
  assert.notEqual(state.code, 'STALE', 'a stale session cannot change the invitation');
  assert.equal(hosts.length, count, 'a stale session cannot re-arm the share');
  const timed = current.approve({ sas: 'new words', fingerprint: 'BBBB' });
  assert.equal(await timed, false);
  assert.equal((await getState()).mode, 'hosting-waiting');
  await call('/api/stop', { body: {} });
});

// 1.4.0: the invitation is the same every time, sharing survives a dropped
// or failed session, and a viewer approved in this share gets back in.
test('the invitation code stays the same across shares until a new one is requested', async () => {
  await call('/api/host', { body: {} });
  const code1 = (await getState()).code;
  assert.match(code1, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
  assert.equal(hosts.at(-1).opts.code, code1, 'the host session uses the saved code');
  await call('/api/stop', { body: {} });
  await call('/api/host', { body: {} });
  assert.equal((await getState()).code, code1, 'same code on the next share');

  const res = await call('/api/new-code', { body: {} });
  assert.equal(res.status, 200);
  const code2 = (await res.json()).code;
  assert.notEqual(code2, code1);
  await settle();
  assert.equal((await getState()).code, code2, 'the running share switched to the new code');
  assert.equal(hosts.at(-1).opts.code, code2, 'a fresh attempt listens on the new code');
  await call('/api/stop', { body: {} });
  await call('/api/host', { body: {} });
  assert.equal((await getState()).code, code2, 'and it is kept from then on');
  await call('/api/stop', { body: {} });
});

test('a dropped or failed session keeps sharing; an approved device reconnects without asking', async () => {
  await call('/api/host', { body: {} });
  const first = hosts.at(-1);
  const code = (await getState()).code;
  // viewer approved by the user
  const decision = first.approve({ sas: 'w o r d', fingerprint: 'FRIEND' });
  await call('/api/consent', { body: { approve: true } });
  assert.equal(await decision, true);
  assert.equal((await getState()).mode, 'hosting-live');
  // the connection drops (the 1.3.1 field bug)
  first.emit('closed', 'control channel closed');
  await settle();
  let state = await getState();
  assert.equal(state.mode, 'hosting-waiting', 'still sharing after a drop');
  assert.equal(state.code, code, 'with the same invitation');
  const second = hosts.at(-1);
  assert.notEqual(second, first, 'a new attempt is waiting');
  // the same device comes back: no prompt
  assert.equal(await second.approve({ sas: 'x y z w', fingerprint: 'FRIEND' }), true);
  assert.equal((await getState()).mode, 'hosting-live');
  assert.equal((await getState()).pendingConsent, null, 'no consent prompt for a device approved in this share');
  // a stranger still has to ask
  second.emit('closed', 'peer left');
  await settle();
  const third = hosts.at(-1);
  const strangerDecision = third.approve({ sas: 'a b c d', fingerprint: 'STRANGER' });
  assert.equal((await getState()).mode, 'hosting-consent');
  await call('/api/consent', { body: { approve: false } });
  assert.equal(await strangerDecision, false);
  // a failed attempt (e.g. ICE) also keeps sharing
  third.rejectStart(new Error('ICE connection failed'));
  await settle(1200);   // an instant failure backs off ~1 s
  state = await getState();
  assert.equal(state.mode, 'hosting-waiting');
  assert.ok(hosts.at(-1) !== third, 'a new attempt after a failure');
  await call('/api/stop', { body: {} });
  assert.equal((await getState()).mode, 'idle');
  const after = hosts.length;
  await settle(1200);
  assert.equal(hosts.length, after, 'Stop ends the share: nothing re-arms');
});

test('a viewer reconnects by itself after a drop, and Cancel stops it', async () => {
  const code = 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789';
  assert.equal((await call('/api/connect', { body: { code } })).status, 200);
  const v1 = viewers.at(-1);
  v1.emit('secure', { relayed: false });
  assert.equal((await getState()).mode, 'viewing');
  assert.equal((await getState()).lastInvitation, code, 'the working invitation is remembered');
  v1.emit('closed', 'control channel closed');
  await settle();
  assert.equal((await getState()).mode, 'reconnecting');
  await settle(450);
  const v2 = viewers.at(-1);
  assert.notEqual(v2, v1, 'a new attempt was started');
  assert.equal(v2.opts.code, v1.opts.code);
  await call('/api/stop', { body: {} });
  assert.equal((await getState()).mode, 'idle');
  assert.ok(v2.closedWith, 'Cancel closes the attempt');
  // a deliberate ending (window closed) does not reconnect
  await call('/api/connect', { body: { code } });
  const v3 = viewers.at(-1);
  v3.emit('secure', {});
  v3.emit('closed', 'viewer window closed');
  await settle(450);
  assert.equal((await getState()).mode, 'idle');
  assert.equal(viewers.at(-1), v3);
});

test('live input permissions: only while sharing, strictly typed, applied to the host', async () => {
  assert.equal((await call('/api/permissions', { body: { kbm: true } })).status, 409, 'not sharing yet');
  assert.equal((await call('/api/viewer-input', { body: { kbm: true } })).status, 409, 'not viewing');

  const before = hosts.length;
  const started = await call('/api/host', { body: { allowInput: true, allowGamepad: false, source: 'synthetic',
    encoder: 'nvenc; rm -rf /', display: '../1' } });
  assert.equal(started.status, 200);
  const host = hosts[before];
  assert.deepEqual(host.permissions, { kbm: true, pad: false });
  assert.equal(host.opts.inputCapable, true, 'UI hosts ask for control permission up front');
  assert.equal(host.opts.encoder, undefined, 'unknown encoder strings are dropped, not passed through');
  assert.equal(host.opts.display, undefined, 'display must be a small index');

  assert.equal((await call('/api/permissions', { body: { kbm: 'yes' } })).status, 400);
  assert.equal((await call('/api/permissions', { body: { kbm: false, pad: true } })).status, 200);
  assert.deepEqual(host.permissions, { kbm: false, pad: true });
  const state = await (await call('/api/state')).json();
  assert.deepEqual(state.permissions, { kbm: false, pad: true });

  assert.equal((await call('/api/stop', { body: {} })).status, 200);
});
