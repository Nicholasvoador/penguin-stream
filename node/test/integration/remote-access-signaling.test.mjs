/**
 * Remote access at the signaling level, with real peers (ICE/DTLS/SCTP/Noise)
 * over a local mock Nostr relay - no Internet needed.
 *
 *  - an access code pairs and the host learns it is talking to a code holder
 *  - an invitation with the same body never reaches the access listener
 *  - stale signals and replays of a finished session are ignored, so a relay
 *    that recorded traffic cannot keep the listener busy
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

import { hostSession, joinSession } from '../../src/signal/client.mjs';
import { generateAccessCode, codeInfo, signalingKey, sealSignal } from '../../src/signal/code.mjs';
import { nostrTopicFor } from '../../src/signal/nostr.mjs';
import { loadOrCreateIdentity } from '../../src/crypto/identity.mjs';
import { cleanupTransport, PeerState } from '../../src/transport/peer.mjs';

const tmpIdentity = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ra-'));
  return { id: loadOrCreateIdentity(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal NIP-01 relay that also records every event it forwards. */
async function mockRelay() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const subs = new Map();
  const events = [];
  wss.on('connection', (ws) => {
    subs.set(ws, new Map());
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg[0] === 'REQ') subs.get(ws).set(msg[1], msg[2]);
      else if (msg[0] === 'CLOSE') subs.get(ws)?.delete(msg[1]);
      else if (msg[0] === 'EVENT') {
        const ev = msg[1];
        events.push(ev);
        ws.send(JSON.stringify(['OK', ev.id, true, '']));
        for (const [client, map] of subs) {
          for (const [subId, f] of map) {
            if (f.kinds?.includes(ev.kind) && ev.tags.some((t) => t[0] === 'x' && f['#x']?.includes(t[1]))) {
              client.send(JSON.stringify(['EVENT', subId, ev]));
            }
          }
        }
      }
    });
    ws.on('close', () => subs.delete(ws));
  });
  const url = `ws://127.0.0.1:${wss.address().port}`;
  /** Publishes raw events as an outsider would (a replaying relay, a prober). */
  const inject = async (evs) => {
    const ws = new WebSocket(url);
    await new Promise((r) => ws.once('open', r));
    for (const ev of evs) ws.send(JSON.stringify(['EVENT', ev]));
    await wait(100);
    ws.close();
  };
  return { url, events, inject, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) };
}

test.after(() => cleanupTransport());

test('an access code pairs over Nostr and the host is asked only after the handshake', async () => {
  const relay = await mockRelay();
  const h = tmpIdentity();
  const c = tmpIdentity();
  const code = generateAccessCode();
  try {
    let asked = 0;
    const hostP = hostSession({ code, nostr: true, nostrRelays: [relay.url], identity: h.id.keypair, iceServers: [],
      spentPartners: new Set(), onConsentRequest: async (info) => { asked++; assert.ok(info.remoteStatic); return true; } });
    const clientP = joinSession({ code: code.toLowerCase(), nostr: true, nostrRelays: [relay.url], identity: c.id.keypair, iceServers: [] });
    const [host, client] = await Promise.all([hostP, clientP]);
    assert.equal(host.peer.state, PeerState.SECURE);
    assert.equal(client.peer.state, PeerState.SECURE);
    assert.equal(asked, 1);
    assert.equal(host.code, code);
    // Every signal of an access session carries the sender's clock.
    const topic = nostrTopicFor(codeInfo(code).bytes, 'access').topic;
    const ours = relay.events.filter((e) => e.tags.some((t) => t[1] === topic));
    assert.ok(ours.length >= 2);
    host.close();
    client.close();
  } finally {
    h.cleanup(); c.cleanup(); await relay.close();
  }
});

test('the invitation with the same body never reaches an access listener', async () => {
  const relay = await mockRelay();
  const h = tmpIdentity();
  const c = tmpIdentity();
  const code = generateAccessCode();
  const invitation = code.slice(3);
  const ac = new AbortController();
  let asked = 0;
  try {
    const hostP = hostSession({ code, nostr: true, nostrRelays: [relay.url], identity: h.id.keypair, iceServers: [],
      signal: ac.signal, onConsentRequest: async () => { asked++; return true; } });
    hostP.catch(() => {});
    await assert.rejects(joinSession({ code: invitation, nostr: true, nostrRelays: [relay.url], identity: c.id.keypair,
      iceServers: [], sessionTimeoutMs: 4000 }), /host was not found/);
    assert.equal(asked, 0, 'the listener never even saw it');
  } finally {
    ac.abort();
    h.cleanup(); c.cleanup(); await relay.close();
  }
});

