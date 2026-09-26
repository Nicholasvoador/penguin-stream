/**
 * Remote input through a real session: two real peers, the real capture and
 * view engines (synthetic source, offscreen SDL), the real validator and the
 * real virtual-controller backend when this machine allows it.
 */

// Offline and deterministic: a local rendezvous only; no window on screen.
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
const uinputUsable = (() => {
  if (process.platform !== 'linux') return false;
  try { fs.accessSync('/dev/uinput', fs.constants.R_OK | fs.constants.W_OK); return true; } catch { return false; }
})();
const padDevices = () => (process.platform === 'linux'
  ? fs.readFileSync('/proc/bus/input/devices', 'utf8').split('\n\n').filter((b) => b.includes('Penguin Stream X-Box 360 pad')).length
  : 0);

test.after(() => cleanupTransport());

test('input permissions, live toggles, controllers and rumble across a real session',
  { skip: !findMediaBinary() && 'media engine not built' }, async () => {
    process.env.PS_IGNORE_LOCAL_CONTROLLERS = '1';  // a real pad plugged in here must not add events
    const rv = await startRendezvous({ port: 0, host: '127.0.0.1' });
    const homes = [fs.mkdtempSync(path.join(os.tmpdir(), 'ps-h-')), fs.mkdtempSync(path.join(os.tmpdir(), 'ps-v-'))];
    let host;
    let viewer;
    try {
      process.env.PENGUIN_STREAM_HOME = homes[0];
      host = new Host({ rendezvousUrl: rv.url, source: 'synthetic', fps: 20, allowInput: true, allowGamepad: true,
        stun: 'none', code: undefined });
      const hostErrors = [];
      host.on('error', (e) => hostErrors.push(e.message));
      const received = [];
      host.on('input', (e) => received.push(e));
      let code;
      host.on('code', (c) => { code = c; });
      const hostReady = host.start(async () => true);
      await until(() => code, 5000, 'invitation');

      process.env.PENGUIN_STREAM_HOME = homes[1];
      viewer = new Viewer({ code, rendezvousUrl: rv.url, stun: 'none' });
      const perms = [];
      viewer.on('host-permissions', (p) => perms.push(p));
      const viewerErrors = [];
      viewer.on('error', (e) => viewerErrors.push(e.message));
      await Promise.all([hostReady, viewer.start()]);
      const peer = viewer.session.peer;

      // The host reports what it allows once its engine is up.
      await until(() => perms.length > 0, 8000, 'host permissions');
      assert.equal(perms.at(-1).kbm, true);
      assert.equal(perms.at(-1).pad, true);
      assert.equal(perms.at(-1).kbmReady, false, 'synthetic capture cannot inject keyboard/mouse');
      if (uinputUsable) assert.equal(perms.at(-1).padReady, true, 'uinput is usable here');

      // Keyboard, mouse and controller events arrive validated.
      peer.sendInput({ t: 'key', code: 4, down: true });
      peer.sendInput({ t: 'key', code: 4, down: false });
      peer.sendInput({ t: 'mousemove', x: 0.5, y: 0.5 });
      peer.sendInput({ t: 'pad', slot: 0, connected: true });
      peer.sendInput({ t: 'pad_button', slot: 0, button: 'a', down: true });
      peer.sendInput({ t: 'key', keycode: 97, down: true });          // 0.9 format: rejected
      await until(() => received.length >= 5, 5000, 'input at host');
      assert.deepEqual(received.map((e) => e.t), ['key', 'key', 'mousemove', 'pad', 'pad_button']);
      if (uinputUsable) {
        await until(() => padDevices() >= 1, 3000, 'virtual controller device');
      }

      // Host revokes controllers live: pad input stops, the pad is unplugged,
      // the viewer is told; keyboard/mouse keeps flowing.
      host.setPermissions({ pad: false });
      await until(() => perms.at(-1).pad === false, 5000, 'revocation notice');
      const before = received.length;
      peer.sendInput({ t: 'pad_button', slot: 0, button: 'b', down: true });
      peer.sendInput({ t: 'key', code: 5, down: true });
      await until(() => received.length >= before + 1, 5000, 'keyboard after revocation');
      await sleep(200);
      assert.deepEqual(received.slice(before).map((e) => e.t), ['key'], 'controller input must be dropped');
      if (uinputUsable) await until(() => padDevices() === 0, 3000, 'pad unplugged on revoke');

      // Re-allow; rumble from the host engine reaches the viewer engine.
      host.setPermissions({ pad: true });
      await until(() => perms.at(-1).pad === true, 5000, 're-allow notice');
      const rumbles = [];
      const original = viewer.engine.rumble.bind(viewer.engine);
      viewer.engine.rumble = (m) => { rumbles.push(m); return original(m); };
      host.engine.emit('rumble', { slot: 0, lo: 0.5, hi: 0.25 });
      await until(() => rumbles.length > 0, 5000, 'rumble at viewer');
      assert.deepEqual({ slot: rumbles[0].slot, lo: rumbles[0].lo, hi: rumbles[0].hi }, { slot: 0, lo: 0.5, hi: 0.25 });

      assert.deepEqual(hostErrors.filter((m) => /version|older/i.test(m)), [], 'same versions must not warn');
      assert.deepEqual(viewerErrors.filter((m) => /version|older/i.test(m)), []);
    } finally {
      viewer?.close('test done');
      host?.close('test done');
      await sleep(300);
      await rv.close();
      for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
      delete process.env.PENGUIN_STREAM_HOME;
      delete process.env.PS_IGNORE_LOCAL_CONTROLLERS;
    }
    if (uinputUsable) assert.equal(padDevices(), 0, 'no virtual controller may outlive the session');
  });
