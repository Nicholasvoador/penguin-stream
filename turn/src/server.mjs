/**
 * Minimal TURN relay (RFC 5766), UDP only, long-term credentials.
 *
 * Purpose: make the CGNAT relay path testable without depending on coturn or
 * any third-party service. It implements exactly what an ICE agent needs:
 *
 *   Allocate (401 challenge -> authenticated retry), Refresh, CreatePermission,
 *   ChannelBind, Send/Data indications, and ChannelData framing.
 *
 * Not implemented: TCP/TLS transports, EVEN-PORT, RESERVATION-TOKEN, per-user quotas,
 * bandwidth accounting. It is a test and self-hosting relay, not a public one.
 * See LIMITATIONS.md before pointing anything untrusted at it.
 */

import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import {
  Method, Class, Attr, MessageBuilder, parse, isChannelData, isStun,
  decodeXorAddress, longTermKey, verifyMessageIntegrity,
} from './stun.mjs';

const DEFAULT_LIFETIME = 600;
const MAX_LIFETIME = 3600;
const NONCE_LIFETIME_MS = 10 * 60 * 1000;
const PERMISSION_LIFETIME_MS = 5 * 60 * 1000;
const CHANNEL_LIFETIME_MS = 10 * 60 * 1000;
const SOFTWARE = 'penguin-stream-turn/0.1';

const key5 = (addr, port) => `${addr}:${port}`;

function listLocalIPv4() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/** Longest-common-prefix match, so a client is handed the relay IP it can route to. */
export function pickRelayAddress(clientAddress, localAddresses, fallback) {
  if (!localAddresses.length) return fallback;
  const toInt = (ip) => ip.split('.').reduce((n, o) => (n << 8) + (parseInt(o, 10) & 255), 0) >>> 0;
  let best = fallback;
  let bestBits = -1;
  const c = toInt(clientAddress);
  for (const local of localAddresses) {
    const shared = 31 - Math.floor(Math.log2((c ^ toInt(local)) >>> 0 || 1));
    const bits = (c ^ toInt(local)) === 0 ? 32 : shared;
    if (bits > bestBits) { bestBits = bits; best = local; }
  }
  // Require at least a /8-ish overlap before trusting the match.
  return bestBits >= 8 ? best : fallback;
}

class Allocation {
  constructor({ socket, username, clientAddr, clientPort, clientFamily }) {
    this.socket = socket;
    this.username = username;
    this.clientAddr = clientAddr;
    this.clientPort = clientPort;
    this.clientFamily = clientFamily;
    this.permissions = new Map(); // ip -> expiry ms
    this.channels = new Map();    // channel number -> { addr, port, expiry }
    this.byPeer = new Map();      // "addr:port" -> channel number
    this.expiresAt = Date.now() + DEFAULT_LIFETIME * 1000;
    this.bytesRelayed = 0;
    this.packetsRelayed = 0;
  }

  get relayPort() { return this.socket.address().port; }

  hasPermission(ip) {
    const exp = this.permissions.get(ip);
    return exp !== undefined && exp > Date.now();
  }

  addPermission(ip) {
    this.permissions.set(ip, Date.now() + PERMISSION_LIFETIME_MS);
  }

