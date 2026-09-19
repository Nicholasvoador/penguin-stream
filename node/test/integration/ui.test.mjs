/**
 * Drives the local UI's HTTP API the way a browser would, including the
 * defences that matter because this endpoint can start a screen share.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import http from 'node:http';

import { startUi } from '../../src/ui/server.mjs';
import { cleanupTransport } from '../../src/transport/peer.mjs';

let ui;

test.before(async () => {
  ui = await startUi({ port: 0, open: false });
});

test.after(() => {
  ui?.close?.();
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
    setTimeout(() => resolve(0), 3000);
  });
  assert.ok(closed === 4001 || closed === -1, `expected rejection, got close code ${closed}`);
});
