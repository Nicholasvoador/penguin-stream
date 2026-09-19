/**
 * Fragmentation and reassembly for video frames on the unreliable channel.
 *
 * A 1080p keyframe is far larger than one datagram, so frames must be split.
 * The channel does not retransmit and does not preserve order, so reassembly
 * has to tolerate loss and reordering, and - critically - must never stall
 * waiting for a chunk that is never coming.
 *
 * Policy: a partial frame is abandoned as soon as a newer frame completes, or
 * when it ages out. Dropping a late frame is always better than delaying a
 * fresh one; that is the whole reason we are on an unreliable channel.
 *
 * Chunk header (17 bytes, little-endian):
 *   u32 frameId | u16 chunkIndex | u16 chunkCount | u64 ptsUs | u8 flags
 */

export const CHUNK_HEADER_BYTES = 17;
export const FLAG_KEYFRAME = 1;

/** Frames older than this many newer frames are abandoned. */
const REORDER_DEPTH = 3;

export class Chunker {
  constructor({ maxPayload }) {
    if (!Number.isInteger(maxPayload) || maxPayload <= CHUNK_HEADER_BYTES) {
      throw new Error(`maxPayload must exceed ${CHUNK_HEADER_BYTES}`);
    }
    this.maxChunkBytes = maxPayload - CHUNK_HEADER_BYTES;
    this.frameId = 0;
  }

  /**
   * @param {Buffer} frame encoded access unit
   * @param {{ptsUs: bigint|number, keyframe: boolean}} meta
   * @returns {Buffer[]} chunks ready for Peer.sendMedia
   */
  split(frame, { ptsUs = 0, keyframe = false } = {}) {
    const count = Math.max(1, Math.ceil(frame.length / this.maxChunkBytes));
    if (count > 0xffff) {
      throw new Error(`frame of ${frame.length} bytes needs ${count} chunks, exceeding the 65535 limit`);
    }

    const id = this.frameId;
    this.frameId = (this.frameId + 1) >>> 0;

    const out = [];
    for (let i = 0; i < count; i++) {
      const start = i * this.maxChunkBytes;
      const slice = frame.subarray(start, start + this.maxChunkBytes);
      const buf = Buffer.allocUnsafe(CHUNK_HEADER_BYTES + slice.length);
      buf.writeUInt32LE(id, 0);
      buf.writeUInt16LE(i, 4);
      buf.writeUInt16LE(count, 6);
      buf.writeBigUInt64LE(BigInt(ptsUs), 8);
      buf.writeUInt8(keyframe ? FLAG_KEYFRAME : 0, 16);
      slice.copy(buf, CHUNK_HEADER_BYTES);
      out.push(buf);
    }
    return out;
  }
}

export class Reassembler {
  constructor() {
    this.pending = new Map(); // frameId -> { chunks, count, received, ptsUs, keyframe, bytes }
    this.highestCompleted = -1;
    this.stats = { completed: 0, dropped: 0, duplicates: 0, malformed: 0, bytes: 0 };
  }

  /**
   * @param {Buffer} chunk
   * @returns {{frame: Buffer, ptsUs: bigint, keyframe: boolean}|null} a frame once complete
   */
  push(chunk) {
    if (!Buffer.isBuffer(chunk) || chunk.length < CHUNK_HEADER_BYTES) {
      this.stats.malformed++;
      return null;
    }

    const id = chunk.readUInt32LE(0);
    const index = chunk.readUInt16LE(4);
    const count = chunk.readUInt16LE(6);
    const ptsUs = chunk.readBigUInt64LE(8);
    const keyframe = (chunk.readUInt8(16) & FLAG_KEYFRAME) !== 0;
    const payload = chunk.subarray(CHUNK_HEADER_BYTES);

    if (count === 0 || index >= count) {
      this.stats.malformed++;
      return null;
    }

    // Chunk belonging to a frame we already emitted or gave up on.
    if (id <= this.highestCompleted && this.highestCompleted - id < 0x7fffffff) {
      this.stats.duplicates++;
      return null;
    }

    let entry = this.pending.get(id);
    if (!entry) {
      entry = { chunks: new Array(count), count, received: 0, ptsUs, keyframe, bytes: 0 };
      this.pending.set(id, entry);
    }
    if (entry.count !== count) {
      // Conflicting metadata for the same id: treat as corrupt and restart it.
      this.pending.delete(id);
      this.stats.malformed++;
      return null;
    }
    if (entry.chunks[index] !== undefined) {
      this.stats.duplicates++;
      return null;
    }

    entry.chunks[index] = payload;
    entry.received++;
    entry.bytes += payload.length;

    if (entry.received !== entry.count) {
      this.#expireOlderThan(id);
      return null;
    }

    this.pending.delete(id);
    this.highestCompleted = Math.max(this.highestCompleted, id);
    this.#expireOlderThan(id);

    const frame = Buffer.concat(entry.chunks, entry.bytes);
    this.stats.completed++;
    this.stats.bytes += frame.length;
    return { frame, ptsUs: entry.ptsUs, keyframe: entry.keyframe };
  }

  /**
   * Abandon partial frames that are too far behind. Without this, a frame that
   * lost a single chunk would occupy memory forever and, worse, a later chunk
   * of it could be mistaken for progress.
   */
  #expireOlderThan(currentId) {
    for (const [id, entry] of this.pending) {
      if (currentId - id > REORDER_DEPTH) {
        this.pending.delete(id);
        this.stats.dropped++;
        void entry;
      }
    }
  }

  /** True if a keyframe should be requested: we have lost frames recently. */
  get needsKeyframe() {
    return this.stats.dropped > 0;
  }

  acknowledgeKeyframe() {
    this.stats.dropped = 0;
  }
}
