/**
 * End-to-end transport tests. These start a real rendezvous server on
 * localhost and run two real libdatachannel peers through ICE, DTLS, SCTP,
 * the Noise handshake and the consent gate. Nothing here is mocked.
 */

// Offline and deterministic: these tests use a local rendezvous only.
process.env.PENGUIN_NOSTR ??= '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startRendezvous } from '../../src/signal/server.mjs';
import { hostSession, joinSession } from '../../src/signal/client.mjs';
import { generateShareCode, normalizeShareCode, parseInvitation, roomIdFor, signalingKey, sealSignal, openSignal } from '../../src/signal/code.mjs';
import { resolveIceServers, DEFAULT_STUN_SERVERS } from '../../src/app/session.mjs';
import { loadOrCreateIdentity } from '../../src/crypto/identity.mjs';
import { cleanupTransport, PeerState } from '../../src/transport/peer.mjs';
import { CHANNEL } from '../../src/crypto/session.mjs';

function tmpIdentity(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ps-${tag}-`));
  const id = loadOrCreateIdentity(dir);
  return { id, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function withRendezvous(fn) {
  const rv = await startRendezvous({ port: 0, host: '127.0.0.1' });
  try {
    return await fn(rv);
  } finally {
    await rv.close();
  }
}

/** Brings up a consented host+client pair over the given rendezvous. */
async function connectPair(rv, { approve = true, iceTransportPolicy = 'all', iceServers = [] } = {}) {
  const h = tmpIdentity('host');
  const c = tmpIdentity('client');
  const code = generateShareCode();

  const consentSeen = {};
  const hostPromise = hostSession({
    code,
    rendezvousUrl: rv.url,
    identity: h.id.keypair,
    iceServers,
    iceTransportPolicy,
    onConsentRequest: async (info) => {
      consentSeen.sas = info.sas.phrase;
      consentSeen.remoteStatic = info.remoteStatic;
      return approve;
    },
  });

  // Give the host a moment to register the room before the client joins.
  await new Promise((r) => setTimeout(r, 150));

  const clientPromise = joinSession({
    code,
    rendezvousUrl: rv.url,
    identity: c.id.keypair,
    iceServers,
    iceTransportPolicy,
  });

  const cleanup = () => { h.cleanup(); c.cleanup(); };
  return { hostPromise, clientPromise, code, consentSeen, hostId: h.id, clientId: c.id, cleanup };
}

test.after(() => cleanupTransport());

test('two peers connect, agree on the SAS, and exchange authenticated control messages', async () => {
  await withRendezvous(async (rv) => {
    const ctx = await connectPair(rv);
    const [host, client] = await Promise.all([ctx.hostPromise, ctx.clientPromise]);

    try {
      assert.equal(host.peer.state, PeerState.SECURE);
      assert.equal(client.peer.state, PeerState.SECURE);

      // The humans would compare these two strings.
      assert.equal(host.peer.sas.phrase, client.peer.sas.phrase, 'SAS must match on an honest path');
      assert.equal(ctx.consentSeen.sas, client.peer.sas.phrase, 'consent prompt showed the right SAS');

      // Each side authenticated the other's real long-term identity.
      assert.deepEqual(host.peer.remoteStatic, ctx.clientId.pub);
      assert.deepEqual(client.peer.remoteStatic, ctx.hostId.pub);

      // Real application traffic over the encrypted control channel.
      const got = new Promise((resolve) => host.peer.once('control', resolve));
      client.peer.sendControl({ t: 'hello', from: 'client' });
      assert.deepEqual(await got, { t: 'hello', from: 'client' });

      const back = new Promise((resolve) => client.peer.once('control', resolve));
      host.peer.sendControl({ t: 'welcome' });
      assert.deepEqual(await back, { t: 'welcome' });

      const info = host.peer.transportInfo();
      assert.ok(info.connected, 'a candidate pair must be selected');
    } finally {
      ctx.cleanup();
      host.close();
      client.close();
    }
  });
});

test('unreliable media channel carries authenticated frames', async () => {
  await withRendezvous(async (rv) => {
    const ctx = await connectPair(rv);
    const [host, client] = await Promise.all([ctx.hostPromise, ctx.clientPromise]);

    try {
      const received = [];
      const done = new Promise((resolve) => {
        client.peer.on('video', (payload) => {
          received.push(payload);
          if (received.length === 20) resolve();
        });
      });

      for (let i = 0; i < 20; i++) {
        host.peer.sendMedia(CHANNEL.VIDEO, Buffer.from(`frame-${i}`.padEnd(200, '.')));
      }

      await Promise.race([
        done,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`only ${received.length}/20 frames arrived`)), 15_000)),
      ]);

      assert.equal(received.length, 20);
      assert.ok(received[0].toString().startsWith('frame-'));
      assert.equal(client.peer.session.stats.rejected, 0, 'no frame should fail authentication');
    } finally {
      ctx.cleanup();
      host.close();
      client.close();
    }
  });
});

test('host declining consent refuses the connection on both sides', async () => {
  await withRendezvous(async (rv) => {
    const ctx = await connectPair(rv, { approve: false });
    const results = await Promise.allSettled([ctx.hostPromise, ctx.clientPromise]);
    ctx.cleanup();

    assert.equal(results[1].status, 'rejected', 'client must be told it was refused');
    assert.match(results[1].reason.message, /refused|declined|closed/i);
  });
});

test('a wrong share code cannot join the session', async () => {
  await withRendezvous(async (rv) => {
    const h = tmpIdentity('host');
    const c = tmpIdentity('client');
    const code = generateShareCode();

    const hostPromise = hostSession({
      code,
      rendezvousUrl: rv.url,
      identity: h.id.keypair,
      onConsentRequest: async () => true,
      sessionTimeoutMs: 6000,
    });
    await new Promise((r) => setTimeout(r, 150));

    let wrong = generateShareCode();
    while (wrong === code) wrong = generateShareCode();

    const clientPromise = joinSession({
      code: wrong,
      rendezvousUrl: rv.url,
      identity: c.id.keypair,
      sessionTimeoutMs: 6000,
    });

    const results = await Promise.allSettled([hostPromise, clientPromise]);
    h.cleanup(); c.cleanup();

    assert.equal(results[1].status, 'rejected', 'wrong code must not connect');
    // The wrong code hashes to a different room, so the server reports no session.
    assert.match(results[1].reason.message, /no such session|closed|secure|rendezvous/i);
  });
});

test('rendezvous server never sees the share code or plaintext signaling', async () => {
  const code = generateShareCode();
  const room = roomIdFor(code);
  const key = signalingKey(code);

  // What the server receives:
  const payload = sealSignal(key, { kind: 'candidate', candidate: 'candidate:1 1 UDP 1 192.168.1.50 50000 typ host', mid: '0' });

  assert.ok(!room.includes(code.replace('-', '')), 'room id must not embed the code');
  assert.match(room, /^[0-9a-f]{32}$/);

  const decoded = Buffer.from(payload, 'base64').toString('latin1');
  assert.ok(!decoded.includes('192.168.1.50'), 'local IP must not be readable in the relayed payload');
  assert.ok(!decoded.includes('candidate'), 'SDP structure must not be readable');

  // Only the code-holder can read it.
  assert.equal(openSignal(key, payload).mid, '0');
  let other = generateShareCode();
  while (other === code) other = generateShareCode();
  assert.throws(() => openSignal(signalingKey(other), payload));
});

test('parseInvitation extracts codes and optional embedded rendezvous URLs', () => {
  const code = 'K7QA-3ZM2-K7QA-3ZM2-K7QA-3ZM2-K7QA-3ZM2';
  // Bare code
  assert.deepEqual(parseInvitation(code), { code, rendezvousUrl: undefined });
  // With @ws://
  assert.deepEqual(parseInvitation(`${code}@ws://192.168.1.50:8787`), {
    code,
    rendezvousUrl: 'ws://192.168.1.50:8787',
  });
  // With penguin:// scheme
  assert.deepEqual(parseInvitation(`penguin://relay.example.com:8787/${code}`), {
    code,
    rendezvousUrl: 'ws://relay.example.com:8787',
  });
  // normalizeShareCode also tolerates embedded URL
  assert.equal(normalizeShareCode(`${code}@ws://1.2.3.4:8787`), code);
});

