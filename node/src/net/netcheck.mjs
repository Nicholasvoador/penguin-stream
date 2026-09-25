/**
 * "Will a direct connection work from here?" - answered by measurement.
 *
 *   - NAT mapping: one UDP socket asks two STUN servers for its public
 *     address. Same public port both times = endpoint-independent mapping, so
 *     hole punching works even behind CGNAT. Different ports = symmetric NAT:
 *     direct only works if the other side is more open, otherwise a relay.
 *   - IPv6: a global v6 path skips NAT (and CGNAT) entirely.
 *   - Relay: performs a real TURN Allocate with the saved credentials, then
 *     releases it, so "relay configured" means "relay proven", not "typed in".
 */

import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import os from 'node:os';

import { MessageBuilder, Method, Class, Attr, parse, decodeXorAddress, longTermKey } from '../../../turn/src/stun.mjs';
import { resolveRelay, describeRelay } from './relay.mjs';

const STUN_A = { host: 'stun.l.google.com', port: 19302 };
const STUN_B = { host: 'stun.cloudflare.com', port: 3478 };
const TIMEOUT_MS = 2500;

function isPrivateV4(ip) {
  return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
}

/** Sends a STUN request and resolves with the parsed reply (or null on timeout). */
function transact(socket, buf, host, port, txId, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = performance.now();
    let tries = 0;
    let timer;
    const onMsg = (msg) => {
      const m = parse(msg);
      if (!m || !m.transactionId.equals(txId)) return;
      clearTimeout(timer);
      socket.off('message', onMsg);
      resolve({ msg: m, rttMs: performance.now() - started });
    };
    socket.on('message', onMsg);
    const send = () => {
      if (tries++ >= 3) { socket.off('message', onMsg); resolve(null); return; }
      socket.send(buf, port, host, () => {});
      timer = setTimeout(send, timeoutMs / 3);
    };
    send();
  });
}

async function binding(socket, server, family) {
  let address;
  try {
    ({ address } = await dns.lookup(server.host, { family }));
  } catch {
    return null;
  }
  const b = new MessageBuilder(Method.BINDING, Class.REQUEST);
  const r = await transact(socket, b.build(), address, server.port, b.transactionId);
  if (!r || r.msg.cls !== Class.SUCCESS) return null;
  const x = r.msg.attrs.get(Attr.XOR_MAPPED_ADDRESS);
  const mapped = x && decodeXorAddress(x, r.msg.transactionId);
  return mapped ? { ...mapped, rttMs: r.rttMs } : null;
}

function openSocket(type) {
  return new Promise((resolve) => {
    const s = dgram.createSocket(type);
    s.once('error', () => resolve(null));
    s.bind(0, () => resolve(s));
  });
}

