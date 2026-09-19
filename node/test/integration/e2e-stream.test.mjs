/**
 * Full-pipeline test: real H.264 capture/encode in ps-media, real ICE/DTLS/
 * SCTP transport, real Noise encryption, real fragmentation, real reassembly.
 *
 * The final check does not trust our own decoder: it writes the bytes that
 * came out of the network to a file and asks ffmpeg to decode them. If ffmpeg
 * reports the expected number of frames, the stream that crossed the wire was
 * genuinely valid H.264.
 *
 * Capture uses the synthetic source only - no test in this repo captures the
 * operator's real desktop or sends it anywhere.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { startRendezvous } from '../../src/signal/server.mjs';
import { hostSession, joinSession } from '../../src/signal/client.mjs';
import { generateShareCode } from '../../src/signal/code.mjs';
import { loadOrCreateIdentity } from '../../src/crypto/identity.mjs';
import { cleanupTransport, MAX_PAYLOAD } from '../../src/transport/peer.mjs';
import { CHANNEL } from '../../src/crypto/session.mjs';
import { Chunker, Reassembler } from '../../src/media/chunker.mjs';
import { CaptureEngine, findMediaBinary } from '../../src/media/engine.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const ARTIFACTS = path.join(REPO_ROOT, 'artifacts');

const mediaBin = findMediaBinary();

function tmpIdentity(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ps-${tag}-`));
  return { id: loadOrCreateIdentity(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test.after(() => cleanupTransport());

test('captured H.264 survives the encrypted transport and decodes with ffmpeg', { skip: mediaBin ? false : 'ps-media not built' }, async (t) => {
  const FRAMES = 60;
  const rv = await startRendezvous({ port: 0, host: '127.0.0.1' });
  const h = tmpIdentity('e2eh');
  const c = tmpIdentity('e2ec');
  const code = generateShareCode();

  const hostPromise = hostSession({
    code, rendezvousUrl: rv.url, identity: h.id.keypair,
    onConsentRequest: async () => true, sessionTimeoutMs: 30_000,
  });
  await new Promise((r) => setTimeout(r, 150));
  const clientPromise = joinSession({
    code, rendezvousUrl: rv.url, identity: c.id.keypair, sessionTimeoutMs: 30_000,
  });

  const [host, client] = await Promise.all([hostPromise, clientPromise]);

  // ---- viewer side: reassemble what arrives ----
  const reassembler = new Reassembler();
  const received = [];
  client.peer.on('video', (payload) => {
    const done = reassembler.push(payload);
    if (done) received.push(done);
  });

  // ---- host side: capture -> chunk -> send ----
  const chunker = new Chunker({ maxPayload: MAX_PAYLOAD });
  const engine = new CaptureEngine({
    source: 'synthetic',
    fps: 30,
    bitrateKbps: 4000,
    width: 640,
    height: 360,
    maxFrames: FRAMES,
  });

  const sentFrames = [];
  const engineErrors = [];
  engine.on('error', (e) => engineErrors.push(e.message));
  engine.on('stderr', (s) => t.diagnostic(`ps-media stderr: ${s}`));

  const configPromise = new Promise((resolve, reject) => {
    engine.once('config', resolve);
    engine.once('exit', ({ code: ec }) => reject(new Error(`ps-media exited early (code ${ec})`)));
    setTimeout(() => reject(new Error('no config from ps-media within 20s')), 20_000);
  });

  engine.on('video', (v) => {
    sentFrames.push(v.data);
    for (const chunk of chunker.split(v.data, { ptsUs: v.ptsUs, keyframe: v.keyframe })) {
      try { host.peer.sendMedia(CHANNEL.VIDEO, chunk); } catch { /* closed */ }
    }
  });

  engine.start();
  const config = await configPromise;

  t.diagnostic(`encoder=${config.encoder} capture=${config.capture} ${config.width}x${config.height}`);
  assert.equal(config.codec, 'h264');
  assert.equal(config.width, 640);
  assert.equal(config.height, 360);
  assert.ok(config.encoder, 'engine must report which encoder it used');

  const exited = new Promise((resolve) => engine.once('exit', resolve));
  await Promise.race([exited, new Promise((r) => setTimeout(r, 40_000))]);
  // Let the tail of the stream drain across the network.
  await new Promise((r) => setTimeout(r, 1500));

  assert.deepEqual(engineErrors, [], 'capture engine must not report errors');
  assert.ok(sentFrames.length >= FRAMES * 0.9,
    `host should have encoded ~${FRAMES} frames, got ${sentFrames.length}`);
  assert.ok(received.length >= sentFrames.length * 0.9,
    `viewer should have reassembled most frames, got ${received.length}/${sentFrames.length}`);
  assert.equal(reassembler.stats.malformed, 0, 'no malformed chunks');
  assert.equal(client.peer.session.stats.rejected, 0, 'every media record must authenticate');

  // Byte-exactness: what we sent is what arrived.
  const sentById = new Map(sentFrames.map((f, i) => [i, f]));
  let compared = 0;
  for (let i = 0; i < received.length && i < sentById.size; i++) {
    if (received[i].frame.equals(sentById.get(i))) compared++;
  }
  assert.ok(compared >= received.length * 0.9,
    `reassembled frames should match the originals byte-for-byte (${compared}/${received.length})`);

  assert.ok(received.some((r) => r.keyframe), 'stream must contain at least one keyframe');

  // ---- independent verification: does ffmpeg decode what crossed the wire? ----
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const outFile = path.join(ARTIFACTS, 'e2e-received.h264');
  fs.writeFileSync(outFile, Buffer.concat(received.map((r) => r.frame)));

  const { stderr } = await execFileAsync('ffmpeg',
    ['-v', 'error', '-i', outFile, '-f', 'null', '-'],
    { timeout: 60_000 }).catch((e) => ({ stderr: e.stderr || e.message }));

  const probe = await execFileAsync('ffprobe',
    ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
     '-show_entries', 'stream=nb_read_frames,width,height,codec_name',
     '-of', 'default=noprint_wrappers=1', outFile],
    { timeout: 60_000 });

  t.diagnostic(`ffprobe: ${probe.stdout.replace(/\n/g, ' ')}`);
  assert.match(probe.stdout, /codec_name=h264/, 'the received bytes must be H.264');
  assert.match(probe.stdout, /width=640/);
  assert.match(probe.stdout, /height=360/);

  const decoded = Number(/nb_read_frames=(\d+)/.exec(probe.stdout)?.[1] ?? 0);
  assert.ok(decoded >= received.length * 0.9,
    `ffmpeg should decode the frames that arrived: decoded ${decoded}, received ${received.length}`);
  assert.ok(!/error|invalid|corrupt/i.test(stderr),
    `ffmpeg reported decode problems: ${stderr.slice(0, 400)}`);

  t.diagnostic(`sent ${sentFrames.length} frames, received ${received.length}, ffmpeg decoded ${decoded}`);

  engine.stop();
  host.close();
  client.close();
  h.cleanup();
  c.cleanup();
  await rv.close();
});
