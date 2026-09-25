/**
 * Desktop audio through a real session, including the "friend on Discord"
 * case: a fake "Discord" app plays 1000 Hz, a "game" plays 440 Hz. The host
 * streams with voice chat excluded; what the viewer plays must contain the
 * game and not Discord. Everything runs on unconnected PipeWire streams, so
 * nothing is audible. Skipped where PipeWire is not available.
 */
process.env.PENGUIN_NOSTR ??= '0';
process.env.SDL_VIDEODRIVER ??= 'offscreen';
process.env.SDL_AUDIODRIVER = 'pipewire';
// Every stream this test creates (tones, the viewer's player) stays unlinked
// from real devices; only our own capture nodes get linked to them.
process.env.PIPEWIRE_PROPS = '{ node.autoconnect = false }';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { startRendezvous } from '../../src/signal/server.mjs';
import { Host, Viewer } from '../../src/app/session.mjs';
import { findMediaBinary } from '../../src/media/engine.mjs';
import { cleanupTransport } from '../../src/transport/peer.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pipewire = process.platform === 'linux'
  && spawnSync('pw-cli', ['info', '0'], { timeout: 3000 }).status === 0
  && spawnSync('pw-play', ['--help'], { timeout: 3000 }).status === 0;
const binary = findMediaBinary();

function toneWav(file, hz, seconds) {
  const rate = 48000;
  const frames = rate * seconds;
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 4, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / rate));
    buf.writeInt16LE(v, 44 + i * 4);
    buf.writeInt16LE(v, 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

/** Amplitude of one frequency in the left channel (Goertzel). */
function amplitudeAt(pcm, hz) {
  const n = Math.floor(pcm.length / 4);
  const k = (2 * Math.PI * hz) / 48000;
  let s1 = 0; let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = pcm.readInt16LE(i * 4) + 2 * Math.cos(k) * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - 2 * Math.cos(k) * s1 * s2)) / n;
}

test.after(() => cleanupTransport());

test('audio reaches the viewer and voice chat stays out of it',
  { skip: (!pipewire && 'PipeWire not available') || (!binary && 'media engine not built'), timeout: 60_000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-audio-'));
    const tones = [];
    const rv = await startRendezvous({ port: 0, host: '127.0.0.1' });
    let host;
    let viewer;
    try {
      toneWav(path.join(dir, 'game.wav'), 440, 30);
      toneWav(path.join(dir, 'discord.wav'), 1000, 30);
      for (const [name, file] of [['ps-test-game', 'game.wav'], ['Discord', 'discord.wav']]) {
        tones.push(spawn('pw-play', ['-P', `{ application.name = "${name}", node.name = "${name}" }`, path.join(dir, file)],
          { stdio: 'ignore' }));
      }

      process.env.PENGUIN_STREAM_HOME = path.join(dir, 'host');
      host = new Host({ rendezvousUrl: rv.url, source: 'synthetic', fps: 15, stun: 'none', audio: true,
        audioFilter: { excludeVoice: true } });
      const hostLog = [];
      host.on('log', (l) => hostLog.push(l));
      let code;
      host.on('code', (c) => { code = c; });
      const hosting = host.start(async () => true);
      while (!code) await sleep(20);

      process.env.PENGUIN_STREAM_HOME = path.join(dir, 'viewer');
      viewer = new Viewer({ rendezvousUrl: rv.url, code, stun: 'none', audio: true, noInput: true });
      await Promise.all([viewer.start(), hosting]);
      await sleep(2500);   // audio flowing, jitter buffer filled

      // Record what the viewer is playing (its player stream is "Penguin Stream").
      // Async: a blocking spawn would starve the very session being measured.
      const rec = spawn(binary, ['audio-capture', '--only', 'penguin stream'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      rec.stdout.on('data', (c) => chunks.push(c));
      await sleep(2000);
      rec.kill('SIGTERM');
      await new Promise((r) => rec.once('close', r));
      const pcm = Buffer.concat(chunks);
      assert.ok(pcm.length > 48000 * 4, `viewer played too little audio (${pcm.length} bytes)`);
      const game = amplitudeAt(pcm, 440);
      const discord = amplitudeAt(pcm, 1000);
      t.diagnostic(`viewer output: game 440 Hz amplitude ${game.toFixed(0)} (sent 8000), Discord 1000 Hz amplitude ${discord.toFixed(1)}`);
      assert.ok(game > 6000, `game audio missing or distorted at the viewer (440 Hz amplitude ${game.toFixed(0)})`);
      assert.ok(discord < 100, `Discord leaked into the stream (1000 Hz amplitude ${discord.toFixed(0)})`);
      assert.ok(hostLog.some((l) => /leaving out "Discord"/.test(l)), 'host reports leaving Discord out');
      assert.ok(hostLog.some((l) => /leaving out "Penguin Stream"/.test(l)), 'host never re-captures stream playback');
    } finally {
      viewer?.close('test done');
      host?.close('test done');
      for (const t of tones) t.kill();
      await rv.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