  close() {
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

export class TurnServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.realm
   * @param {Record<string,string>} opts.users username -> password
   * @param {string} [opts.relayAddress] address advertised in XOR-RELAYED-ADDRESS
   * @param {number} [opts.maxNonces=1024] global challenge cache cap (FIFO eviction)
   * @param {number} [opts.maxAllocations=128] global active plus pending relay cap
   */
  constructor({ realm = 'penguin-stream', users = {}, relayAddress = '127.0.0.1', listenAddress = '127.0.0.1', multiHomed = false, maxNonces = 1024, maxAllocations = 128 } = {}) {
    super();
    for (const limit of [maxNonces, maxAllocations]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('TURN limits must be positive safe integers');
    }
    this.maxNonces = maxNonces;
    this.maxAllocations = maxAllocations;
    this._pendingAllocations = new Map(); // client tuple -> binding relay socket
    this._closed = false;
    this.realm = realm;
    this.users = users;
    this.relayAddress = relayAddress;
    this.listenAddress = listenAddress;
    // When the relay is multi-homed (our isolated-network test topology, and
    // any real dual-stack deployment), a single advertised address is wrong:
    // each client must be told the address on *its own* side of the relay.
    this.multiHomed = multiHomed;
    this._localAddresses = multiHomed ? listLocalIPv4() : [];
    this.allocations = new Map();  // "clientIp:clientPort" -> Allocation
    this.nonces = new Map();       // nonce -> expiry
    this.socket = null;
    this.stats = {
      allocations: 0, permissions: 0, channelBinds: 0,
      relayedToPeer: 0, relayedToClient: 0, bytesRelayed: 0, authFailures: 0,
    };
    this._sweep = setInterval(() => this.#sweep(), 30_000);
    this._sweep.unref?.();
  }

  async listen(port = 3478) {
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('message', (msg, rinfo) => this.#onClientMessage(msg, rinfo));
    this.socket.on('error', (err) => this.emit('error', err));
    await new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(port, this.listenAddress, resolve);
    });
    this.port = this.socket.address().port;
    this.emit('listening', this.port);
    return this.port;
  }

  /** Config block ready to hand to Peer({ iceServers }). */
  iceServerConfig(username) {
    const password = Object.hasOwn(this.users, username) ? this.users[username] : undefined;
    if (!password) throw new Error(`no such TURN user: ${username}`);
    return {
      hostname: this.relayAddress,
      port: this.port,
      username,
      password,
      relayType: 'TurnUdp',
    };
  }

  close() {
    this._closed = true;
    clearInterval(this._sweep);
    for (const relay of this._pendingAllocations.values()) {
      try { relay.close(); } catch { /* not bound */ }
    }
    this._pendingAllocations.clear();
    for (const a of this.allocations.values()) a.close();
    this.allocations.clear();
    this.nonces.clear();
    try { this.socket?.close(); } catch { /* already closed */ }
  }

  /** Address advertised in XOR-RELAYED-ADDRESS for a given client. */
  #relayAddressFor(clientAddress) {
    if (!this.multiHomed) return this.relayAddress;
    return pickRelayAddress(clientAddress, this._localAddresses, this.relayAddress);
  }

