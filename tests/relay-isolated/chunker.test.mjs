/** Regression checks for the real-proof use of existing application APIs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chunker, Reassembler } from '../../node/src/media/chunker.mjs';

test('proof-sized access units reassemble exactly with 17-byte headers', () => {
  const chunker = new Chunker({ maxPayload: 12000 });
  const assembler = new Reassembler();
  let chunks = 0;
  for (let unit = 0; unit < 20; unit++) {
    // Synthetic unit test only: the integration run reads private real H264.
    const frame = Buffer.alloc(unit % 2 ? 219520 : 530722, unit);
    const parts = chunker.split(frame, { ptsUs: BigInt(unit) * 33333n, keyframe: unit % 2 === 0 });
    chunks += parts.length;
    assert(parts.every((p) => p.length <= 12000));
    let result;
    for (const part of parts.reverse()) result = assembler.push(part) || result;
    assert.deepEqual(result.frame, frame);
    assert.equal(result.ptsUs, BigInt(unit) * 33333n);
    assert.equal(result.keyframe, unit % 2 === 0);
  }
  assert.equal(chunks, 640);
  assert.deepEqual(assembler.stats, { completed: 20, dropped: 0, duplicates: 0, malformed: 0, bytes: 7502420 });
});

test('missing chunk cannot produce a complete unit', () => {
  const chunker = new Chunker({ maxPayload: 12000 });
  const assembler = new Reassembler();
  const parts = chunker.split(Buffer.alloc(530722));
  for (const part of parts.slice(1)) assert.equal(assembler.push(part), null);
  assert.equal(assembler.stats.completed, 0);
  assert.equal(assembler.pending.size, 1);
});

test('malformed chunk is counted, not accepted', () => {
  const assembler = new Reassembler();
  assert.equal(assembler.push(Buffer.alloc(16)), null);
  assert.equal(assembler.stats.malformed, 1);
});