test('resolveIceServers provides resilient STUN defaults for P2P and respects overrides', () => {
  // Default provides public STUN servers
  const def = resolveIceServers({});
  assert.ok(def.length >= 3);
  assert.ok(def.some(s => s.urls.includes('google.com')));
  assert.ok(def.some(s => s.urls.includes('cloudflare.com')));

  // Explicit no-stun / off
  assert.deepEqual(resolveIceServers({ noStun: true }), []);
  assert.deepEqual(resolveIceServers({ stun: 'none' }), []);
  assert.deepEqual(resolveIceServers({ stun: 'off' }), []);

  // Custom STUN
  const custom = resolveIceServers({ stun: 'stun:custom.relay:3478' });
  assert.equal(custom.length, 1);
  assert.equal(custom[0].urls, 'stun:custom.relay:3478');
});

test('invitations have 160-bit space and normalize without accepting legacy codes', () => {
  const code = 'K7QA-3ZM2-K7QA-3ZM2-K7QA-3ZM2-K7QA-3ZM2';
  assert.equal(normalizeShareCode(code.toLowerCase().replaceAll('-', ' ')), code);
  assert.equal(normalizeShareCode('OI112345'.repeat(4)), '0111-2345-0111-2345-0111-2345-0111-2345');
  for (const invalid of ['short', 'K7QA-3ZM2', code + 'X', 'U'.repeat(32)])
    assert.throws(() => normalizeShareCode(invalid));
  const generated = new Set(Array.from({length: 1000}, generateShareCode));
  assert.equal(generated.size, 1000);
  for (const value of generated) assert.match(value, /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
  assert.equal(roomIdFor(code.toLowerCase().replaceAll('-', '')), roomIdFor(code));
});

test('rendezvous rate-limits room-guessing attempts', async () => {
  await withRendezvous(async (rv) => {
    const { WebSocket } = await import('ws');
    let rejected = 0;
    let limited = false;

    for (let i = 0; i < 25; i++) {
      const ws = new WebSocket(rv.url);
      // eslint-disable-next-line no-await-in-loop
      const outcome = await new Promise((resolve) => {
        ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room: roomIdFor(generateShareCode()) })));
        ws.on('message', (raw) => resolve(JSON.parse(raw.toString())));
        ws.on('error', () => resolve({ t: 'error', message: 'socket error' }));
        setTimeout(() => resolve({ t: 'timeout' }), 2000);
      });
      ws.close();
      if (outcome.t === 'error') {
        rejected++;
        if (/slow down|too many/i.test(outcome.message)) limited = true;
      }
    }

    assert.ok(rejected > 0, 'guesses must be rejected');
    assert.ok(limited, 'repeated guessing must trip the rate limiter');
  });
});