  #sweep() {
    const now = Date.now();
    for (const [k, a] of this.allocations) {
      if (a.expiresAt <= now) { a.close(); this.allocations.delete(k); continue; }
      for (const [ip, exp] of a.permissions) if (exp <= now) a.permissions.delete(ip);
      for (const [channel, binding] of a.channels) {
        if (binding.expiry <= now) {
          a.channels.delete(channel);
          a.byPeer.delete(key5(binding.addr, binding.port));
        }
      }
    }
    for (const [n, exp] of this.nonces) if (exp <= now) this.nonces.delete(n);
  }

  #newNonce() {
    // Bound unauthenticated challenge state. Evicted nonces get a fresh 438.
    while (this.nonces.size >= this.maxNonces) this.nonces.delete(this.nonces.keys().next().value);
    const nonce = crypto.randomBytes(16).toString('hex');
    this.nonces.set(nonce, Date.now() + NONCE_LIFETIME_MS);
    return nonce;
  }

  #send(buf, rinfo) {
    if (this._closed) return;
    this.socket.send(buf, rinfo.port, rinfo.address);
  }

  #liveAllocation(id) {
    const alloc = this.allocations.get(id);
    if (alloc && alloc.expiresAt <= Date.now()) {
      alloc.close();
      this.allocations.delete(id);
      return undefined;
    }
    return alloc;
  }

  #sendError(msg, rinfo, code, reason, extra = () => {}) {
    const b = new MessageBuilder(msg.method, Class.ERROR, msg.transactionId)
      .addString(Attr.SOFTWARE, SOFTWARE)
      .addErrorCode(code, reason);
    extra(b);
    this.#send(b.build(), rinfo);
  }

  /**
   * Long-term credential check (RFC 5389 §10.2). Returns the integrity key on
   * success, or null after having already sent the appropriate challenge/error.
   */
  #authenticate(msg, rinfo) {
    const username = msg.attrs.get(Attr.USERNAME)?.toString('utf8');
    const realm = msg.attrs.get(Attr.REALM)?.toString('utf8');
    const nonce = msg.attrs.get(Attr.NONCE)?.toString('utf8');
    const hasMI = msg.attrs.has(Attr.MESSAGE_INTEGRITY);

    if (!hasMI || !username || !realm || !nonce) {
      this.#sendError(msg, rinfo, 401, 'Unauthorized', (b) => {
        b.addString(Attr.REALM, this.realm).addString(Attr.NONCE, this.#newNonce());
      });
      return null;
    }

    const nonceExp = this.nonces.get(nonce);
    if (!nonceExp || nonceExp <= Date.now()) {
      this.#sendError(msg, rinfo, 438, 'Stale Nonce', (b) => {
        b.addString(Attr.REALM, this.realm).addString(Attr.NONCE, this.#newNonce());
      });
      return null;
    }

    const password = Object.hasOwn(this.users, username) ? this.users[username] : undefined;
    if (!password || realm !== this.realm) {
      this.stats.authFailures++;
      this.#sendError(msg, rinfo, 401, 'Unauthorized', (b) => {
        b.addString(Attr.REALM, this.realm).addString(Attr.NONCE, this.#newNonce());
      });
      return null;
    }

    const key = longTermKey(username, this.realm, password);
    if (!verifyMessageIntegrity(msg, key)) {
      this.stats.authFailures++;
      this.#sendError(msg, rinfo, 401, 'Unauthorized', (b) => {
        b.addString(Attr.REALM, this.realm).addString(Attr.NONCE, this.#newNonce());
      });
      return null;
    }

    return { key, username };
  }

  #onClientMessage(msg, rinfo) {
    if (this._closed) return;
    try {
      if (isChannelData(msg)) return this.#onChannelData(msg, rinfo);
      if (!isStun(msg)) return;
      const parsed = parse(msg);
      if (!parsed) return;

      if (parsed.cls === Class.REQUEST) {
        switch (parsed.method) {
          case Method.BINDING: return this.#onBinding(parsed, rinfo);
          case Method.ALLOCATE: return this.#onAllocate(parsed, rinfo);
          case Method.REFRESH: return this.#onRefresh(parsed, rinfo);
          case Method.CREATE_PERMISSION: return this.#onCreatePermission(parsed, rinfo);
          case Method.CHANNEL_BIND: return this.#onChannelBind(parsed, rinfo);
          default:
            return this.#sendError(parsed, rinfo, 400, 'Bad Request');
        }
      }

      if (parsed.cls === Class.INDICATION && parsed.method === Method.SEND) {
        return this.#onSendIndication(parsed, rinfo);
      }
    } catch (err) {
      this.emit('warning', `error handling packet from ${rinfo.address}:${rinfo.port}: ${err.message}`);
    }
  }

  /** Plain STUN binding, so the same socket doubles as a STUN server. */
  #onBinding(msg, rinfo) {
    const b = new MessageBuilder(Method.BINDING, Class.SUCCESS, msg.transactionId)
      .addString(Attr.SOFTWARE, SOFTWARE)
      .addXorAddress(Attr.XOR_MAPPED_ADDRESS, 4, rinfo.address, rinfo.port);
    this.#send(b.build({ fingerprint: true }), rinfo);
  }

  #onAllocate(msg, rinfo) {
    const auth = this.#authenticate(msg, rinfo);
    if (!auth) return;

    const id = key5(rinfo.address, rinfo.port);
    const existing = this.#liveAllocation(id);
    if (existing || this._pendingAllocations.has(id)) {
      // RFC 5766 §6.2: a retransmitted Allocate must not create a second
      // allocation. Different transaction => 437.
      return this.#sendError(msg, rinfo, 437, 'Allocation Mismatch');
    }

    const transport = msg.attrs.get(Attr.REQUESTED_TRANSPORT);
    if (!transport || transport.readUInt8(0) !== 17) {
      return this.#sendError(msg, rinfo, 442, 'Unsupported Transport Protocol');
    }

    this.#sweep();
    if (this.allocations.size + this._pendingAllocations.size >= this.maxAllocations) {
      return this.#sendError(msg, rinfo, 486, 'Allocation Quota Reached');
    }
    const lifetime = Math.min(
      msg.attrs.get(Attr.LIFETIME)?.readUInt32BE(0) ?? DEFAULT_LIFETIME,
      MAX_LIFETIME,
    );
    const relay = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    // Reserve before async bind so duplicate packets cannot leak relay sockets.
    this._pendingAllocations.set(id, relay);
    const failed = () => {
      if (this._pendingAllocations.get(id) !== relay) return;
      this._pendingAllocations.delete(id);
      try { relay.close(); } catch { /* not bound */ }
      this.#sendError(msg, rinfo, 508, 'Insufficient Capacity');
    };
    relay.on('error', failed);
    const bound = () => {
      if (this._closed || this._pendingAllocations.get(id) !== relay) {
        try { relay.close(); } catch { /* already closed */ }
        return;
      }
      this._pendingAllocations.delete(id);
      const alloc = new Allocation({
        socket: relay,
        username: auth.username,
        clientAddr: rinfo.address,
        clientPort: rinfo.port,
        clientFamily: 4,
      });
      this.allocations.set(id, alloc);
      this.stats.allocations++;

      relay.on('message', (data, peer) => this.#onPeerMessage(alloc, data, peer));

      alloc.expiresAt = Date.now() + lifetime * 1000;

      const b = new MessageBuilder(Method.ALLOCATE, Class.SUCCESS, msg.transactionId)
        .addString(Attr.SOFTWARE, SOFTWARE)
        .addXorAddress(Attr.XOR_RELAYED_ADDRESS, 4, this.#relayAddressFor(rinfo.address), alloc.relayPort)
        .addXorAddress(Attr.XOR_MAPPED_ADDRESS, 4, rinfo.address, rinfo.port)
        .addUInt32(Attr.LIFETIME, lifetime);
      this.#send(b.build({ integrityKey: auth.key }), rinfo);
      this.emit('allocation', { username: auth.username, relayPort: alloc.relayPort });
    };
    try { relay.bind(0, this.listenAddress, bound); } catch { failed(); }
  }

  #onRefresh(msg, rinfo) {
    const auth = this.#authenticate(msg, rinfo);
    if (!auth) return;
    const alloc = this.#liveAllocation(key5(rinfo.address, rinfo.port));
    if (!alloc) return this.#sendError(msg, rinfo, 437, 'Allocation Mismatch');
    if (alloc.username !== auth.username) return this.#sendError(msg, rinfo, 441, 'Wrong Credentials');

    const requested = msg.attrs.get(Attr.LIFETIME)?.readUInt32BE(0) ?? DEFAULT_LIFETIME;
    const lifetime = Math.min(requested, MAX_LIFETIME);

    if (lifetime === 0) {
      alloc.close();
      this.allocations.delete(key5(rinfo.address, rinfo.port));
    } else {
      alloc.expiresAt = Date.now() + lifetime * 1000;
    }

    const b = new MessageBuilder(Method.REFRESH, Class.SUCCESS, msg.transactionId)
      .addUInt32(Attr.LIFETIME, lifetime);
    this.#send(b.build({ integrityKey: auth.key }), rinfo);
  }

  #onCreatePermission(msg, rinfo) {
    const auth = this.#authenticate(msg, rinfo);
    if (!auth) return;
    const alloc = this.#liveAllocation(key5(rinfo.address, rinfo.port));
    if (!alloc) return this.#sendError(msg, rinfo, 437, 'Allocation Mismatch');
    if (alloc.username !== auth.username) return this.#sendError(msg, rinfo, 441, 'Wrong Credentials');

    // A request may carry several XOR-PEER-ADDRESS attributes.
    const peers = msg.raw.filter((a) => a.type === Attr.XOR_PEER_ADDRESS);
    if (peers.length === 0) return this.#sendError(msg, rinfo, 400, 'Bad Request');

    const addresses = peers.map((p) => decodeXorAddress(p.value, msg.transactionId));
    if (addresses.some((addr) => !addr || addr.family !== 4)) return this.#sendError(msg, rinfo, 400, 'Bad Request');
    for (const addr of addresses) { alloc.addPermission(addr.address); this.stats.permissions++; }

    const b = new MessageBuilder(Method.CREATE_PERMISSION, Class.SUCCESS, msg.transactionId);
    this.#send(b.build({ integrityKey: auth.key }), rinfo);
  }

  #onChannelBind(msg, rinfo) {
    const auth = this.#authenticate(msg, rinfo);
    if (!auth) return;
    const alloc = this.#liveAllocation(key5(rinfo.address, rinfo.port));
    if (!alloc) return this.#sendError(msg, rinfo, 437, 'Allocation Mismatch');
    if (alloc.username !== auth.username) return this.#sendError(msg, rinfo, 441, 'Wrong Credentials');

    const chAttr = msg.attrs.get(Attr.CHANNEL_NUMBER);
    const peerAttr = msg.attrs.get(Attr.XOR_PEER_ADDRESS);
    if (!chAttr || !peerAttr) return this.#sendError(msg, rinfo, 400, 'Bad Request');

    const channel = chAttr.readUInt16BE(0);
    if (channel < 0x4000 || channel > 0x7ffe) {
      return this.#sendError(msg, rinfo, 400, 'Bad Request');
    }
    const peer = decodeXorAddress(peerAttr, msg.transactionId);
    if (!peer || peer.family !== 4 || peer.port === 0) return this.#sendError(msg, rinfo, 400, 'Bad Request');

    this.#sweep();
    const peerKey = key5(peer.address, peer.port);
    const boundTo = alloc.channels.get(channel);
    if (boundTo && key5(boundTo.addr, boundTo.port) !== peerKey) {
      return this.#sendError(msg, rinfo, 400, 'Channel already bound to another peer');
    }

    if (alloc.byPeer.has(peerKey) && alloc.byPeer.get(peerKey) !== channel) {
      return this.#sendError(msg, rinfo, 400, 'Peer already bound to another channel');
    }

    alloc.channels.set(channel, { addr: peer.address, port: peer.port, expiry: Date.now() + CHANNEL_LIFETIME_MS });
    alloc.byPeer.set(peerKey, channel);
    alloc.addPermission(peer.address); // ChannelBind implies a permission
    this.stats.channelBinds++;

    const b = new MessageBuilder(Method.CHANNEL_BIND, Class.SUCCESS, msg.transactionId);
    this.#send(b.build({ integrityKey: auth.key }), rinfo);
  }

  /** Client -> peer, unbound path. Indications are not authenticated per RFC. */
  #onSendIndication(msg, rinfo) {
    const alloc = this.#liveAllocation(key5(rinfo.address, rinfo.port));
    if (!alloc) return;

    const peerAttr = msg.attrs.get(Attr.XOR_PEER_ADDRESS);
    const data = msg.attrs.get(Attr.DATA);
    if (!peerAttr || !data) return;

    const peer = decodeXorAddress(peerAttr, msg.transactionId);
    if (!peer || peer.family !== 4 || peer.port === 0) return;
    if (!alloc.hasPermission(peer.address)) return; // silently dropped per RFC

    alloc.socket.send(data, peer.port, peer.address);
    alloc.bytesRelayed += data.length;
    alloc.packetsRelayed++;
    this.stats.relayedToPeer++;
    this.stats.bytesRelayed += data.length;
  }

  /** Client -> peer, channel path. This is what carries the bulk of media. */
  #onChannelData(msg, rinfo) {
    const alloc = this.#liveAllocation(key5(rinfo.address, rinfo.port));
    if (!alloc) return;

    const channel = msg.readUInt16BE(0);
    const length = msg.readUInt16BE(2);
    if (4 + length > msg.length) return;

    const binding = alloc.channels.get(channel);
    if (!binding || binding.expiry <= Date.now() || !alloc.hasPermission(binding.addr)) return;

    const data = msg.subarray(4, 4 + length);
    alloc.socket.send(data, binding.port, binding.addr);
    alloc.bytesRelayed += data.length;
    alloc.packetsRelayed++;
    this.stats.relayedToPeer++;
    this.stats.bytesRelayed += data.length;
  }

  /** Peer -> client. Prefer ChannelData framing when a channel is bound. */
  #onPeerMessage(alloc, data, peer) {
    if (this._closed || this.#liveAllocation(key5(alloc.clientAddr, alloc.clientPort)) !== alloc) return;
    if (!alloc.hasPermission(peer.address)) return;

    const channel = alloc.byPeer.get(key5(peer.address, peer.port));
    const binding = alloc.channels.get(channel);
    this.stats.relayedToClient++;
    this.stats.bytesRelayed += data.length;
    alloc.bytesRelayed += data.length;
    alloc.packetsRelayed++;

    if (binding && binding.expiry > Date.now()) {
      const pad = (4 - (data.length % 4)) % 4;
      const frame = Buffer.alloc(4 + data.length + pad);
      frame.writeUInt16BE(channel, 0);
      frame.writeUInt16BE(data.length, 2);
      data.copy(frame, 4);
      this.socket.send(frame, alloc.clientPort, alloc.clientAddr);
      return;
    }

    const b = new MessageBuilder(Method.DATA, Class.INDICATION)
      .addXorAddress(Attr.XOR_PEER_ADDRESS, 4, peer.address, peer.port)
      .add(Attr.DATA, data);
    this.socket.send(b.build(), alloc.clientPort, alloc.clientAddr);
  }
}

