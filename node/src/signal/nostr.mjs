/**
 * Serverless signaling over public Nostr relays (the approach Trystero uses).
 *
 * Both peers subscribe to a topic derived from the invitation and publish
 * short-lived ephemeral events (kinds 20000-29999, which relays forward but
 * never store). Several independent relays are used at once, so any single
 * relay being down, slow or rate-limiting does not matter.
 *
 * What a relay operator can see: the topic tag (a one-way hash of the
 * invitation), a throwaway per-session public key, timing, the IP address of
 * each client, and ciphertext. Every payload is sealed by the caller with the
 * invitation-derived ChaCha20-Poly1305 key, and the session itself is then
 * authenticated end to end by Noise + the four-word check, so a relay cannot
 * read, forge or usefully alter anything.
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { schnorr } from '@noble/secp256k1';

// Relays that accept and forward ephemeral events from anonymous keys.
// Candidates came from Trystero's maintained default list
// (github.com/dmotz/trystero) plus large general relays; each one below was
// verified to deliver an ephemeral event end to end on 2026-09-24. Six are
// picked at random per session, so a few going away later is harmless.
// Override with PENGUIN_NOSTR_RELAYS=wss://a,wss://b.
export const DEFAULT_NOSTR_RELAYS = [
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://bucket.coracle.social',
  'wss://strfry.shock.network',
  'wss://relay.sigit.io',
  'wss://nostr.data.haus',
  'wss://nostr-01.yakihonne.com',
  'wss://nostr.sathoarder.com',
  'wss://basspistol.org',
  'wss://nostr-01.uid.ovh',
  'wss://nostr-relay.corb.net',
  'wss://nostr.islandarea.net',
  'wss://relay-can.zombi.cloudrodion.com',
  'wss://relay.snort.social',
  'wss://offchain.pub',
];

const REDUNDANCY = 6;          // relays used per session
const CONNECT_TIMEOUT_MS = 8000;
const MAX_CONTENT = 32 * 1024; // relays commonly cap events around 64 KiB

const toHex = (u8) => Buffer.from(u8).toString('hex');

/** Topic and event kind for an invitation. Unlinkable to the WS room id. */
export function nostrTopicFor(canonicalCodeBytes) {
  const topic = crypto.createHash('sha256')
    .update('penguin-stream nostr topic v1')
    .update(canonicalCodeBytes)
    .digest('hex')
    .slice(0, 40);
  const kind = 20000 + (parseInt(topic.slice(0, 8), 16) % 10000);
  return { topic, kind };
}

export function relayList() {
  const env = process.env.PENGUIN_NOSTR_RELAYS;
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  return DEFAULT_NOSTR_RELAYS;
}

const ANCHORS = 3;  // the first relays of the list are always used

/**
 * Both peers must land on the same relays, so the choice is derived from the
 * topic (never random): the anchor relays plus the remaining ones ranked by
 * hash(topic, url). Different invitations still spread across the list.
 */
export function pickRelays(list, n, topic) {
  const anchors = list.slice(0, Math.min(ANCHORS, n));
  const rank = (url) => crypto.createHash('sha256').update(topic).update('\0').update(url).digest('hex');
  const rest = list.slice(anchors.length).sort((a, b) => (rank(a) < rank(b) ? -1 : 1));
  return [...anchors, ...rest].slice(0, n);
}

/**
 * A broadcast channel: send(text) reaches every other subscriber of the
 * topic; 'data' fires with each distinct payload from someone else.
 *
 * Emits: 'open' (first relay subscribed), 'data' (string), 'relay-error'
 * (url, message), 'closed'.
 */
export class NostrChannel extends EventEmitter {
  constructor({ topic, kind, relays = relayList(), redundancy = REDUNDANCY, WebSocketImpl = WebSocket } = {}) {
    super();
    if (!/^[0-9a-f]{40}$/.test(topic) || !Number.isInteger(kind)) throw new Error('invalid nostr topic');
    this.topic = topic;
    this.kind = kind;
    this.relays = pickRelays(relays, Math.min(redundancy, relays.length), topic);
    this.WebSocketImpl = WebSocketImpl;
    const { secretKey, publicKey } = schnorr.keygen();   // fresh, unlinkable per session
    this.secretKey = secretKey;
    this.pubkey = toHex(publicKey);
    this.subId = crypto.randomBytes(8).toString('hex');
    this.sockets = new Map();   // url -> { ws, open }
    this.attempts = new Map();  // url -> reconnect attempts
    this.seen = new Set();
    this.closed = false;
    this.opened = false;
  }

