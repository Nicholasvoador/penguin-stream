import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseKscreen, parseXrandr, parseEngineList, resolveMonitor, workspaceOf } from '../../src/app/monitors.mjs';
import { AdaptiveBitrate, ClockSync, Summary, latencyTips } from '../../src/app/latency.mjs';
import {
  SettingsStore, sanitizeSettings, resolutionBox, sanitizeResolution, BUILTIN_PROFILES, DEFAULT_SETTINGS,
} from '../../src/app/settings.mjs';

/* ------------------------------ monitors ------------------------------ */

// Nic's real layout: 1440p landscape main + 1080p portrait to the right, offset.
const KSCREEN = JSON.stringify({ outputs: [
  { name: 'DP-4', enabled: true, connected: true, pos: { x: 0, y: 480 }, size: { width: 2560, height: 1440 }, scale: 1,
    priority: 1, currentModeId: 'a', modes: [{ id: 'a', size: { width: 2560, height: 1440 }, refreshRate: 210.001 }] },
  { name: 'DP-3', enabled: true, connected: true, pos: { x: 2560, y: 0 }, size: { width: 1080, height: 1920 }, scale: 1,
    priority: 2, rotation: 2, currentModeId: 'b', modes: [{ id: 'b', size: { width: 1920, height: 1080 }, refreshRate: 143.85 }] },
  { name: 'HDMI-1', enabled: false, connected: false, pos: { x: 0, y: 0 }, currentModeId: '', modes: [] },
] });

test('kscreen: enabled monitors with logical geometry, primary first', () => {
  const list = parseKscreen(KSCREEN);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((m) => m.id), ['0,480,2560,1440', '2560,0,1080,1920']);
  assert.equal(list[0].primary, true);
  assert.equal(list[0].hz, 210);
  assert.match(list[0].label, /DP-4 · 2560×1440 · 210 Hz/);
  assert.match(list[1].label, /1080×1920/, 'portrait monitors are labelled as they appear');
  assert.deepEqual(workspaceOf(list), { x: 0, y: 0, w: 3640, h: 1920 });
});

test('kscreen: scaled output derives logical size from the mode', () => {
  const list = parseKscreen(JSON.stringify({ outputs: [{ name: 'eDP-1', enabled: true, pos: { x: 0, y: 0 }, scale: 1.5,
    currentModeId: 'm', modes: [{ id: 'm', size: { width: 2880, height: 1800 }, refreshRate: 120 }] }] }));
  assert.equal(list[0].w, 1920);
  assert.equal(list[0].h, 1200);
  assert.equal(list[0].primary, true, 'a single monitor is the primary');
});

test('xrandr and Windows engine lists parse; junk is rejected', () => {
  const x = parseXrandr('Monitors: 2\n 0: +*DP-4 2560/597x1440/336+0+480  DP-4\n 1: +DP-3 1080/521x1920/293+2560+0  DP-3\n');
  assert.deepEqual(x.map((m) => [m.id, m.primary]), [['0,480,2560,1440', true], ['2560,0,1080,1920', false]]);
  const w = parseEngineList(JSON.stringify([
    { name: '\\\\.\\DISPLAY2', label: 'LG', x: -1920, y: 0, w: 1920, h: 1080, hz: 144, primary: false },
    { name: '\\\\.\\DISPLAY1', label: 'Dell', x: 0, y: 0, w: 2560, h: 1440, hz: 165, primary: true },
  ]));
  assert.equal(w[0].id, '0,0,2560,1440', 'primary first');
  assert.equal(w[1].x, -1920, 'monitors left of the primary have negative x');
  assert.deepEqual(parseKscreen('not json'), []);
  assert.deepEqual(parseEngineList('{"a":1}'), []);
  assert.deepEqual(parseXrandr(''), []);
});

