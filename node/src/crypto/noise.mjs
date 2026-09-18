/**
 * Noise_XX_25519_ChaChaPoly_SHA256 handshake.
 *
 * Why XX: neither side needs to know the other's static key in advance (the
 * whole point of a share code), yet both static keys are transmitted and
 * authenticated during the handshake. That gives us mutual authentication
 * plus the transcript hash we need to derive a Short Authentication String.
 *
 * This runs *inside* the DTLS tunnel that libdatachannel already provides.
 * DTLS protects us from the network; this protects us from the rendezvous
 * server and from any TURN relay, neither of which ever sees a key or a
 * plaintext byte.
 *
 * Reference: https://noiseprotocol.org/noise.html (revision 34), section 7.5.
 */

import crypto from 'node:crypto';

export const PROTOCOL_NAME = 'Noise_XX_25519_ChaChaPoly_SHA256';
const DHLEN = 32;
const TAGLEN = 16;
const HASHLEN = 32;

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

export function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { publicKey, privateKey, pub: rawPublic(publicKey) };
}

export function rawPublic(keyObject) {
  const jwk = keyObject.export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url');
}

export function publicFromRaw(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== DHLEN) {
    throw new Error(`x25519 public key must be ${DHLEN} bytes, got ${raw?.length}`);
  }
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') },
    format: 'jwk',
  });
}

function dh(privateKey, remoteRawPub) {
  const shared = crypto.diffieHellman({
    privateKey,
    publicKey: publicFromRaw(remoteRawPub),
  });
  // RFC 7748: an all-zero output means a small-order public key was supplied.
  // Noise says to abort rather than continue with a predictable shared secret.
  if (shared.every((b) => b === 0)) {
    throw new Error('x25519: peer sent a small-order public key');
  }
  return shared;
}

function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function hkdf2(chainingKey, ikm) {
  const out = Buffer.from(
    crypto.hkdfSync('sha256', ikm, chainingKey, Buffer.alloc(0), 64),
  );
  return [out.subarray(0, 32), out.subarray(32, 64)];
}

/** Noise nonce encoding: 4 zero bytes followed by an 8-byte little-endian counter. */
export function noiseNonce(counter) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64LE(BigInt(counter), 4);
  return n;
}

export function aeadEncrypt(key, nonce, ad, plaintext) {
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAGLEN });
  c.setAAD(ad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);
}