  start() {
    for (const url of this.relays) this.#connect(url);
    return this;
  }

  get connectedRelays() {
    return [...this.sockets.values()].filter((s) => s.open).length;
  }

  #connect(url) {
    let ws;
    try {
      ws = new this.WebSocketImpl(url, { handshakeTimeout: CONNECT_TIMEOUT_MS });
    } catch (err) {
      this.emit('relay-error', url, err.message);
      return;
    }
    const entry = { ws, open: false };
    this.sockets.set(url, entry);
    const timer = setTimeout(() => { if (!entry.open) ws.terminate?.(); }, CONNECT_TIMEOUT_MS);
    timer.unref?.();

    ws.on('open', () => {
      clearTimeout(timer);
      if (this.closed) { ws.close(); return; }
      entry.open = true;
      this.attempts.set(url, 0);
      // `since` a little in the past tolerates clock skew between machines.
      const since = Math.floor(Date.now() / 1000) - 60;
      ws.send(JSON.stringify(['REQ', this.subId, { kinds: [this.kind], '#x': [this.topic], since }]));
      if (!this.opened) { this.opened = true; this.emit('open'); }
    });
    ws.on('message', (raw) => this.#onMessage(url, raw));
    ws.on('error', (err) => this.emit('relay-error', url, err.message));
    ws.on('close', () => {
      clearTimeout(timer);
      entry.open = false;
      this.sockets.delete(url);
      // Relays drop idle or busy clients; come back a few times with backoff.
      const attempt = (this.attempts.get(url) ?? 0) + 1;
      this.attempts.set(url, attempt);
      if (!this.closed && attempt <= 4) {
        const t = setTimeout(() => { if (!this.closed) this.#connect(url); }, 1500 * attempt);
        t.unref?.();
      }
    });
  }

  #onMessage(url, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (!Array.isArray(msg)) return;
    if (msg[0] === 'EVENT' && msg[1] === this.subId) {
      const ev = msg[2];
      if (!ev || typeof ev !== 'object' || ev.kind !== this.kind || typeof ev.content !== 'string') return;
      if (ev.pubkey === this.pubkey) return;                      // our own echo
      if (!Array.isArray(ev.tags) || !ev.tags.some((t) => Array.isArray(t) && t[0] === 'x' && t[1] === this.topic)) return;
      if (ev.content.length > MAX_CONTENT) return;
      const id = typeof ev.id === 'string' ? ev.id : crypto.createHash('sha256').update(ev.content).digest('hex');
      if (this.seen.has(id)) return;                              // same event via another relay
      this.seen.add(id);
      if (this.seen.size > 4096) this.seen.clear();
      // Authenticity comes from the caller's AEAD seal, not from the relay or
      // the throwaway signature, so an unverifiable event is simply dropped
      // later when it fails to decrypt.
      this.emit('data', ev.content);
    } else if (msg[0] === 'OK' && msg[2] === false) {
      this.emit('relay-error', url, `rejected event: ${msg[3] ?? 'no reason given'}`);
    } else if (msg[0] === 'CLOSED' && msg[1] === this.subId) {
      this.emit('relay-error', url, `subscription closed: ${msg[2] ?? ''}`);
    }
  }

  /** Publishes to every connected relay. Resolves with the number reached. */
  async send(content) {
    if (this.closed) return 0;
    if (typeof content !== 'string' || content.length > MAX_CONTENT) throw new Error('nostr payload too large');
    const created_at = Math.floor(Date.now() / 1000);
    const tags = [['x', this.topic]];
    const id = crypto.createHash('sha256')
      .update(JSON.stringify([0, this.pubkey, created_at, this.kind, tags, content]))
      .digest();
    const sig = await schnorr.signAsync(id, this.secretKey);
    const frame = JSON.stringify(['EVENT', {
      id: toHex(id), pubkey: this.pubkey, created_at, kind: this.kind, tags, content, sig: toHex(sig),
    }]);
    let reached = 0;
    for (const { ws, open } of this.sockets.values()) {
      if (!open) continue;
      try { ws.send(frame); reached++; } catch { /* relay went away */ }
    }
    return reached;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const { ws, open } of this.sockets.values()) {
      try {
        if (open) ws.send(JSON.stringify(['CLOSE', this.subId]));
        ws.close();
      } catch { /* already gone */ }
    }
    this.sockets.clear();
    this.emit('closed');
  }
}