test('stale signals and replays of a finished session are ignored by the access listener', async () => {
  const relay = await mockRelay();
  const h = tmpIdentity();
  const c = tmpIdentity();
  const code = generateAccessCode();
  const spent = new Set();
  try {
    // 1. A real session; the relay records its signaling.
    const hostP = hostSession({ code, nostr: true, nostrRelays: [relay.url], identity: h.id.keypair, iceServers: [],
      spentPartners: spent, onConsentRequest: async () => true });
    const clientP = joinSession({ code, nostr: true, nostrRelays: [relay.url], identity: c.id.keypair, iceServers: [] });
    const [host, client] = await Promise.all([hostP, clientP]);
    host.close();
    client.close();
    assert.equal(spent.size, 1, 'the viewer session is remembered');
    const recorded = relay.events.slice();

    // 2. The listener waits again; the relay replays the old viewer's signals.
    const statuses = [];
    const ac = new AbortController();
    const again = hostSession({ code, nostr: true, nostrRelays: [relay.url], identity: h.id.keypair, iceServers: [],
      spentPartners: spent, signal: ac.signal, onStatus: (s) => statuses.push(s), onConsentRequest: async () => true });
    again.catch(() => {});
    await wait(300);
    await relay.inject(recorded);
    await wait(400);
    assert.ok(statuses.includes('signal-replay'), `replay noticed (${[...new Set(statuses)]})`);
    assert.ok(!statuses.includes('peer-joined'), 'and never adopted as a partner');

    // 3. A forged-but-valid signal with an old clock (e.g. recorded long ago) is ignored too.
    const key = signalingKey(code);
    const { topic, kind } = nostrTopicFor(codeInfo(code).bytes, 'access');
    const stale = sealSignal(key, { v: 2, from: 'f'.repeat(16), role: 'client', ts: Date.now() - 30 * 60_000, entries: [] });
    await relay.inject([{ id: 'b'.repeat(64), pubkey: 'c'.repeat(64), created_at: Math.floor(Date.now() / 1000), kind,
      tags: [['x', topic]], content: stale, sig: 'd'.repeat(128) }]);
    await wait(300);
    assert.ok(statuses.includes('signal-stale'), 'old clock rejected');
    assert.ok(!statuses.includes('peer-joined'));
    ac.abort();
  } finally {
    h.cleanup(); c.cleanup(); await relay.close();
  }
});

test('without the anti-replay memory the same replay WOULD be adopted (the check is what protects)', async () => {
  const relay = await mockRelay();
  const h = tmpIdentity();
  const c = tmpIdentity();
  const code = generateAccessCode();
  try {
    const hostP = hostSession({ code, nostr: true, nostrRelays: [relay.url], identity: h.id.keypair, iceServers: [],
      onConsentRequest: async () => true });
    const clientP = joinSession({ code, nostr: true, nostrRelays: [relay.url], identity: c.id.keypair, iceServers: [] });
    const [host, client] = await Promise.all([hostP, clientP]);
    host.close();
    client.close();
    const recorded = relay.events.slice();
    const statuses = [];
    const ac = new AbortController();
    const again = hostSession({ code, nostr: true, nostrRelays: [relay.url], identity: h.id.keypair, iceServers: [],
      signal: ac.signal, onStatus: (s) => statuses.push(s), onConsentRequest: async () => true });
    again.catch(() => {});
    await wait(300);
    await relay.inject(recorded);
    await wait(400);
    assert.ok(statuses.includes('peer-joined'), 'control: a fresh listener with no memory locks onto the replay');
    ac.abort();
  } finally {
    h.cleanup(); c.cleanup(); await relay.close();
  }
});

test('a host stopped while its rendezvous socket is opening does not linger (no zombie listener)', async () => {
  // 1.4.x registered the abort listener only after the socket opened, so a
  // Stop in that window left a host listening forever; it then answered the
  // next viewer with the same invitation and refused it ("declined").
  const { startRendezvous } = await import('../../src/signal/server.mjs');
  const rv = await startRendezvous({ port: 0, host: '127.0.0.1' });
  const h = tmpIdentity();
  const c = tmpIdentity();
  const code = generateAccessCode();
  try {
    let asked = 0;
    const ac = new AbortController();
    const zombie = hostSession({ code, rendezvousUrl: rv.url, nostr: false, identity: h.id.keypair, iceServers: [],
      signal: ac.signal, onConsentRequest: async () => { asked++; return false; } });
    ac.abort();                                  // Stop pressed while the socket is still opening
    await assert.rejects(zombie, /cancelled/);
    await assert.rejects(joinSession({ code, rendezvousUrl: rv.url, nostr: false, identity: c.id.keypair, iceServers: [],
      sessionTimeoutMs: 3000 }), /no such session|host was not found/);
    assert.equal(asked, 0, 'nobody answered the viewer');
  } finally {
    h.cleanup(); c.cleanup(); await rv.close();
  }
});
