import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated config dir: this test writes settings.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ui-settings-'));
process.env.PENGUIN_STREAM_HOME = home;
const { startUi } = await import('../../src/ui/server.mjs');

let ui;
test.before(async () => { ui = await startUi({ port: 0, open: false, quiet: true }); });
test.after(async () => { await ui.close(); fs.rmSync(home, { recursive: true, force: true }); });

const call = (p, body, method) => fetch(`http://127.0.0.1:${ui.port}/api/${p}`, {
  method: method || (body ? 'POST' : 'GET'),
  headers: { authorization: `Bearer ${ui.token}`, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

test('settings round-trip through the API, validated, secrets write-only', async () => {
  const initial = await (await call('settings')).json();
  assert.equal(initial.fps, 60);
  assert.equal(initial.lowLatency, true);

  const saved = await (await call('settings', {
    fps: 120, bitrate: -5, relay: { mode: 'manual', turn: 'turn:relay.example.com:3478', turnUser: 'u', turnPassword: 'p4ss' },
  })).json();
  assert.equal(saved.fps, 120);
  assert.equal(saved.bitrate, 20000, 'invalid bitrate rejected');
  assert.equal(saved.relay.mode, 'manual');
  assert.equal(saved.relay.turnPasswordSet, true);

  const raw = await (await call('settings')).text();
  assert.ok(!raw.includes('p4ss'), 'secret never returned');
  const state = await (await call('state')).text();
  assert.ok(!state.includes('p4ss'), 'secret not in state either');
  assert.ok(fs.readFileSync(path.join(home, 'settings.json'), 'utf8').includes('p4ss'), 'secret persisted locally');

  assert.equal((await call('settings', undefined, 'PUT')).status, 405);
  assert.equal((await call('netcheck')).status, 405, 'netcheck is POST-only');
});

test('settings require the bearer token', async () => {
  const res = await fetch(`http://127.0.0.1:${ui.port}/api/settings`);
  assert.equal(res.status, 401);
});
