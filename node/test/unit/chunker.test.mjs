import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { Chunker, Reassembler, CHUNK_HEADER_BYTES } from '../../src/media/chunker.mjs';

const MAX = 1200; // small, so tests exercise many chunks per frame

function roundTrip(frame, meta = {}) {
  const c = new Chunker({ maxPayload: MAX });
  const r = new Reassembler();
  const chunks = c.split(frame, meta);
  let out = null;
  for (const ch of chunks) out = r.push(ch) ?? out;
  return { out, chunks, reassembler: r };
}

test('a single-chunk frame round-trips', () => {
  const frame = Buffer.from('small frame');
  const { out, chunks } = roundTrip(frame, { ptsUs: 1234, keyframe: true });
  assert.equal(chunks.length, 1);
  assert.deepEqual(out.frame, frame);
  assert.equal(out.ptsUs, 1234n);
  assert.equal(out.keyframe, true);
});

test('a large frame splits and reassembles byte-exactly', () => {
  const frame = crypto.randomBytes(100_000);
  const { out, chunks } = roundTrip(frame, { ptsUs: 99, keyframe: false });
  assert.ok(chunks.length > 80, `expected many chunks, got ${chunks.length}`);
  for (const ch of chunks) assert.ok(ch.length <= MAX, 'no chunk may exceed the datagram limit');
  assert.deepEqual(out.frame, frame);
  assert.equal(out.keyframe, false);
});

test('chunks arriving out of order still reassemble', () => {
  const frame = crypto.randomBytes(30_000);
  const c = new Chunker({ maxPayload: MAX });
  const r = new Reassembler();
  const chunks = c.split(frame, { ptsUs: 7 });

  const shuffled = [...chunks].sort(() => Math.random() - 0.5);
  let out = null;
  for (const ch of shuffled) out = r.push(ch) ?? out;

  assert.ok(out, 'frame must complete regardless of arrival order');
  assert.deepEqual(out.frame, frame);
});

test('a frame missing a chunk is never emitted, and does not block later frames', () => {
  const c = new Chunker({ maxPayload: MAX });
  const r = new Reassembler();

  const lossy = c.split(crypto.randomBytes(20_000), { ptsUs: 1 });
  lossy.splice(3, 1); // drop one chunk
  for (const ch of lossy) {
    assert.equal(r.push(ch), null, 'an incomplete frame must never be emitted');
  }

  // Subsequent frames must still work.
  const good = Buffer.from('the next frame arrives intact');
  let out = null;
  for (const ch of c.split(good, { ptsUs: 2 })) out = r.push(ch) ?? out;
  assert.deepEqual(out.frame, good);
});

test('partial frames are abandoned rather than accumulating forever', () => {
  const c = new Chunker({ maxPayload: MAX });
  const r = new Reassembler();

  // 50 frames that each lose their final chunk.
  for (let i = 0; i < 50; i++) {
    const chunks = c.split(crypto.randomBytes(10_000), { ptsUs: i });
    chunks.pop();
    for (const ch of chunks) r.push(ch);
  }

  assert.ok(r.pending.size <= 8, `pending map grew to ${r.pending.size}`);
  assert.ok(r.stats.dropped > 0, 'dropped frames must be counted');
  assert.ok(r.needsKeyframe, 'loss should trigger a keyframe request');
  r.acknowledgeKeyframe();
  assert.ok(!r.needsKeyframe);
});

test('duplicate chunks are ignored, not double-counted', () => {
  const c = new Chunker({ maxPayload: MAX });
  const r = new Reassembler();
  const frame = crypto.randomBytes(5000);
  const chunks = c.split(frame, {});

  let out = null;
  for (const ch of chunks) out = r.push(ch) ?? out;
  assert.deepEqual(out.frame, frame);

  // Replaying the whole frame must not emit it again.
  for (const ch of chunks) assert.equal(r.push(ch), null);
  assert.equal(r.stats.completed, 1);
  assert.ok(r.stats.duplicates > 0);
});

test('malformed chunks are rejected without throwing', () => {
  const r = new Reassembler();
  assert.equal(r.push(Buffer.alloc(3)), null);
  assert.equal(r.push(Buffer.from('not a chunk')), null);
  assert.equal(r.push('not even a buffer'), null);

  // count = 0 is nonsense
  const bad = Buffer.alloc(CHUNK_HEADER_BYTES + 4);
  bad.writeUInt32LE(1, 0);
  bad.writeUInt16LE(0, 4);
  bad.writeUInt16LE(0, 6);
  assert.equal(r.push(bad), null);

  // index >= count
  const bad2 = Buffer.alloc(CHUNK_HEADER_BYTES + 4);
  bad2.writeUInt32LE(2, 0);
  bad2.writeUInt16LE(5, 4);
  bad2.writeUInt16LE(2, 6);
  assert.equal(r.push(bad2), null);

  assert.ok(r.stats.malformed >= 4);
});

test('survives sustained random loss and still delivers most frames', () => {
  const c = new Chunker({ maxPayload: MAX });
  const r = new Reassembler();
  const LOSS = 0.02;
  const FRAMES = 200;
  let delivered = 0;

  for (let i = 0; i < FRAMES; i++) {
    // Small frames: at 2% per-chunk loss most should survive.
    const frame = crypto.randomBytes(2000);
    for (const ch of c.split(frame, { ptsUs: i })) {
      if (Math.random() < LOSS) continue; // packet lost
      if (r.push(ch)) delivered++;
    }
  }

  assert.ok(delivered > FRAMES * 0.8,
    `expected most frames to survive 2% loss, delivered ${delivered}/${FRAMES}`);
  assert.equal(r.stats.malformed, 0);
});

test('rejects a maxPayload too small to hold a header', () => {
  assert.throws(() => new Chunker({ maxPayload: 10 }), /maxPayload/);
});
