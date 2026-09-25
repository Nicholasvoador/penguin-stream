/**
 * Signaling behaviour that matters in real use: invitations that wait, Nostr
 * as a transport (against a local mock relay, so no Internet is needed),
 * relay choice agreement, and lossy/duplicated delivery.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

import { startRendezvous } from '../../src/signal/server.mjs';
import { hostSession, joinSession } from '../../src/signal/client.mjs';
import { pickRelays, nostrTopicFor, DEFAULT_NOSTR_RELAYS } from '../../src/signal/nostr.mjs';
import { generateShareCode } from '../../src/signal/code.mjs';
import { loadOrCreateIdentity } from '../../src/crypto/identity.mjs';
import { cleanupTransport, PeerState } from '../../src/transport/peer.mjs';

const tmpIdentity = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-sig-'));
  return { id: loadOrCreateIdentity(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

/** Minimal NIP-01 relay: REQ/EVENT/CLOSE with kinds + #x filters, optional loss/dupes. */
async function mockRelay({ dropEvery = 0, duplicate = false } = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const subs = new Map();   // ws -> Map(subId, filter)
  let n = 0;
  const stats = { events: 0, dropped: 0 };
  wss.on('connection', (ws) => {
    subs.set(ws, new Map());
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg[0] === 'REQ') subs.get(ws).set(msg[1], msg[2]);
      else if (msg[0] === 'CLOSE') subs.get(ws).delete(msg[1]);
      else if (msg[0] === 'EVENT') {
        const ev = msg[1];
        stats.events++;
        ws.send(JSON.stringify(['OK', ev.id, true, '']));
        if (dropEvery && ++n % dropEvery === 0) { stats.dropped++; return; }
        for (const [client, map] of subs) {
          for (const [subId, f] of map) {
            if (f.kinds?.includes(ev.kind) && ev.tags.some((t) => t[0] === 'x' && f['#x']?.includes(t[1]))) {
              client.send(JSON.stringify(['EVENT', subId, ev]));
              if (duplicate) client.send(JSON.stringify(['EVENT', subId, ev]));
            }
          }
        }
      }
    });
    ws.on('close', () => subs.delete(ws));
  });
  return { url: `ws://127.0.0.1:${wss.address().port}`, stats, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) };
}

test.after(() => cleanupTransport());

test('both peers pick the same relays for an invitation, always including the anchors', () => {
  const a = nostrTopicFor(Buffer.from('A'.repeat(32)));
  const b = nostrTopicFor(Buffer.from('B'.repeat(32)));
  const pickA = pickRelays(DEFAULT_NOSTR_RELAYS, 6, a.topic);
  assert.deepEqual(pickRelays(DEFAULT_NOSTR_RELAYS, 6, a.topic), pickA, 'deterministic for one invitation');
  assert.deepEqual(pickA.slice(0, 3), DEFAULT_NOSTR_RELAYS.slice(0, 3), 'anchor relays first');
  assert.equal(new Set(pickA).size, 6);
  assert.notDeepEqual(pickRelays(DEFAULT_NOSTR_RELAYS, 6, b.topic), pickA, 'different invitations spread load');
  assert.ok(a.kind >= 20000 && a.kind < 30000, 'ephemeral event kind');
});

test('a full session pairs over Nostr despite lost and duplicated relay messages', async () => {
  const lossy = await mockRelay({ dropEvery: 3 });
  const dupes = await mockRelay({ duplicate: true });
  const h = tmpIdentity();
  const c = tmpIdentity();
  const code = generateShareCode();
  const relays = [lossy.url, dupes.url];
  try {
    const hostP = hostSession({ code, nostr: true, nostrRelays: relays, identity: h.id.keypair, iceServers: [],
      onConsentRequest: async () => true });
    const clientP = joinSession({ code, nostr: true, nostrRelays: relays, identity: c.id.keypair, iceServers: [] });
    const [host, client] = await Promise.all([hostP, clientP]);
    assert.equal(host.peer.state, PeerState.SECURE);
    assert.equal(client.peer.sas.phrase, host.peer.sas.phrase);
    assert.ok(lossy.stats.dropped > 0, 'the lossy relay really dropped messages');
    host.close();
    client.close();
  } finally {
    h.cleanup();
    c.cleanup();
    await lossy.close();
    await dupes.close();
  }
});

test('an invitation keeps waiting: a viewer joining after 35 s still connects', { timeout: 90_000 }, async () => {
  const rv = await startRendezvous({ port: 0, host: '127.0.0.1' });
  const h = tmpIdentity();
  const c = tmpIdentity();
  const code = generateShareCode();
  try {
    const hostP = hostSession({ code, rendezvousUrl: rv.url, nostr: false, identity: h.id.keypair, iceServers: [],
      onConsentRequest: async () => true, sessionTimeoutMs: 120_000 });
    let hostFailed = null;
    hostP.catch((e) => { hostFailed = e; });
    await new Promise((r) => setTimeout(r, 35_000));    // longer than the old 30 s peer timeout
    assert.equal(hostFailed, null, `host gave up while waiting: ${hostFailed?.message}`);
    const clientP = joinSession({ code, rendezvousUrl: rv.url, nostr: false, identity: c.id.keypair, iceServers: [] });
    const [host, client] = await Promise.all([hostP, clientP]);
    assert.equal(host.peer.state, PeerState.SECURE);
    host.close();
    client.close();
  } finally {
    h.cleanup();
    c.cleanup();
    await rv.close();
  }
});

test('a slow human consent (longer than 30 s) still completes', { timeout: 90_000 }, async () => {
  const rv = await startRendezvous({ port: 0, host: '127.0.0.1' });
  const h = tmpIdentity();
  const c = tmpIdentity();
  const code = generateShareCode();
  try {
    const hostP = hostSession({ code, rendezvousUrl: rv.url, nostr: false, identity: h.id.keypair, iceServers: [],
      onConsentRequest: () => new Promise((r) => setTimeout(() => r(true), 33_000)) });
    const clientP = joinSession({ code, rendezvousUrl: rv.url, nostr: false, identity: c.id.keypair, iceServers: [] });
    const [host, client] = await Promise.all([hostP, clientP]);
    assert.equal(client.peer.state, PeerState.SECURE);
    host.close();
    client.close();
  } finally {
    h.cleanup();
    c.cleanup();
    await rv.close();
  }
});
