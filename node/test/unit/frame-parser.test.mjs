import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { FrameParser, encodeMessage } from '../../src/media/engine.mjs';

// Every split point and chunk size must give back exactly the messages sent.
test('FrameParser reassembles messages across arbitrary pipe reads', () => {
  const msgs = [
    [1, crypto.randomBytes(3)], [2, Buffer.alloc(0)], [1, crypto.randomBytes(300_000)],
    [3, Buffer.from('{"t":"x"}')], [1, crypto.randomBytes(65_536)], [4, crypto.randomBytes(1)],
  ];
  const wire = Buffer.concat(msgs.map(([t, p]) => encodeMessage(t, p)));
  for (const size of [1, 2, 4, 5, 6, 7, 1000, 4096, 65_536, wire.length]) {
    const p = new FrameParser();
    const got = [];
    for (let i = 0; i < wire.length; i += size) got.push(...p.push(wire.subarray(i, i + size)));
    assert.equal(got.length, msgs.length, `chunk ${size}: count`);
    got.forEach((m, i) => {
      assert.equal(m.type, msgs[i][0], `chunk ${size}: type ${i}`);
      assert.ok(m.payload.equals(msgs[i][1]), `chunk ${size}: payload ${i}`);
    });
  }
});

test('FrameParser is linear for a big keyframe split into pipe-sized reads', () => {
  const big = encodeMessage(1, crypto.randomBytes(3 * 1024 * 1024));
  const p = new FrameParser();
  const t = process.hrtime.bigint();
  let out = [];
  for (let i = 0; i < big.length; i += 65_536) out = out.concat(p.push(big.subarray(i, i + 65_536)));
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(out.length, 1);
  assert.ok(ms < 3, `3 MB message in 48 reads took ${ms.toFixed(2)} ms`);
});

test('FrameParser rejects an implausible length', () => {
  const p = new FrameParser();
  const bad = Buffer.alloc(5); bad.writeUInt32LE(0, 0);
  assert.throws(() => p.push(bad), /implausible/);
});