test('monitor choice resolves against the current layout', () => {
  const list = parseKscreen(KSCREEN);
  assert.equal(resolveMonitor(list, 'primary').name, 'DP-4');
  assert.equal(resolveMonitor(list, '').name, 'DP-4');
  assert.equal(resolveMonitor(list, '2560,0,1080,1920').name, 'DP-3');
  assert.equal(resolveMonitor(list, '9999,0,1920,1080').name, 'DP-4', 'a monitor that is gone falls back to primary');
  assert.equal(resolveMonitor(list, 'all'), null, '"all" lets the OS picker decide');
  assert.equal(resolveMonitor([], 'primary'), null);
});

/* ------------------------------ resolution ------------------------------ */

test('stream resolution: presets, custom sizes, validation', () => {
  assert.deepEqual(resolutionBox('1080'), { width: 1920, height: 1080 });
  assert.deepEqual(resolutionBox('720'), { width: 1280, height: 720 });
  assert.deepEqual(resolutionBox('native'), { width: 0, height: 0 });
  assert.deepEqual(resolutionBox('1600x900'), { width: 1600, height: 900 });
  assert.equal(sanitizeResolution('1601x901'), '1600x900', 'custom sizes are made even');
  assert.equal(sanitizeResolution('1080'), '1080');
  for (const bad of ['1081', '99999x1', '1920x', 'x1080', '100x100', 1080, null, '1920x1080; rm -rf /']) {
    assert.equal(sanitizeResolution(bad), undefined, String(bad));
  }
});

/* ------------------------------ latency ------------------------------ */

test('clock sync trusts the fastest round trip', () => {
  const c = new ClockSync();
  const offset = 5_000_000;       // host clock is 5 s ahead
  // Symmetric 2 ms trip, then two slow asymmetric ones (queueing on the way back).
  c.add(1000, 1000 + 1000 + offset, 3000);
  c.add(10_000, 10_000 + 1000 + offset, 40_000);
  c.add(50_000, 50_000 + 25_000 + offset, 52_000 + 25_000);
  assert.equal(c.ready, true);
  assert.equal(c.offset, offset);
  assert.equal(c.minRttMs, 2);
  assert.equal(c.add(5, 1, 1), false, 'negative round trips are rejected');
});

test('summary reports avg, p95 and max, then resets', () => {
  const s = new Summary();
  for (let i = 1; i <= 100; i++) s.add(i);
  const r = s.take();
  assert.equal(r.avg, 50.5);
  assert.equal(r.p95, 96);
  assert.equal(r.max, 100);
  assert.equal(s.take(), null);
});

test('adaptive bitrate backs off on queueing and recovers slowly', () => {
  const abr = new AdaptiveBitrate({ maxKbps: 20000 });
  let t = 0;
  // 200 KB waiting at 20 Mbps = 80 ms of video: heavy congestion.
  abr.observeQueue(200 * 1024);
  const down = abr.tick(t += 1000);
  assert.ok(down && down <= 12500, `backs off hard (${down})`);
  // Viewer sees rising delay: back off again (after the hold time).
  abr.observeViewer({ delayRiseMs: 40, lost: 0 });
  const down2 = abr.tick(t += 1000);
  assert.ok(down2 < down, 'keeps backing off while congested');
  // Clean link: no change for the first 2 s, then +8 % steps, never above max.
  let last = down2;
  for (let i = 0; i < 80; i++) {
    abr.observeQueue(0);
    abr.observeViewer({ delayRiseMs: 2, lost: 0 });
    const k = abr.tick(t += 500);
    if (k) { assert.ok(k > last && k <= 20000); last = k; }
  }
  assert.equal(abr.current, 20000, 'fully recovers on a clean link');
  // Disabled: never changes.
  const off = new AdaptiveBitrate({ maxKbps: 20000, enabled: false });
  off.observeQueue(10 * 1024 * 1024);
  assert.equal(off.tick(5000), null);
});