async function checkV4() {
  const socket = await openSocket('udp4');
  if (!socket) return { ok: false };
  try {
    const a = await binding(socket, STUN_A, 4);
    const b = await binding(socket, STUN_B, 4);
    if (!a && !b) return { ok: false };
    const first = a || b;
    const mapping = a && b ? (a.port === b.port ? 'endpoint-independent' : 'symmetric') : 'unknown';
    const local = Object.values(os.networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    return {
      ok: true,
      publicAddress: first.address,
      mapping,
      natted: !local.includes(first.address),
      localPrivate: local.some(isPrivateV4),
      rttMs: Math.round(Math.min(a?.rttMs ?? Infinity, b?.rttMs ?? Infinity)),
    };
  } finally {
    socket.close();
  }
}

async function checkV6() {
  const socket = await openSocket('udp6');
  if (!socket) return { ok: false };
  try {
    const a = await binding(socket, STUN_A, 6);
    return a ? { ok: true, publicAddress: a.address, rttMs: Math.round(a.rttMs) } : { ok: false };
  } finally {
    socket.close();
  }
}

/** Allocates on the first UDP TURN server in the list, then frees it. */
export async function probeTurn(servers) {
  let target;
  for (const s of servers) {
    for (const u of s.urls || []) {
      const m = /^turn:(\[[0-9a-f:.]+\]|[^:?]+)(?::(\d+))?(\?transport=udp)?$/i.exec(u);
      if (m && Number(m[2] || 3478) !== 53) { target = { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2] || 3478), s }; break; }
    }
    if (target) break;
  }
  if (!target) return { ok: false, error: 'no UDP TURN server in the relay list' };

  let address;
  try { ({ address } = await dns.lookup(target.host, { family: 4 })); } catch (e) {
    return { ok: false, error: `cannot resolve ${target.host}` };
  }
  const socket = await openSocket('udp4');
  if (!socket) return { ok: false, error: 'cannot open a UDP socket' };
  const transport = Buffer.from([17, 0, 0, 0]);  // UDP
  try {
    const first = new MessageBuilder(Method.ALLOCATE, Class.REQUEST).add(Attr.REQUESTED_TRANSPORT, transport);
    const r1 = await transact(socket, first.build(), address, target.port, first.transactionId);
    if (!r1) return { ok: false, error: `no answer from ${target.host}:${target.port} (UDP blocked?)` };
    const realm = r1.msg.attrs.get(Attr.REALM)?.toString('utf8');
    const nonce = r1.msg.attrs.get(Attr.NONCE);
    if (!realm || !nonce) return { ok: false, error: 'relay did not ask for credentials' };
    const key = longTermKey(target.s.username || '', realm, target.s.credential || '');
    const auth = new MessageBuilder(Method.ALLOCATE, Class.REQUEST)
      .add(Attr.REQUESTED_TRANSPORT, transport)
      .addString(Attr.USERNAME, target.s.username || '')
      .addString(Attr.REALM, realm)
      .add(Attr.NONCE, nonce);
    const r2 = await transact(socket, auth.build({ integrityKey: key }), address, target.port, auth.transactionId);
    if (!r2) return { ok: false, error: 'relay stopped answering during login' };
    if (r2.msg.cls !== Class.SUCCESS) {
      const ec = r2.msg.attrs.get(Attr.ERROR_CODE);
      const code = ec ? ec[2] * 100 + ec[3] : 0;
      return { ok: false, error: code === 401 ? 'relay rejected the username/password' : `relay error ${code || 'unknown'}` };
    }
    const x = r2.msg.attrs.get(Attr.XOR_RELAYED_ADDRESS);
    const relayed = x && decodeXorAddress(x, r2.msg.transactionId);
    // Free the allocation right away (LIFETIME 0).
    const free = new MessageBuilder(Method.REFRESH, Class.REQUEST)
      .addUInt32(Attr.LIFETIME, 0)
      .addString(Attr.USERNAME, target.s.username || '')
      .addString(Attr.REALM, realm)
      .add(Attr.NONCE, nonce);
    socket.send(free.build({ integrityKey: key }), target.port, address, () => {});
    await new Promise((r) => setTimeout(r, 150));
    return { ok: true, server: `${target.host}:${target.port}`, relayedAddress: relayed?.address, rttMs: Math.round(r2.rttMs) };
  } finally {
    socket.close();
  }
}

/**
 * @param {object} relay saved relay settings
 * @returns {Promise<{v4, v6, relay, verdict:{level:'good'|'ok'|'bad', text:string}}>}
 */
export async function runNetcheck(relay = { mode: 'none' }) {
  const [v4, v6] = await Promise.all([checkV4(), checkV6()]);
  let relayResult = { configured: false };
  if (relay?.mode && relay.mode !== 'none') {
    try {
      const servers = await resolveRelay(relay);
      relayResult = { configured: true, name: describeRelay(relay), ...(await probeTurn(servers)) };
    } catch (err) {
      relayResult = { configured: true, name: describeRelay(relay), ok: false, error: err.message };
    }
  }

  let verdict;
  if (!v4.ok && !v6.ok) {
    verdict = { level: 'bad', text: 'No UDP Internet access detected. Only same-network connections can work.' };
  } else if (relayResult.ok) {
    verdict = { level: 'good', text: 'Ready for anyone, anywhere: direct when possible, your relay when not.' };
  } else if (v4.mapping === 'endpoint-independent' || !v4.natted) {
    verdict = { level: 'good', text: 'Direct connections should work, even behind CGNAT. ' +
      'A relay is only needed if the other side is on a strict (symmetric) NAT.' };
  } else if (v6.ok) {
    verdict = { level: 'ok', text: 'Your IPv4 NAT is strict, but IPv6 works: direct connections succeed with ' +
      'IPv6 peers. Add a relay to reach everyone.' };
  } else {
    verdict = { level: 'bad', text: 'Strict (symmetric) NAT and no IPv6: direct connections will often fail. ' +
      'Set up a relay in Settings (free Cloudflare TURN works well).' };
  }
  if (relayResult.configured && !relayResult.ok) {
    verdict = { level: verdict.level === 'good' ? 'ok' : verdict.level,
      text: `${verdict.text} Your relay did not work: ${relayResult.error}.` };
  }
  return { v4, v6, relay: relayResult, verdict };
}
