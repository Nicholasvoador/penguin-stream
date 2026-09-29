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
// Media gets a much wider window: at 1.5-60 Mbps a few seconds of video plus
// audio is thousands of records, and reordering on the unordered channel must
// never look like a replay. Memory: one Set entry per record in the window.
const MEDIA_WINDOW_BITS = 16384;

/**
 * Which record channels may arrive on which data channel ("lane"). The sender
 * uses ONE sequence space for everything (so nonces stay unique per key and
 * the wire format is unchanged), but the receiver checks each lane on its own:
 *
 *   ctl lane   (reliable, ordered SCTP):  strictly increasing seq, no window.
 *   media lane (unreliable, unordered):   sliding replay window.
 *
 * Until 1.4.0 both lanes shared one 1024-record window. A control record that
 * SCTP retransmitted after a Wi-Fi hiccup arrived after >1024 media records,
 * was rejected as a "replay", and the rejection tore the whole session down
 * (seen in the field as "control channel closed" after a few minutes).
 */
export const LANE = Object.freeze({ CTL: 'ctl', MEDIA: 'media', ANY: 'any' });

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
      // Evict what slid out of the window - in batches, so the per-record
      // cost stays O(1) on the media hot path (a full sweep per record was
      // O(window) BigInt compares, i.e. millions per second at high bitrate).
      if (this.seen.size > this.bits + Math.max(16, this.bits >> 3)) {
        const floor = this.highest - BigInt(this.bits);
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
    this.replay = new ReplayWindow(MEDIA_WINDOW_BITS);   // media lane (and legacy callers)
    this.ctlHighest = -1n;                                // ctl lane: last accepted seq
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
   * @param {'ctl'|'media'|'any'} [lane] data channel the record arrived on.
   *   'any' (default, for tests/tools): window check only, any channel id.
   * @returns {{channel: number, seq: bigint, plaintext: Buffer}}
   * @throws if the record is malformed, forged, a replay, or on the wrong lane
   */
  open(record, lane = LANE.ANY) {
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

    if (lane === LANE.CTL) {
      // Reliable + ordered: every genuine record is newer than the last one,
      // however late SCTP delivered it. Media records never enter this check.
      if (channel === CHANNEL.VIDEO || channel === CHANNEL.AUDIO) {
        this.stats.rejected++;
        throw new Error(`media record on the control channel (seq=${seq})`);
      }
      if (seq <= this.ctlHighest) {
        this.stats.replayed++;
        throw new Error(`replayed control record (seq=${seq})`);
      }
      this.ctlHighest = seq;
    } else {
      if (lane === LANE.MEDIA && channel !== CHANNEL.VIDEO && channel !== CHANNEL.AUDIO) {
        this.stats.rejected++;
        throw new Error(`non-media record on the media channel (seq=${seq})`);
      }
      if (!this.replay.accept(seq)) {
        this.stats.replayed++;
        throw new Error(`replayed or stale record (seq=${seq})`);
      }
    }

    this.stats.opened++;
    return { channel, seq, plaintext };
  }
}
