import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/transport/peer.mjs'), 'utf8');

// Regression (1.4.0): node-datachannel's native API reads `unordered`; the
// browser-style `ordered: false` is silently ignored, which made the media
// channel ordered (head-of-line blocking on every lost packet).
test('the media channel is created with the native `unordered` flag', () => {
  const media = src.slice(src.indexOf("createDataChannel('media'"), src.indexOf("createDataChannel('media'") + 200);
  assert.match(media, /unordered:\s*true/);
  assert.match(media, /maxRetransmits:\s*0/);
  assert.doesNotMatch(media, /ordered:\s*false/);
});

test('the SCTP send buffer is small enough for queueing to be visible', () => {
  const m = src.match(/sendBufferSize:\s*([^,\n]+)/);
  assert.ok(m, 'sendBufferSize set');
  const bytes = Function(`return (${m[1]})`)();
  assert.ok(bytes <= 512 * 1024, `sendBufferSize ${bytes} hides the send queue from bufferedAmount`);
});
