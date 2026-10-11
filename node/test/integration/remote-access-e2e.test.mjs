/**
 * Remote access end to end, nothing mocked except the screen: the real UI
 * server and Host, the real ps-media engine (synthetic source - no test
 * captures the operator's desktop), real ICE/DTLS/SCTP/Noise, and a real
 * viewer session joining with the access code over a local rendezvous.
 */

process.env.PENGUIN_NOSTR = '0';   // offline and deterministic

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './isolated-config.mjs';

const { startUi } = await import('../../src/ui/server.mjs');
const { startRendezvous } = await import('../../src/signal/server.mjs');
const { joinSession } = await import('../../src/signal/client.mjs');
const { loadOrCreateIdentity } = await import('../../src/crypto/identity.mjs');
const { cleanupTransport, PeerState } = await import('../../src/transport/peer.mjs');
const { findMediaBinary } = await import('../../src/media/engine.mjs');
const { APP_VERSION, PROTOCOL_VERSION } = await import('../../src/app/session.mjs');

const mediaBin = findMediaBinary();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(25); }
  throw new Error('condition not met in time');
}

const identityDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ra-viewer-'));
const viewerId = loadOrCreateIdentity(identityDir);
let rv;
let ui;
const start = (extra = {}) => startUi({ port: 0, open: false, quiet: true, ...extra });
const call = async (p, body) => {
  const res = await fetch(`http://127.0.0.1:${ui.port}${p}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ui.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/** A viewer as the app runs it, minus the window: join, say hello, count frames, collect notices. */
async function viewerSession(code) {
  const session = await joinSession({ code, rendezvousUrl: rv.url, identity: viewerId.keypair, sessionTimeoutMs: 30_000 });
  const got = { frames: 0, config: null, notices: [], closed: null };
  session.peer.on('video', () => { got.frames++; });
  session.peer.on('control', (m) => {
    if (m?.t === 'media-config') got.config = m.config;
    if (m?.t === 'host-notice') got.notices.push(m.text);
  });
  session.peer.on('closed', (reason) => { got.closed = reason; });
  session.peer.sendControl({ t: 'hello', app: 'penguin-stream', version: APP_VERSION, protocol: PROTOCOL_VERSION });
  return { session, got };
}

test.before(async () => {
  rv = await startRendezvous({ port: 0, host: '127.0.0.1' });
  ui = await start();
  await call('/api/settings', { source: 'synthetic', rendezvous: rv.url, fps: 30, resolution: '540', audio: false });
});
test.after(async () => {
  await ui?.close?.();
  await rv?.close?.();
  cleanupTransport();
  fs.rmSync(identityDir, { recursive: true, force: true });
});

test('the owner reaches this PC with the access code: no prompt, video flows, the PC shows who', { skip: mediaBin ? false : 'ps-media not built', timeout: 60_000 }, async () => {
  const on = await call('/api/remote-access', { action: 'enable' });
  assert.equal(on.status, 200);
  const code = on.body.code;
  await until(async () => (await call('/api/state')).body.remote.status === 'ready');

  const { session, got } = await viewerSession(code);
  assert.equal(session.peer.state, PeerState.SECURE);
  await until(() => got.frames >= 30, 20_000);
  assert.ok(got.config, 'codec parameters arrived');
  assert.equal(got.config.capture, 'synthetic');

  const st = (await call('/api/state')).body;
  assert.equal(st.mode, 'hosting-live');
  assert.equal(st.pendingConsent, null, 'nobody had to approve');
  assert.equal(st.remote.live.fingerprint, viewerId.fingerprint, 'the PC shows which device connected');
  assert.equal(st.permissions.kbm, true, 'keyboard and mouse are allowed: it is your own PC');

  // Ended at the PC: the viewer is told why, then the PC listens again.
  assert.equal((await call('/api/remote-access', { action: 'end-session' })).status, 200);
  await until(() => got.closed !== null);
  assert.ok(got.notices.some((n) => /ended at the remote computer/.test(n)), `notice received (${got.notices})`);
  await until(async () => (await call('/api/state')).body.remote.status === 'ready');

  // A fresh session with the same code works straight away.
  const again = await viewerSession(code);
  await until(() => again.got.frames >= 10, 20_000);
  again.session.close();
  await until(async () => (await call('/api/state')).body.mode === 'idle');
});

test('when screen capture cannot start, the viewer is told why instead of a silent hang', { skip: mediaBin ? false : 'ps-media not built', timeout: 60_000 }, async () => {
  // A capture backend that does not exist here fails the way a refused or
  // unanswered permission prompt does: no picture ever comes.
  await call('/api/settings', { source: 'dxgi' });
  const code = (await call('/api/remote-access', { action: 'enable' })).body.code;
  await until(async () => (await call('/api/state')).body.remote.status === 'ready');
  const { got } = await viewerSession(code);
  // (Also proves a settings change reaches a listener that is already waiting.)
  await until(() => got.closed !== null, 20_000);
  assert.ok(got.notices.some((n) => /could not start screen capture/.test(n)), `notice: ${got.notices}`);
  assert.equal(got.frames, 0);
  await call('/api/settings', { source: 'synthetic' });
  await until(async () => (await call('/api/state')).body.remote.status === 'ready');
});

test('an unattended capture that does not start in time is ended and explained', { skip: mediaBin ? false : 'ps-media not built', timeout: 60_000 }, async () => {
  // Restart the UI with a start limit far shorter than any real capture start.
  await ui.close();
  ui = await start({ remoteMediaStartMs: 1 });
  const code = (await call('/api/remote-access', { action: 'enable' })).body.code;
  await until(async () => (await call('/api/state')).body.remote.status === 'ready');
  const { got } = await viewerSession(code);
  await until(() => got.closed !== null, 20_000);
  assert.ok(got.notices.some((n) => /could not start sharing its screen/.test(n)), `notice: ${got.notices}`);
  const logs = (await call('/api/logs')).body.text;
  assert.match(logs, /screen capture did not start within/);
  await call('/api/remote-access', { action: 'disable' });
});