test('adaptive bitrate: live ceiling change and floor', () => {
  const abr = new AdaptiveBitrate({ maxKbps: 20000, minKbps: 1500 });
  abr.setMax(8000);
  assert.equal(abr.current, 8000, 'lowering the ceiling applies immediately');
  let t = 0;
  for (let i = 0; i < 30; i++) { abr.observeQueue(10 * 1024 * 1024); abr.tick(t += 1000); }
  assert.equal(abr.current, 1500, 'never below the floor');
});

test('latency tips name the setting that helps', () => {
  const tips = latencyTips({ fps: 60, queueMs: 40, relayed: true, encodeMs: 14, decodeMs: 2, displayMs: 12, vsync: true, lostPct: 3, totalMs: 120 });
  const text = tips.map((t) => t.text).join('\n');
  assert.match(text, /relay/);
  assert.match(text, /bitrate/i);
  assert.match(text, /resolution|hardware encoder/i);
  assert.match(text, /Lowest latency display/);
  assert.equal(latencyTips({ fps: 60, totalMs: 20, queueMs: 0, encodeMs: 2, decodeMs: 2, displayMs: 1 })[0].level, 'ok');
});

/* ------------------------------ profiles ------------------------------ */

test('profiles: built-ins apply, custom ones save, validate and delete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-prof-'));
  try {
    const store = new SettingsStore(dir);
    assert.equal(store.get().resolution, DEFAULT_SETTINGS.resolution);
    assert.equal(store.get().monitor, 'primary', 'one monitor by default, never the whole desktop');

    store.applyProfile('competitive');
    const comp = BUILTIN_PROFILES.find((p) => p.id === 'competitive').values;
    assert.equal(store.get().fps, comp.fps);
    assert.equal(store.get().resolution, comp.resolution);
    assert.equal(store.get().profile, 'competitive');

    store.update({ resolution: '1600x900', bitrate: 12000 });
    store.saveProfile('Elden Ring com o Leo');
    const saved = store.get().profiles;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, 'u-elden-ring-com-o-leo');
    assert.equal(saved[0].values.resolution, '1600x900');
    assert.equal(saved[0].values.relay, undefined, 'profiles never carry relay secrets');

    store.applyProfile('balanced');
    store.applyProfile('u-elden-ring-com-o-leo');
    assert.equal(store.get().bitrate, 12000);

    // Survives a restart; invalid names are refused.
    const again = new SettingsStore(dir);
    assert.equal(again.get().profiles[0].name, 'Elden Ring com o Leo');
    assert.throws(() => again.saveProfile('<script>'), /profile names/);
    assert.throws(() => again.applyProfile('nope'), /unknown profile/);
    again.deleteProfile('u-elden-ring-com-o-leo');
    assert.deepEqual(again.get().profiles, []);

    const pub = again.publicSettings();
    assert.ok(Array.isArray(pub.builtinProfiles) && pub.builtinProfiles.length >= 4);
    assert.equal(pub.portalTokens, undefined, 'compositor grants stay server-side');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings reject malformed monitor ids, profiles and tokens', () => {
  const s = sanitizeSettings({
    monitor: '0,0,1920,1080;x', profile: 'Bad Id!', resolution: 'huge',
    profiles: [{ name: 'ok', values: { fps: 60, relay: { turnPassword: 'x' }, monitor: 'all' } }, { name: '' }, 'junk'],
    portalTokens: { 'linux:0,0,1920,1080': 'abc-123', 'bad key!': 'x', k: '<script>' },
  });
  assert.equal(s.monitor, undefined);
  assert.equal(s.profile, undefined);
  assert.equal(s.resolution, undefined);
  assert.deepEqual(s.profiles, [{ id: 'u-ok', name: 'ok', values: { fps: 60 } }]);
  assert.deepEqual(s.portalTokens, { 'linux:0,0,1920,1080': 'abc-123' });
  assert.equal(sanitizeSettings({ monitor: '-1920,0,1920,1080' }).monitor, '-1920,0,1920,1080');
});