/** Convenience for tests and the CLI. */
export async function startTurnServer({ port = 3478, realm = 'penguin-stream', users, relayAddress = '127.0.0.1', listenAddress = '127.0.0.1', multiHomed = false } = {}) {
  const resolved = users || { penguin: crypto.randomBytes(18).toString('base64url') };
  const server = new TurnServer({ realm, users: resolved, relayAddress, listenAddress, multiHomed });
  const boundPort = await server.listen(port);
  return { server, port: boundPort, users: resolved };
}

// Direct execution: `node turn/src/server.mjs [port]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 3478);
  const username = process.env.TURN_USER || 'penguin';
  const password = process.env.TURN_PASSWORD || crypto.randomBytes(18).toString('base64url');
  const generated = !process.env.TURN_PASSWORD;
  const { server } = await startTurnServer({
    port,
    users: { [username]: password },
    relayAddress: process.env.TURN_RELAY_ADDRESS || '127.0.0.1',
    listenAddress: process.env.TURN_LISTEN_ADDRESS || '127.0.0.1',
    multiHomed: process.env.TURN_MULTIHOMED === '1',
  });
  console.log(`TURN listening on ${server.listenAddress}:${server.port} realm=${server.realm} user=${username}`);
  if (generated) console.log(`generated password: ${password}  (set TURN_PASSWORD to pin it)`);
  server.on('allocation', (a) => console.log(`allocation for ${a.username} -> relay port ${a.relayPort}`));
  setInterval(() => {
    const s = server.stats;
    console.log(`[turn] allocs=${s.allocations} chan=${s.channelBinds} ->peer=${s.relayedToPeer} ->client=${s.relayedToClient} bytes=${s.bytesRelayed}`);
  }, 10_000).unref?.();
}
