import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { TurnServer } from '../../../turn/src/server.mjs';
import {
  Attr, Class, Method, MessageBuilder, parse, longTermKey,
  verifyMessageIntegrity, encodeXorAddress, decodeXorAddress,
} from '../../../turn/src/stun.mjs';

// Synthetic test credentials only; never read deployment environment/secrets.
const users = { alice: 'test-alice-only', bob: 'test-bob-only' };
const realm = 'security-test';
const key = longTermKey('alice', realm, users.alice);
const request = (method = Method.ALLOCATE) => new MessageBuilder(method, Class.REQUEST);
const transport = (b) => b.add(Attr.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0]));
const errorCode = (msg) => {
  const attr = msg?.attrs.get(Attr.ERROR_CODE);
  return attr ? attr[2] * 100 + attr[3] : undefined;
};
function append(packet, type, value) {
  const attr = Buffer.alloc(4 + value.length + (4 - value.length % 4) % 4);
  attr.writeUInt16BE(type, 0);
  attr.writeUInt16BE(value.length, 2);
  value.copy(attr, 4);
  const out = Buffer.concat([packet, attr]);
  out.writeUInt16BE(out.length - 20, 2);
  return out;
}
function receive(socket, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const done = (data) => { clearTimeout(timer); socket.off('message', done); resolve(data); };
    const timer = setTimeout(() => { socket.off('message', done); reject(new Error('test UDP timeout')); }, timeout);
    socket.on('message', done);
  });
}
async function silent(socket, send) {
  let received = false;
  const listener = () => { received = true; };
  socket.on('message', listener);
  try {
    send();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(received, false, 'forbidden packet must not be delivered');
  } finally { socket.off('message', listener); }
}
async function fixture(t, opts = {}) {
  const server = new TurnServer({ realm, users, ...opts });
  t.after(() => server.close());
  await server.listen(0);
  const socket = async () => {
    const sock = dgram.createSocket('udp4');
    t.after(() => { try { sock.close(); } catch { /* closed */ } });
    await new Promise((resolve) => sock.bind(0, '127.0.0.1', resolve));
    return sock;
  };
  const client = await socket();
  const send = (packet, sock = client) => sock.send(packet, server.port, '127.0.0.1');
  const exchange = async (packet, sock = client) => {
    const reply = receive(sock);
    send(packet, sock);
    const msg = parse(await reply);
    assert.ok(msg, 'server response must parse');
    return msg;
  };
  const challenge = await exchange(transport(request()).build());
  assert.equal(errorCode(challenge), 401);
  const nonce = challenge.attrs.get(Attr.NONCE).toString();
  const auth = (b, user = 'alice', n = nonce) => b
    .addString(Attr.USERNAME, user).addString(Attr.REALM, realm).addString(Attr.NONCE, n)
    .build({ integrityKey: longTermKey(user, realm, users[user]), fingerprint: true });
  const allocate = async () => {
    const msg = await exchange(auth(transport(request())));
    assert.equal(msg.cls, Class.SUCCESS);
    return server.allocations.get(`127.0.0.1:${client.address().port}`);
  };
  return { server, client, socket, send, exchange, auth, allocate, nonce };
}

test('MI rejects uncovered attribute injection, including forged parser metadata', () => {
  const packet = request(Method.REFRESH).addString(Attr.USERNAME, 'alice').build({ integrityKey: key });
  assert.ok(verifyMessageIntegrity(parse(packet), key));
  for (const [type, value] of [
    [Attr.LIFETIME, Buffer.alloc(4)],
    [Attr.XOR_PEER_ADDRESS, encodeXorAddress(4, '127.0.0.1', 9, packet.subarray(8, 20))],
    [Attr.USERNAME, Buffer.from('bob')],
    [Attr.NONCE, Buffer.from('injected')],
    [Attr.SOFTWARE, Buffer.from('uncovered')],
  ]) {
    const injected = append(packet, type, value);
    assert.equal(parse(injected), null);
    assert.equal(verifyMessageIntegrity({ ...parse(packet), buffer: injected }, key), false);
  }
  const valid = request().build({ integrityKey: key, fingerprint: true });
  assert.ok(verifyMessageIntegrity(parse(valid), key));
  valid[valid.length - 1] ^= 1;
  assert.equal(parse(valid), null, 'invalid fingerprint is rejected');
});

