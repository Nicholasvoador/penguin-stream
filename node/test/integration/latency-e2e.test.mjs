/**
 * Stream size, live bitrate and the latency meter through a real session:
 * two real peers, the real capture and view engines (synthetic source,
 * offscreen SDL), clock sync over the encrypted control channel.
 */

process.env.PENGUIN_NOSTR ??= '0';
process.env.SDL_VIDEODRIVER ??= 'offscreen';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startRendezvous } from '../../src/signal/server.mjs';
import { Host, Viewer } from '../../src/app/session.mjs';
import { findMediaBinary } from '../../src/media/engine.mjs';
import { cleanupTransport } from '../../src/transport/peer.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(25); }
  throw new Error(`timed out waiting for ${what}`);
};

test.after(() => cleanupTransport());

test('scaled stream, live bitrate change and a full latency breakdown',
  { skip: !findMediaBinary() && 'media engine not built' }, async () => {
    const rv = await startRendezvous({ port: 0, host: '127.0.0.1' });
    const homes = [fs.mkdtempSync(path.join(os.tmpdir(), 'ps-h-')), fs.mkdtempSync(path.join(os.tmpdir(), 'ps-v-'))];
    let host;
    let viewer;
    try {
      process.env.PENGUIN_STREAM_HOME = homes[0];
      // The synthetic source is 1280x720; ask for a 854x480 box.
      host = new Host({ rendezvousUrl: rv.url, source: 'synthetic', fps: 60, bitrateKbps: 8000,
        width: 854, height: 480, stun: 'none' });
      let code;
      host.on('code', (c) => { code = c; });
      let hostCfg;
      host.on('media-config', (c) => { hostCfg = c; });
      const hostStats = [];
      host.on('stats', (s) => hostStats.push(s));
      const logs = [];
      host.on('log', (l) => logs.push(l));
      const hostReady = host.start(async () => true);
      await until(() => code, 5000, 'invitation');

      process.env.PENGUIN_STREAM_HOME = homes[1];
      viewer = new Viewer({ code, rendezvousUrl: rv.url, stun: 'none', lowLatency: true });
      const viewerStats = [];
      viewer.on('stats', (s) => viewerStats.push(s));
      await Promise.all([hostReady, viewer.start()]);

      // Scaled to fit the box, keeping 16:9, even dimensions.
      await until(() => hostCfg, 8000, 'media config');
      assert.equal(hostCfg.width, 852);
      assert.equal(hostCfg.height, 480);
      assert.equal(hostCfg.sourceWidth, 1280);

      // The viewer measures every stage after clock sync.
      await until(() => viewerStats.some((s) => Number.isFinite(s.latency?.totalMs)), 12000, 'latency breakdown');
      const lat = viewerStats.findLast((s) => Number.isFinite(s.latency?.totalMs)).latency;
      assert.equal(lat.synced, true);
      for (const k of ['encodeMs', 'networkMs', 'decodeMs', 'displayMs', 'totalMs', 'rttMs']) {
        assert.ok(Number.isFinite(lat[k]) && lat[k] >= 0, `${k} = ${lat[k]}`);
      }
      // Same machine: glass-to-glass must be small (generous bound for loaded CI boxes).
      assert.ok(lat.totalMs < 150, `local capture->screen ${lat.totalMs} ms`);
      assert.ok(lat.networkMs < 50, `local network ${lat.networkMs} ms`);
      assert.ok(Array.isArray(lat.tips) && lat.tips.length > 0);

      // The host hears the viewer's numbers back (for the host-side panel and adaptation).
      await until(() => hostStats.some((s) => Number.isFinite(s.latency?.viewer?.totalMs)), 8000, 'viewer report at host');

      // Live bitrate change from the viewer reaches the encoder.
      viewer.requestBitrate(3000);
      await until(() => hostStats.at(-1)?.latency?.targetKbps === 3000, 8000, 'bitrate change');
      await until(() => hostStats.at(-1)?.targetKbps === 3000, 8000, 'encoder bitrate');
    } finally {
      viewer?.close('test done');
      host?.close('test done');
      await sleep(300);
      await rv.close();
      for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
      delete process.env.PENGUIN_STREAM_HOME;
    }
  });
