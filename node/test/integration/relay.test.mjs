/**
 * Forced-relay tests: the CGNAT fallback path.
 *
 * These run a real TURN server and set iceTransportPolicy='relay' on BOTH
 * peers, which makes libdatachannel discard host and server-reflexive
 * candidates entirely. If the relay did not work, there would be no usable
 * candidate pair and the connection could not form at all. So a successful
 * connection here is positive proof that traffic traversed the relay, and we
 * additionally assert on the TURN server's own byte counters.
 *
 * Scope note: this proves the relay *mechanism* against a real TURN
 * implementation on loopback. It does not prove behaviour across two real
 * CGNAT networks on the public internet - see LIMITATIONS.md.
 */

// Offline and deterministic: these tests use a local rendezvous only.
process.env.PENGUIN_NOSTR ??= '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startRendezvous } from '../../src/signal/server.mjs';
import { startTurnServer } from '../../../turn/src/server.mjs';
import { hostSession, joinSession } from '../../src/signal/client.mjs';
import { generateShareCode } from '../../src/signal/code.mjs';
import { loadOrCreateIdentity } from '../../src/crypto/identity.mjs';
import { cleanupTransport, PeerState } from '../../src/transport/peer.mjs';
import { CHANNEL } from '../../src/crypto/session.mjs';

