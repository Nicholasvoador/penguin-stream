/**
 * Post-handshake record layer.
 *
 * Media rides an unreliable, unordered SCTP channel, so we cannot use Noise's
 * implicit nonce counter — packets legitimately arrive out of order or not at
 * all. Instead every record carries its sequence number explicitly, and the
 * receiver runs an IPsec/DTLS-style sliding replay window (RFC 6347 §4.1.2.6).
 *
 * Record layout:
 *   [0]      channel id (u8)
 *   [1..9)   sequence number (u64 little-endian)
 *   [9..]    ChaCha20-Poly1305 ciphertext || 16-byte tag
 *
 * The 9-byte header is the AEAD associated data, so a relay cannot retarget a
 * record onto a different channel or renumber it without the tag failing.
 */

import { aeadEncrypt, aeadDecrypt, noiseNonce } from './noise.mjs';

export const HEADER_LEN = 9;
const TAG_LEN = 16;
const WINDOW_BITS = 1024;

/** Channel ids. Kept small and fixed so the header stays one byte. */
export const CHANNEL = Object.freeze({
  CONTROL: 1,
  VIDEO: 2,
  AUDIO: 3,
  INPUT: 4,
  STATS: 5,
});

export class ReplayWindow {
  constructor(bits = WINDOW_BITS) {
    this.bits = bits;
    this.highest = -1n;
    this.seen = new Set(); // sequence numbers within [highest-bits, highest]
  }

  /**
   * @returns {boolean} true if `seq` is fresh (and records it), false if it is
   *   a replay or has fallen off the left edge of the window.
   */
  accept(seq) {
    const s = BigInt(seq);
    if (s < 0n) return false;

    if (s > this.highest) {
      this.highest = s;
      this.seen.add(s);
      // Evict everything that has slid out of the window.
      const floor = this.highest - BigInt(this.bits);
      if (this.seen.size > this.bits) {
        for (const v of this.seen) if (v <= floor) this.seen.delete(v);
      }
      return true;
    }

    if (s <= this.highest - BigInt(this.bits)) return false; // too old
    if (this.seen.has(s)) return false;                      // replay
    this.seen.add(s);
    return true;
  }
}

export class SecureSession {
  /**
   * @param {{sendKey: Buffer, recvKey: Buffer}} keys from HandshakeState.split()
   */
  constructor({ sendKey, recvKey }) {
    if (!Buffer.isBuffer(sendKey) || sendKey.length !== 32) throw new Error('bad sendKey');
    if (!Buffer.isBuffer(recvKey) || recvKey.length !== 32) throw new Error('bad recvKey');
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.txSeq = 0n;
    this.replay = new ReplayWindow();
    this.stats = { sealed: 0, opened: 0, rejected: 0, replayed: 0 };
  }

  /**
   * ChaCha20-Poly1305 with a 64-bit counter: we must never wrap. At 10k
   * records/sec this ceiling is ~58 million years, so hitting it means a bug,
   * and continuing would reuse a nonce. Fail loudly instead.
   */
  #nextSeq() {
    if (this.txSeq >= 0xffffffffffffffffn) {
      throw new Error('record sequence exhausted; session must be rekeyed');
    }
    return this.txSeq++;
  }

  /**
   * @param {number} channel one of CHANNEL.*
   * @param {Buffer} plaintext
   * @returns {Buffer} complete record, ready to hand to the data channel
   */
  seal(channel, plaintext) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new Error(`channel must be a byte, got ${channel}`);
    }
    const seq = this.#nextSeq();
    const header = Buffer.alloc(HEADER_LEN);
    header.writeUInt8(channel, 0);
    header.writeBigUInt64LE(seq, 1);
    const ct = aeadEncrypt(this.sendKey, noiseNonce(seq), header, plaintext);
    this.stats.sealed++;
    return Buffer.concat([header, ct]);
  }

  /**
   * @param {Buffer} record
   * @returns {{channel: number, seq: bigint, plaintext: Buffer}}
   * @throws if the record is malformed, forged, or a replay
   */
  open(record) {
    if (!Buffer.isBuffer(record) || record.length < HEADER_LEN + TAG_LEN) {
      this.stats.rejected++;
      throw new Error('record too short');
    }
    const header = record.subarray(0, HEADER_LEN);
    const channel = header.readUInt8(0);
    const seq = header.readBigUInt64LE(1);

    // Check the tag before the replay window: an attacker must not be able to
    // poison the window with sequence numbers they cannot authenticate.
    let plaintext;
    try {
      plaintext = aeadDecrypt(this.recvKey, noiseNonce(seq), header, record.subarray(HEADER_LEN));
    } catch (err) {
      this.stats.rejected++;
      throw new Error(`record authentication failed: ${err.message}`);
    }

    if (!this.replay.accept(seq)) {
      this.stats.replayed++;
      throw new Error(`replayed or stale record (seq=${seq})`);
    }

    this.stats.opened++;
    return { channel, seq, plaintext };
  }
}
