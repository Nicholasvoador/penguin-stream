/**
 * Long-term device identity and the trust store.
 *
 * Each install generates one X25519 keypair, once, and keeps it forever. The
 * public half is the device's permanent name; the Noise handshake proves
 * ownership of the private half. Pairing is therefore "remember this public
 * key", which is why a paired peer never has to re-enter a code.
 *
 * The private key is written 0600 and is never logged, never sent to the
 * rendezvous server, and never leaves this file's module boundary in raw form.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { generateKeypair, publicFromRaw, rawPublic } from './noise.mjs';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function configDir() {
  if (process.env.PENGUIN_STREAM_HOME) return process.env.PENGUIN_STREAM_HOME;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'penguin-stream');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'penguin-stream');
}

/** Crockford base32, no padding. Used for fingerprints and share codes. */
export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Human-readable fingerprint of a public key: 80 bits, grouped for reading
 * aloud. Shown in the UI so a user can confirm which machine they paired with.
 */
export function fingerprint(rawPub) {
  const digest = crypto.createHash('sha256')
    .update(Buffer.from('penguin-stream identity v1'))
    .update(rawPub)
    .digest();
  const s = base32Encode(digest.subarray(0, 10));
  return s.match(/.{1,4}/g).join('-');
}

export class Identity {
  constructor({ privateKey, publicKey, pub, label, createdAt }) {
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.pub = pub;
    this.label = label;
    this.createdAt = createdAt;
  }

  get fingerprint() {
    return fingerprint(this.pub);
  }

  /** The shape the Noise handshake wants. */
  get keypair() {
    return { privateKey: this.privateKey, publicKey: this.publicKey, pub: this.pub };
  }

  /** Safe to log or send: contains no secret material. */
  toPublicJSON() {
    return {
      label: this.label,
      publicKey: this.pub.toString('base64'),
      fingerprint: this.fingerprint,
    };
  }
}

function defaultLabel() {
  return `${os.hostname()} (${process.platform})`;
}

/**
 * Loads the device identity, creating it on first run.
 * @param {string} [dir] override config directory (tests use this)
 */
export function loadOrCreateIdentity(dir = configDir()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'identity.json');

  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const privateKey = crypto.createPrivateKey({
      key: { kty: 'OKP', crv: 'X25519', d: raw.privateKey, x: raw.publicKey },
      format: 'jwk',
    });
    const publicKey = publicFromRaw(Buffer.from(raw.publicKey, 'base64url'));
    return new Identity({
      privateKey,
      publicKey,
      pub: rawPublic(publicKey),
      label: raw.label || defaultLabel(),
      createdAt: raw.createdAt,
    });
  }

  const kp = generateKeypair();
  const jwk = kp.privateKey.export({ format: 'jwk' });
  const record = {
    version: 1,
    label: defaultLabel(),
    createdAt: new Date().toISOString(),
    publicKey: jwk.x,
    privateKey: jwk.d,
  };
  // Write 0600 from the start: never create the file world-readable and fix it
  // afterwards, or there is a window where the key is exposed.
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(record, null, 2));
  } finally {
    fs.closeSync(fd);
  }

  return new Identity({
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    pub: kp.pub,
    label: record.label,
    createdAt: record.createdAt,
  });
}

/**
 * Peers we have already paired with. Keyed by base64 public key, because that
 * is the thing the handshake actually authenticates.
 */
export class TrustStore {
  constructor(dir = configDir()) {
    this.file = path.join(dir, 'peers.json');
    this.dir = dir;
    this.peers = new Map();
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const p of raw.peers || []) this.peers.set(p.publicKey, p);
    } catch {
      // Absent or unreadable trust store means "nothing paired yet", which is
      // the correct fail-closed default.
      this.peers = new Map();
    }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, peers: [...this.peers.values()] }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** @param {Buffer} rawPub */
  get(rawPub) {
    return this.peers.get(Buffer.from(rawPub).toString('base64')) || null;
  }

  isTrusted(rawPub) {
    return this.get(rawPub) !== null;
  }

  /** @param {Buffer} rawPub */
  trust(rawPub, { label, role } = {}) {
    const key = Buffer.from(rawPub).toString('base64');
    const existing = this.peers.get(key);
    const entry = {
      publicKey: key,
      fingerprint: fingerprint(rawPub),
      label: label || existing?.label || 'unnamed device',
      role: role || existing?.role || 'client',
      firstPaired: existing?.firstPaired || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    this.peers.set(key, entry);
    this.save();
    return entry;
  }

  revoke(rawPubOrBase64) {
    const key = Buffer.isBuffer(rawPubOrBase64)
      ? rawPubOrBase64.toString('base64')
      : rawPubOrBase64;
    const had = this.peers.delete(key);
    if (had) this.save();
    return had;
  }

  list() {
    return [...this.peers.values()];
  }
}