test('parser rejects duplicate security/scalar attributes and malformed complete datagrams', () => {
  for (const [type, value] of [
    [Attr.USERNAME, Buffer.from('alice')], [Attr.REALM, Buffer.from(realm)],
    [Attr.NONCE, Buffer.from('test-nonce')], [Attr.MESSAGE_INTEGRITY, Buffer.alloc(20)],
    [Attr.FINGERPRINT, Buffer.alloc(4)], [Attr.LIFETIME, Buffer.alloc(4)],
    [Attr.CHANNEL_NUMBER, Buffer.alloc(4)], [Attr.REQUESTED_TRANSPORT, Buffer.alloc(4)],
  ]) assert.equal(parse(request().add(type, value).add(type, value).build()), null);
  for (const type of [Attr.MESSAGE_INTEGRITY, Attr.FINGERPRINT, Attr.LIFETIME, Attr.CHANNEL_NUMBER, Attr.REQUESTED_TRANSPORT]) {
    assert.equal(parse(request().add(type, Buffer.alloc(1)).build()), null);
  }
  const truncated = request().addString(Attr.USERNAME, 'abcd').build();
  truncated.writeUInt16BE(8, 22); // TLV claims bytes absent from the datagram.
  assert.equal(parse(truncated), null);
  const missingPadding = request().addString(Attr.USERNAME, 'a').build().subarray(0, 25);
  missingPadding.writeUInt16BE(5, 2);
  assert.equal(parse(missingPadding), null);
  assert.equal(parse(Buffer.concat([request().build(), Buffer.alloc(4)])), null);
  const peers = request(Method.CREATE_PERMISSION)
    .addXorAddress(Attr.XOR_PEER_ADDRESS, 4, '127.0.0.1', 9)
    .addXorAddress(Attr.XOR_PEER_ADDRESS, 4, '10.0.0.2', 9).build({ integrityKey: key });
  assert.ok(verifyMessageIntegrity(parse(peers), key), 'covered multiple private peers remain valid');
  const unknownFamily = encodeXorAddress(4, '127.0.0.1', 9, Buffer.alloc(12));
  unknownFamily[1] = 3;
  assert.equal(decodeXorAddress(unknownFamily, Buffer.alloc(12)), null);
});

test('valid second user cannot refresh/delete, permit, or bind first user allocation', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const alloc = await f.allocate();
  const expiry = alloc.expiresAt;
  const channel = Buffer.from([0x40, 0x01, 0, 0]);
  for (const b of [
    request(Method.REFRESH).addUInt32(Attr.LIFETIME, 0),
    request(Method.REFRESH).addUInt32(Attr.LIFETIME, 3600),
    request(Method.CREATE_PERMISSION).addXorAddress(Attr.XOR_PEER_ADDRESS, 4, '127.0.0.1', 9),
    request(Method.CHANNEL_BIND).add(Attr.CHANNEL_NUMBER, channel).addXorAddress(Attr.XOR_PEER_ADDRESS, 4, '127.0.0.1', 9),
  ]) assert.equal(errorCode(await f.exchange(f.auth(b, 'bob'))), 441);
  assert.equal(f.server.allocations.size, 1);
  assert.equal(alloc.expiresAt, expiry);
  assert.equal(alloc.permissions.size, 0);
  assert.equal(alloc.channels.size, 0);
  assert.equal((await f.exchange(f.auth(request(Method.REFRESH).addUInt32(Attr.LIFETIME, 20)))).cls, Class.SUCCESS);
});

test('uncovered peer and lifetime injections have no server-side effects', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const alloc = await f.allocate();
  const expiry = alloc.expiresAt;
  // Strip the final fingerprint, then append uncovered attributes and fix length.
  for (const [method, type, value] of [
    [Method.REFRESH, Attr.LIFETIME, Buffer.alloc(4)],
    [Method.CREATE_PERMISSION, Attr.XOR_PEER_ADDRESS, encodeXorAddress(4, '127.0.0.1', 9, Buffer.alloc(12))],
  ]) {
    const signed = f.auth(request(method)).subarray(0, -8);
    await silent(f.client, () => f.send(append(signed, type, value)));
  }
  assert.equal(f.server.allocations.size, 1);
  assert.equal(alloc.expiresAt, expiry);
  assert.equal(alloc.permissions.size, 0);
});

test('ChannelData requires live permission; expired channel falls back to DATA; allocations expire on use', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const alloc = await f.allocate();
  const peer = await f.socket();
  const channel = 0x4001;
  const binding = () => request(Method.CHANNEL_BIND).add(Attr.CHANNEL_NUMBER, Buffer.from([0x40, 1, 0, 0]))
    .addXorAddress(Attr.XOR_PEER_ADDRESS, 4, '127.0.0.1', peer.address().port);
  assert.equal((await f.exchange(f.auth(binding()))).cls, Class.SUCCESS);
  const frame = Buffer.from([0x40, 1, 0, 3, 1, 2, 3]);
  let received = receive(peer);
  f.send(frame);
  assert.deepEqual(await received, frame.subarray(4), 'live private-IP channel works');
  alloc.permissions.set('127.0.0.1', Date.now() - 1);
  await silent(peer, () => f.send(frame));
  await silent(f.client, () => peer.send(Buffer.from('blocked'), alloc.relayPort, '127.0.0.1'));
  assert.equal((await f.exchange(f.auth(binding()))).cls, Class.SUCCESS);
  received = receive(f.client);
  peer.send(Buffer.from('live'), alloc.relayPort, '127.0.0.1');
  assert.equal((await received).readUInt16BE(0), channel);
  alloc.channels.get(channel).expiry = Date.now() - 1;
  received = receive(f.client);
  peer.send(Buffer.from('fallback'), alloc.relayPort, '127.0.0.1');
  assert.equal(parse(await received).method, Method.DATA);
  await silent(peer, () => f.send(frame));
  assert.equal((await f.exchange(f.auth(binding()))).cls, Class.SUCCESS);
  alloc.expiresAt = Date.now() - 1;
  await silent(peer, () => f.send(frame));
  assert.equal(f.server.allocations.size, 0);
  assert.equal(errorCode(await f.exchange(f.auth(request(Method.REFRESH)))), 437);
});