export function aeadDecrypt(key, nonce, ad, ciphertext) {
  if (ciphertext.length < TAGLEN) throw new Error('ciphertext too short');
  const ct = ciphertext.subarray(0, ciphertext.length - TAGLEN);
  const tag = ciphertext.subarray(ciphertext.length - TAGLEN);
  const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAGLEN });
  d.setAAD(ad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/* ------------------------------------------------------------------ */
/* symmetric state                                                     */
/* ------------------------------------------------------------------ */

class SymmetricState {
  constructor(protocolName, prologue) {
    const name = Buffer.from(protocolName, 'utf8');
    this.h = name.length <= HASHLEN
      ? Buffer.concat([name, Buffer.alloc(HASHLEN - name.length)])
      : sha256(name);
    this.ck = Buffer.from(this.h);
    this.k = null;
    this.n = 0;
    this.mixHash(prologue ?? Buffer.alloc(0));
  }

  mixHash(data) {
    this.h = sha256(this.h, data);
  }

  mixKey(ikm) {
    const [ck, k] = hkdf2(this.ck, ikm);
    this.ck = ck;
    this.k = k;
    this.n = 0; // a fresh key restarts the nonce sequence
  }

  encryptAndHash(plaintext) {
    if (!this.k) {
      this.mixHash(plaintext);
      return plaintext;
    }
    const ct = aeadEncrypt(this.k, noiseNonce(this.n++), this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext) {
    if (!this.k) {
      this.mixHash(ciphertext);
      return ciphertext;
    }
    const pt = aeadDecrypt(this.k, noiseNonce(this.n++), this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  split() {
    const [k1, k2] = hkdf2(this.ck, Buffer.alloc(0));
    return [k1, k2];
  }
}

/* ------------------------------------------------------------------ */
/* handshake state                                                     */
/* ------------------------------------------------------------------ */

/**
 * Drives one side of the three-message XX pattern.
 *
 *   -> e
 *   <- e, ee, s, es
 *   -> s, se
 *
 * Call writeMessage()/readMessage() alternately, starting with
 * writeMessage() on the initiator. `done` flips true once the transport
 * keys are available from `split()`.
 */
export class HandshakeState {
  /**
   * @param {object} opts
   * @param {boolean} opts.initiator
   * @param {{privateKey: crypto.KeyObject, pub: Buffer}} opts.staticKeypair
   * @param {Buffer} [opts.prologue] bound into the transcript; must match on both sides
   */
  constructor({ initiator, staticKeypair, prologue }) {
    this.initiator = initiator;
    this.s = staticKeypair;
    this.e = null;
    this.re = null; // remote ephemeral (raw)
    this.rs = null; // remote static (raw)
    this.sym = new SymmetricState(PROTOCOL_NAME, prologue);
    this.step = 0;
    this.done = false;
  }

  /** Transcript hash. Identical on both sides iff no MITM occurred. */
  get handshakeHash() {
    return Buffer.from(this.sym.h);
  }

  /** Remote peer's long-term identity key, available after message 2 (initiator) / 3 (responder). */
  get remoteStatic() {
    return this.rs ? Buffer.from(this.rs) : null;
  }

  writeMessage(payload = Buffer.alloc(0)) {
    if (this.done) throw new Error('handshake already complete');
    const parts = [];

    if (this.initiator && this.step === 0) {
      // -> e
      this.e = generateKeypair();
      parts.push(this.e.pub);
      this.sym.mixHash(this.e.pub);
      parts.push(this.sym.encryptAndHash(payload));
      this.step = 1;
    } else if (!this.initiator && this.step === 1) {
      // <- e, ee, s, es
      this.e = generateKeypair();
      parts.push(this.e.pub);
      this.sym.mixHash(this.e.pub);
      this.sym.mixKey(dh(this.e.privateKey, this.re));          // ee
      parts.push(this.sym.encryptAndHash(this.s.pub));          // s
      this.sym.mixKey(dh(this.s.privateKey, this.re));          // es
      parts.push(this.sym.encryptAndHash(payload));
      this.step = 2;
    } else if (this.initiator && this.step === 2) {
      // -> s, se
      parts.push(this.sym.encryptAndHash(this.s.pub));          // s
      this.sym.mixKey(dh(this.s.privateKey, this.re));          // se
      parts.push(this.sym.encryptAndHash(payload));
      this.step = 3;
      this.done = true;
    } else {
      throw new Error(`writeMessage out of order (initiator=${this.initiator}, step=${this.step})`);
    }

    return Buffer.concat(parts);
  }

  readMessage(message) {
    if (this.done) throw new Error('handshake already complete');
    let off = 0;
    const take = (n) => {
      if (off + n > message.length) throw new Error('handshake message truncated');
      const b = message.subarray(off, off + n);
      off += n;
      return b;
    };

    let payload;
    if (!this.initiator && this.step === 0) {
      // -> e
      this.re = Buffer.from(take(DHLEN));
      this.sym.mixHash(this.re);
      payload = this.sym.decryptAndHash(message.subarray(off));
      this.step = 1;
    } else if (this.initiator && this.step === 1) {
      // <- e, ee, s, es
      this.re = Buffer.from(take(DHLEN));
      this.sym.mixHash(this.re);
      this.sym.mixKey(dh(this.e.privateKey, this.re));          // ee
      this.rs = Buffer.from(this.sym.decryptAndHash(take(DHLEN + TAGLEN))); // s
      this.sym.mixKey(dh(this.e.privateKey, this.rs));          // es
      payload = this.sym.decryptAndHash(message.subarray(off));
      this.step = 2;
    } else if (!this.initiator && this.step === 2) {
      // -> s, se
      this.rs = Buffer.from(this.sym.decryptAndHash(take(DHLEN + TAGLEN))); // s
      this.sym.mixKey(dh(this.e.privateKey, this.rs));          // se
      payload = this.sym.decryptAndHash(message.subarray(off));
      this.step = 3;
      this.done = true;
    } else {
      throw new Error(`readMessage out of order (initiator=${this.initiator}, step=${this.step})`);
    }

    return payload;
  }

  /**
   * Transport keys. Returns { sendKey, recvKey } oriented for *this* peer.
   * Noise assigns the first key to the initiator's sending direction.
   */
  split() {
    if (!this.done) throw new Error('handshake not complete');
    const [k1, k2] = this.sym.split();
    return this.initiator
      ? { sendKey: k1, recvKey: k2 }
      : { sendKey: k2, recvKey: k1 };
  }
}
