import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeIceServers } from '../../src/transport/peer.mjs';
import { resolveRelay, cleanIceList, describeRelay } from '../../src/net/relay.mjs';
import { probeTurn } from '../../src/net/netcheck.mjs';
import { SettingsStore, sanitizeSettings } from '../../src/app/settings.mjs';
import { startTurnServer } from '../../../turn/src/server.mjs';

const CLOUDFLARE_SHAPE = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'u', credential: 'p',
    },
  ],
};

test('Cloudflare-style url arrays become UDP-only libjuice entries', () => {
  const out = normalizeIceServers(cleanIceList(CLOUDFLARE_SHAPE));
  assert.deepEqual(out, [
    { hostname: 'stun.cloudflare.com', port: 3478 },
    { hostname: 'turn.cloudflare.com', port: 3478, relayType: 'TurnUdp', username: 'u', password: 'p' },
  ]);
});

test('TURN entries are capped at the two libjuice supports; IPv6 literals parse', () => {
  const out = normalizeIceServers([
    { urls: ['turn:a:1', 'turn:b:2', 'turn:c:3'], username: 'x', credential: 'y' },
    { urls: 'stun:[2001:db8::1]:3478' },
  ]);
  assert.equal(out.filter((e) => e.relayType).length, 2);
  assert.deepEqual(out.at(-1), { hostname: '2001:db8::1', port: 3478 });
});

test('manual relay accepts bare host:port and keeps credentials', async () => {
  const servers = await resolveRelay({ mode: 'manual', turn: 'relay.example.com:3478', turnUser: 'a', turnPassword: 'b' });
  assert.deepEqual(servers, [{ urls: ['turn:relay.example.com:3478'], username: 'a', credential: 'b' }]);
  assert.equal(describeRelay({ mode: 'manual', turn: 'turn:relay.example.com:3478' }), 'TURN relay.example.com:3478');
  assert.deepEqual(await resolveRelay({ mode: 'none' }), []);
  await assert.rejects(resolveRelay({ mode: 'url', url: 'http://insecure.example' }), /https/);
  await assert.rejects(resolveRelay({ mode: 'cloudflare', cfKeyId: 'bad id', cfToken: 't' }), /key ID/);
});

test('settings persist privately, validate input and never expose secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-settings-'));
  try {
    const store = new SettingsStore(dir);
    store.update({ fps: 120, bitrate: 'lots', encoder: 'rm -rf', relay: { mode: 'manual', turn: 'h:1', turnPassword: 'hunter2' } });
    const again = new SettingsStore(dir).get();
    assert.equal(again.fps, 120);
    assert.equal(again.bitrate, 20000, 'invalid bitrate ignored');
    assert.equal(again.encoder, '', 'invalid encoder ignored');
    assert.equal(again.relay.turnPassword, 'hunter2');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(dir, 'settings.json')).mode & 0o077, 0, 'owner-only file');
    }
    const pub = JSON.stringify(store.publicSettings());
    assert.ok(!pub.includes('hunter2'));
    assert.equal(store.publicSettings().relay.turnPasswordSet, true);
    // Omitted secret keeps the stored one; empty string clears it.
    store.update({ relay: { turnUser: 'bob' } });
    assert.equal(store.get().relay.turnPassword, 'hunter2');
    store.update({ relay: { turnPassword: '' } });
    assert.equal(store.get().relay.turnPassword, '');
    assert.deepEqual(sanitizeSettings({ relay: { url: 'http://x' } }).relay, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probeTurn proves credentials with a real Allocate and releases it', async () => {
  const { server, port } = await startTurnServer({ port: 0, users: { alice: 'secret' } });
  try {
    const good = await probeTurn([{ urls: [`turn:127.0.0.1:${port}`], username: 'alice', credential: 'secret' }]);
    assert.equal(good.ok, true, good.error);
    assert.ok(good.relayedAddress);
    const bad = await probeTurn([{ urls: [`turn:127.0.0.1:${port}`], username: 'alice', credential: 'nope' }]);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /rejected/);
    const none = await probeTurn([{ urls: ['turns:x:443'] }]);
    assert.match(none.error, /no UDP TURN/);
  } finally {
    await server.close?.();
  }
});