test('nonce flood stays capped and evicted nonce cannot authenticate', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { maxNonces: 3 });
  let latest;
  for (let i = 0; i < 8; i++) {
    latest = await f.exchange(transport(request()).build());
    assert.ok(f.server.nonces.size <= 3);
  }
  assert.equal(errorCode(await f.exchange(f.auth(transport(request())))), 438);
  const nonce = latest.attrs.get(Attr.NONCE).toString();
  assert.equal((await f.exchange(f.auth(transport(request()), 'alice', nonce))).cls, Class.SUCCESS);
});

test('allocation cap includes active allocations and releases deleted capacity', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { maxAllocations: 1 });
  await f.allocate();
  const second = await f.socket();
  assert.equal(errorCode(await f.exchange(f.auth(transport(request())), second)), 486);
  assert.equal(f.server.allocations.size, 1);
  assert.equal((await f.exchange(f.auth(request(Method.REFRESH).addUInt32(Attr.LIFETIME, 0)))).cls, Class.SUCCESS);
  assert.equal((await f.exchange(f.auth(transport(request())), second)).cls, Class.SUCCESS);
});

// Hold the bind callback deterministically; no timing-sensitive UDP burst test.
async function pendingFixture(t) {
  const f = await fixture(t, { maxAllocations: 1 });
  const relays = [];
  t.mock.method(dgram, 'createSocket', () => {
    const relay = new EventEmitter();
    relay.bind = (_port, _addr, cb) => { relay.bound = cb; };
    relay.address = () => ({ port: 40000 });
    relay.close = () => { relay.closed = true; };
    relays.push(relay);
    return relay;
  });
  const inject = (packet, port = f.client.address().port) => f.server.socket.emit('message', packet, { address: '127.0.0.1', port });
  return { ...f, relays, inject };
}

test('pending bind reserves tuple and quota before callback; duplicate cannot leak a socket', { timeout: 5000 }, async (t) => {
  const f = await pendingFixture(t);
  const packet = f.auth(transport(request()));
  f.inject(packet);
  assert.equal(f.server._pendingAllocations.size, 1);
  let response = receive(f.client);
  f.inject(packet);
  assert.equal(errorCode(parse(await response)), 437);
  f.inject(f.auth(transport(request())), f.client.address().port === 65535 ? 65534 : f.client.address().port + 1);
  assert.equal(f.relays.length, 1, 'quota includes pending bind on another tuple');
  response = receive(f.client);
  f.relays[0].bound();
  assert.equal(parse(await response).cls, Class.SUCCESS);
  assert.equal(f.server.allocations.size, 1);
  assert.equal(f.server._pendingAllocations.size, 0);
  f.server.close();
  assert.ok(f.relays[0].closed);
});

test('bind failure releases reservation; shutdown cannot resurrect pending allocations', { timeout: 5000 }, async (t) => {
  const f = await pendingFixture(t);
  f.inject(f.auth(transport(request())));
  const response = receive(f.client);
  f.relays[0].emit('error', new Error('synthetic bind failure'));
  assert.equal(errorCode(parse(await response)), 508);
  assert.ok(f.relays[0].closed);
  assert.equal(f.server._pendingAllocations.size, 0);
  f.inject(f.auth(transport(request())));
  assert.equal(f.relays.length, 2);
  f.server.close();
  f.relays[1].bound();
  assert.ok(f.relays[1].closed);
  assert.equal(f.server.allocations.size, 0);
  assert.equal(f.server._pendingAllocations.size, 0);
});


test('malformed Allocate length cannot reach async bind; covered private peers still work', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const malformed = f.auth(transport(request()).add(Attr.LIFETIME, Buffer.alloc(1)));
  await silent(f.client, () => f.send(malformed));
  assert.equal(f.server.allocations.size, 0);
  assert.equal(f.server._pendingAllocations.size, 0);
  const alloc = await f.allocate();
  const permitted = request(Method.CREATE_PERMISSION)
    .addXorAddress(Attr.XOR_PEER_ADDRESS, 4, '127.0.0.1', 9)
    .addXorAddress(Attr.XOR_PEER_ADDRESS, 4, '10.0.0.2', 9);
  assert.equal((await f.exchange(f.auth(permitted))).cls, Class.SUCCESS);
  assert.ok(alloc.hasPermission('127.0.0.1'));
  assert.ok(alloc.hasPermission('10.0.0.2'));
  const invalid = request(Method.CREATE_PERMISSION)
    .addXorAddress(Attr.XOR_PEER_ADDRESS, 4, '10.0.0.3', 9)
    .add(Attr.XOR_PEER_ADDRESS, Buffer.alloc(8));
  assert.equal(errorCode(await f.exchange(f.auth(invalid))), 400);
  assert.equal(alloc.hasPermission('10.0.0.3'), false, 'invalid peer list must not partially mutate permissions');
});
