/**
 * Lists this computer's monitors so the user can pick exactly one to share.
 *
 * Every entry is { id, name, label, x, y, w, h, hz, primary } in desktop
 * coordinates - logical pixels on Wayland (what the portal and the input
 * injection use), physical pixels on Windows (what DXGI captures).
 *
 * Sources, in order: the media engine on Windows (EnumDisplayMonitors),
 * kscreen-doctor on KDE Plasma, xrandr elsewhere on Linux. Failures return an
 * empty list - the UI then falls back to "Main monitor".
 */

import { execFile } from 'node:child_process';
import { findMediaBinary } from '../media/engine.mjs';

const TIMEOUT_MS = 4000;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// Printable text only (keeps × and · used in labels), bounded length.
const clean = (s, max = 60) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').trim().slice(0, max);

function finish(list) {
  const out = list
    .filter((m) => Number.isFinite(m.x) && Number.isFinite(m.y) && m.w > 0 && m.h > 0 && m.w <= 16384 && m.h <= 16384)
    .map((m) => ({
      id: `${m.x},${m.y},${m.w},${m.h}`,
      name: clean(m.name, 40),
      label: clean(m.label || m.name, 60),
      x: Math.round(m.x), y: Math.round(m.y), w: Math.round(m.w), h: Math.round(m.h),
      hz: Number.isFinite(m.hz) ? Math.round(m.hz) : 0,
      primary: m.primary === true,
    }));
  // Primary first, then left to right.
  out.sort((a, b) => (b.primary - a.primary) || (a.x - b.x) || (a.y - b.y));
  if (out.length && !out.some((m) => m.primary)) out[0].primary = true;
  return out;
}

/** Parses `kscreen-doctor -j` (KDE Plasma 5/6). Exported for tests. */
export function parseKscreen(json) {
  let d;
  try { d = JSON.parse(json); } catch { return []; }
  const list = [];
  for (const o of d?.outputs ?? []) {
    if (!o?.enabled || !o.connected && o.connected !== undefined) continue;
    const mode = (o.modes ?? []).find((m) => m.id === o.currentModeId);
    const scale = Number(o.scale) > 0 ? Number(o.scale) : 1;
    // `size` is the logical size (rotation and scale applied) on Plasma 6;
    // derive it from the mode when absent.
    let w = o.size?.width, h = o.size?.height;
    if (!(w > 0 && h > 0) && mode?.size) {
      const rot = o.rotation === 2 || o.rotation === 8;
      w = (rot ? mode.size.height : mode.size.width) / scale;
      h = (rot ? mode.size.width : mode.size.height) / scale;
    }
    list.push({
      name: o.name,
      label: [o.name, mode?.size ? `${Math.round(w * scale)}×${Math.round(h * scale)}` : '',
        mode?.refreshRate ? `${Math.round(mode.refreshRate)} Hz` : ''].filter(Boolean).join(' · '),
      x: o.pos?.x, y: o.pos?.y, w, h,
      hz: mode?.refreshRate,
      primary: o.priority === 1 || o.primary === true,
    });
  }
  return finish(list);
}

/** Parses `xrandr --listmonitors`. Exported for tests. */
export function parseXrandr(text) {
  const list = [];
  for (const line of String(text).split('\n')) {
    // " 0: +*DP-4 2560/597x1440/336+0+480  DP-4"
    const m = line.match(/^\s*\d+:\s+\+?(\*?)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/);
    if (m) list.push({ name: m[2], label: `${m[2]} · ${m[3]}×${m[4]}`, primary: m[1] === '*', w: +m[3], h: +m[4], x: +m[5], y: +m[6] });
  }
  return finish(list);
}

/** Parses the media engine's `list-monitors` output (Windows). Exported for tests. */
export function parseEngineList(json) {
  let d;
  try { d = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(d)) return [];
  return finish(d.map((m) => ({ ...m, label: `${m.label || m.name} · ${m.w}×${m.h}` })));
}

let cache = null;
let cacheAt = 0;

export async function listMonitors({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 5000) return cache;
  let list = [];
  if (process.platform === 'win32') {
    const bin = findMediaBinary();
    if (bin) list = parseEngineList(await run(bin, ['list-monitors']) ?? '');
  } else {
    const ks = await run('kscreen-doctor', ['-j']);
    if (ks) list = parseKscreen(ks);
    if (!list.length) {
      const xr = await run('xrandr', ['--listmonitors']);
      if (xr) list = parseXrandr(xr);
    }
  }
  cache = list;
  cacheAt = Date.now();
  return list;
}

/** Bounding box of all monitors ("x,y,w,h") - what a whole-workspace stream covers. */
export function workspaceOf(list) {
  if (!list.length) return null;
  const x0 = Math.min(...list.map((m) => m.x)), y0 = Math.min(...list.map((m) => m.y));
  const x1 = Math.max(...list.map((m) => m.x + m.w)), y1 = Math.max(...list.map((m) => m.y + m.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Resolves the saved monitor choice against the current layout:
 * 'primary' / '' -> the primary monitor; an id "x,y,w,h" -> that monitor if it
 * still exists (else primary); 'all' -> null (share whatever the OS offers).
 */
export function resolveMonitor(list, choice) {
  if (choice === 'all' || !list.length) return null;
  if (choice && choice !== 'primary') {
    const hit = list.find((m) => m.id === choice) ?? list.find((m) => m.name && m.name === choice);
    if (hit) return hit;
  }
  return list.find((m) => m.primary) ?? list[0];
}

export const rectArg = (r) => `${r.x},${r.y},${r.w},${r.h}`;