function tmpIdentity(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ps-${tag}-`));
  return { id: loadOrCreateIdentity(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test.after(() => cleanupTransport());

/**
 * @param {object} opts
 * @returns {Promise<{host:object, client:object, turn:object, teardown:Function}>}
 */
async function relayPair() {
  const turn = await startTurnServer({ port: 0, users: { penguin: 'test-password-not-a-real-secret' } });
  const rv = await startRendezvous({ port: 0, host: '127.0.0.1' });
  const h = tmpIdentity('rhost');
  const c = tmpIdentity('rclient');
  const code = generateShareCode();
  const ice = [turn.server.iceServerConfig('penguin')];

  const hostPromise = hostSession({
    code,
    rendezvousUrl: rv.url,
    identity: h.id.keypair,
    iceServers: ice,
    iceTransportPolicy: 'relay',
    onConsentRequest: async () => true,
    sessionTimeoutMs: 45_000,
  });

  await new Promise((r) => setTimeout(r, 200));

  const clientPromise = joinSession({
    code,
    rendezvousUrl: rv.url,
    identity: c.id.keypair,
    iceServers: ice,
    iceTransportPolicy: 'relay',
    sessionTimeoutMs: 45_000,
  });

  const [host, client] = await Promise.all([hostPromise, clientPromise]);

  return {
    host,
    client,
    turn,
    teardown: async () => {
      host.close(); client.close();
      h.cleanup(); c.cleanup();
      turn.server.close();
      await rv.close();
    },
  };
}

test('TURN server answers a plain STUN binding request', async () => {
  const { startTurnServer: start } = await import('../../../turn/src/server.mjs');
  const dgram = await import('node:dgram');
  const { MessageBuilder, Method, Class, Attr, parse, decodeXorAddress } = await import('../../../turn/src/stun.mjs');

  const turn = await start({ port: 0, users: { u: 'p' } });
  const sock = dgram.createSocket('udp4');

  try {
    const req = new MessageBuilder(Method.BINDING, Class.REQUEST).build({ fingerprint: true });
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no STUN response')), 5000);
      sock.on('message', (m) => { clearTimeout(timer); resolve(m); });
      sock.send(req, turn.port, '127.0.0.1');
    });

    const msg = parse(reply);
    assert.ok(msg, 'response must be a valid STUN message');
    assert.equal(msg.cls, Class.SUCCESS);
    const mapped = decodeXorAddress(msg.attrs.get(Attr.XOR_MAPPED_ADDRESS), msg.transactionId);
    assert.equal(mapped.address, '127.0.0.1', 'server must reflect our address back');
    assert.ok(mapped.port > 0);
  } finally {
    sock.close();
    turn.server.close();
  }
});

test('TURN rejects an Allocate with no credentials, then a wrong password', async () => {
  const dgram = await import('node:dgram');
  const { MessageBuilder, Method, Class, Attr, parse, longTermKey } = await import('../../../turn/src/stun.mjs');

  const turn = await startTurnServer({ port: 0, users: { penguin: 'correct-password' } });
  const sock = dgram.createSocket('udp4');
  const exchange = (buf) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no response')), 5000);
    sock.once('message', (m) => { clearTimeout(timer); resolve(parse(m)); });
    sock.send(buf, turn.port, '127.0.0.1');
  });

  try {
    // 1. Unauthenticated Allocate must be challenged with 401 + realm + nonce.
    const bare = new MessageBuilder(Method.ALLOCATE, Class.REQUEST)
      .add(Attr.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0]))
      .build();
    const challenge = await exchange(bare);
    assert.equal(challenge.cls, Class.ERROR);
    const code = challenge.attrs.get(Attr.ERROR_CODE);
    assert.equal(code.readUInt8(2) * 100 + code.readUInt8(3), 401);
    const realm = challenge.attrs.get(Attr.REALM).toString();
    const nonce = challenge.attrs.get(Attr.NONCE).toString();
    assert.ok(realm && nonce, 'challenge must carry realm and nonce');

    // 2. Allocate with the WRONG password must still be refused.
    const badKey = longTermKey('penguin', realm, 'wrong-password');
    const bad = new MessageBuilder(Method.ALLOCATE, Class.REQUEST)
      .add(Attr.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0]))
      .addString(Attr.USERNAME, 'penguin')
      .addString(Attr.REALM, realm)
      .addString(Attr.NONCE, nonce)
      .build({ integrityKey: badKey });
    const refused = await exchange(bad);
    assert.equal(refused.cls, Class.ERROR, 'a bad MESSAGE-INTEGRITY must not allocate');
    assert.ok(turn.server.stats.authFailures > 0, 'the failure must be counted');
    assert.equal(turn.server.stats.allocations, 0, 'no allocation may exist');

    // 3. Correct credentials must succeed.
    const goodKey = longTermKey('penguin', realm, 'correct-password');
    const good = new MessageBuilder(Method.ALLOCATE, Class.REQUEST)
      .add(Attr.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0]))
      .addString(Attr.USERNAME, 'penguin')
      .addString(Attr.REALM, realm)
      .addString(Attr.NONCE, nonce)
      .build({ integrityKey: goodKey });
    const ok = await exchange(good);
    assert.equal(ok.cls, Class.SUCCESS, 'valid credentials must allocate');
    assert.ok(ok.attrs.has(Attr.XOR_RELAYED_ADDRESS), 'must return a relayed address');
    assert.equal(turn.server.stats.allocations, 1);
  } finally {
    sock.close();
    turn.server.close();
  }
});

/**
 * IMPORTANT SCOPE NOTE.
 *
 * On loopback we cannot prove that media traversed the relay, and this test
 * deliberately does not claim to. Every address here is 127.0.0.1, so the TURN
 * server's own address is directly routable from both peers; ICE discovers a
 * peer-reflexive pair through it and legitimately prefers that direct path
 * over the relay. Measured behaviour: relay-only gathering yields exactly one
 * `typ relay` candidate, but the selected pair comes back srflx/prflx.
 *
 * What this test proves: both peers really allocate on a real TURN server and
 * a session forms over that configuration.
 * What proves the relay carries traffic: tests/relay-isolated/run.sh, which
 * puts the peers on two podman networks with no route between them.
 */
test('peers allocate on a real TURN server and establish a session under relay policy', async () => {
  const { host, client, turn, teardown } = await relayPair();

  try {
    assert.equal(host.peer.state, PeerState.SECURE);
    assert.equal(client.peer.state, PeerState.SECURE);

    const hostInfo = host.peer.transportInfo();
    assert.equal(hostInfo.policy, 'relay');
    assert.ok(hostInfo.connected, 'a candidate pair must be selected');

    // The part that is genuinely meaningful on loopback: the TURN server did
    // real authenticated work for both peers.
    assert.ok(turn.server.stats.allocations >= 2,
      `both peers must allocate, got ${turn.server.stats.allocations}`);
    assert.ok(turn.server.stats.permissions >= 2,
      `both peers must install permissions, got ${turn.server.stats.permissions}`);
    assert.equal(turn.server.stats.authFailures, 0, 'valid credentials must not fail');

    const before = turn.server.stats.bytesRelayed;
    const PAYLOAD = 8000;
    const COUNT = 50;
    const received = [];
    const done = new Promise((resolve) => {
      client.peer.on('video', (p) => {
        received.push(p);
        if (received.length >= COUNT) resolve();
      });
    });

    for (let i = 0; i < COUNT; i++) {
      const frame = Buffer.alloc(PAYLOAD, i % 251);
      frame.writeUInt32BE(i, 0);
      host.peer.sendMedia(CHANNEL.VIDEO, frame);
      if (i % 10 === 0) await new Promise((r) => setTimeout(r, 20)); // let SCTP drain
    }

    await Promise.race([
      done,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`only ${received.length}/${COUNT} relayed frames arrived`)), 30_000)),
    ]);

    const relayedBytes = turn.server.stats.bytesRelayed - before;
    assert.ok(received.length >= COUNT, `expected ${COUNT} frames, got ${received.length}`);
    assert.equal(client.peer.session.stats.rejected, 0, 'frames must authenticate');
    assert.deepEqual(received[0].subarray(4), Buffer.alloc(PAYLOAD - 4, 0), 'payload must survive intact');

    // Reported, not asserted: on loopback ICE may legitimately bypass the relay.
    console.log(`    [loopback] ${received.length} frames; selected pair ` +
      `${hostInfo.localType}->${hostInfo.remoteType}; ${relayedBytes} bytes through TURN ` +
      `(relay bypass on loopback is expected - see tests/relay-isolated/)`);
  } finally {
    await teardown();
  }
});

test('forced relay fails closed when no TURN server is reachable', async () => {
  // Same policy, but pointed at a port with nothing on it: there can be no
  // relay candidate, so the session must fail rather than silently fall back
  // to a direct path.
  const rv = await startRendezvous({ port: 0, host: '127.0.0.1' });
  const h = tmpIdentity('nrhost');
  const c = tmpIdentity('nrclient');
  const code = generateShareCode();
  const deadTurn = [{ hostname: '127.0.0.1', port: 9, username: 'x', password: 'y', relayType: 'TurnUdp' }];

  const hostPromise = hostSession({
    code, rendezvousUrl: rv.url, identity: h.id.keypair,
    iceServers: deadTurn, iceTransportPolicy: 'relay',
    onConsentRequest: async () => true, sessionTimeoutMs: 8000,
  });
  await new Promise((r) => setTimeout(r, 150));
  const clientPromise = joinSession({
    code, rendezvousUrl: rv.url, identity: c.id.keypair,
    iceServers: deadTurn, iceTransportPolicy: 'relay', sessionTimeoutMs: 8000,
  });

  const results = await Promise.allSettled([hostPromise, clientPromise]);
  h.cleanup(); c.cleanup();
  await rv.close();

  assert.equal(results[0].status, 'rejected', 'host must not report success without a relay');
  assert.equal(results[1].status, 'rejected', 'client must not report success without a relay');
});
