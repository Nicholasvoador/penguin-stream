/**
 * Persistent user settings (stream quality, input defaults, relay).
 *
 * Stored next to the identity in the config dir with owner-only permissions,
 * because the relay section can hold a TURN password or a Cloudflare API
 * token. Secrets never leave this module in publicSettings(): the UI only
 * learns whether one is set.
 */

import fs from 'node:fs';
import path from 'node:path';

import { configDir } from '../crypto/identity.mjs';

export const RELAY_MODES = ['none', 'cloudflare', 'url', 'manual'];
const SECRETS = ['cfToken', 'turnPassword'];

/** Stream resolutions offered in the UI: the value is the height of a 16:9 box. */
export const RESOLUTIONS = ['native', '2160', '1440', '1080', '900', '720', '540'];

/** Keys a profile controls. Everything else (relay, input permissions…) is per-machine. */
export const PROFILE_KEYS = ['fps', 'bitrate', 'resolution', 'encoder', 'lowLatency', 'adaptiveBitrate', 'audio', 'forceRelay'];

/**
 * Built-in presets. Bitrates are sized so one frame fits comfortably in the
 * link: at 60 fps, 20 Mbps is ~42 KB per frame. Too much bitrate for the path
 * does not buy quality, it buys queueing - the #1 cause of "laggy" streams.
 */
export const BUILTIN_PROFILES = Object.freeze([
  { id: 'competitive', name: 'Competitive (lowest latency)', builtin: true,
    hint: 'Fast games over a good connection. Smaller picture, highest frame rate, nothing buffered.',
    values: { resolution: '1080', fps: 120, bitrate: 25000, lowLatency: true, adaptiveBitrate: true, encoder: '', audio: true, forceRelay: false } },
  { id: 'balanced', name: 'Balanced (internet)', builtin: true,
    hint: 'Good default for playing or working with a friend over the internet.',
    values: { resolution: '1080', fps: 60, bitrate: 15000, lowLatency: true, adaptiveBitrate: true, encoder: '', audio: true, forceRelay: false } },
  { id: 'lan', name: 'Same house (LAN / Wi-Fi 6)', builtin: true,
    hint: 'Both computers on the same network: full resolution, high bitrate.',
    values: { resolution: 'native', fps: 120, bitrate: 60000, lowLatency: true, adaptiveBitrate: true, encoder: '', audio: true, forceRelay: false } },
  { id: 'weak', name: 'Weak connection / relay', builtin: true,
    hint: 'Mobile data, busy Wi-Fi, or when the connection goes through a relay.',
    values: { resolution: '720', fps: 60, bitrate: 6000, lowLatency: true, adaptiveBitrate: true, encoder: '', audio: true, forceRelay: false } },
  { id: 'work', name: 'Desktop work (sharp text)', builtin: true,
    hint: 'Coding, documents, spreadsheets: crisp text matters more than frame rate.',
    values: { resolution: 'native', fps: 30, bitrate: 20000, lowLatency: false, adaptiveBitrate: true, encoder: '', audio: true, forceRelay: false } },
]);

export const DEFAULT_SETTINGS = Object.freeze({
  fps: 60,
  bitrate: 15000,
  resolution: '1080',        // stream size; never upscales
  monitor: 'primary',        // 'primary' | monitor id "x,y,w,h" | 'all'
  adaptiveBitrate: true,     // lower the bitrate when the connection starts queueing
  profile: 'balanced',       // last applied profile (UI hint only)
  profiles: Object.freeze([]),  // user-saved profiles: { id, name, values }
  portalTokens: Object.freeze({}), // Wayland: remembered screen choice per monitor
  encoder: '',
  source: '',
  display: '',
  lowLatency: true,
  audio: true,
  audioExcludeVoice: true,   // keep Discord & co. out of the stream (no double voices)
  audioExclude: '',          // extra apps to leave out, comma-separated
  audioOnly: '',             // or: stream just this one app
  allowInput: true,
  allowGamepad: true,
  sendKbm: true,
  sendPad: true,
  forceRelay: false,
  noStun: false,
  stun: '',
  rendezvous: '',
  relay: Object.freeze({
    mode: 'none', cfKeyId: '', cfToken: '', url: '', turn: '', turnUser: '', turnPassword: '',
  }),
});

const str = (v, max = 512) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
const oneOf = (v, list) => (list.includes(v) ? v : undefined);
const intIn = (v, lo, hi) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
};

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'profile';

/** 'native', a preset height, or a custom "WIDTHxHEIGHT" (both even, 320..7680). */
export function sanitizeResolution(v) {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (RESOLUTIONS.includes(s)) return s;
  const m = s.match(/^(\d{3,4})x(\d{3,4})$/);
  if (!m) return undefined;
  const w = +m[1], h = +m[2];
  return w >= 320 && w <= 7680 && h >= 240 && h <= 4320 ? `${w & ~1}x${h & ~1}` : undefined;
}

/** The stream-size box {width, height} for the engine (0 = native). */
export function resolutionBox(res) {
  if (!res || res === 'native') return { width: 0, height: 0 };
  const m = /^(\d+)x(\d+)$/.exec(res);
  if (m) return { width: +m[1], height: +m[2] };
  const h = Number(res);
  if (!Number.isInteger(h) || h <= 0) return { width: 0, height: 0 };
  return { width: Math.round((h * 16) / 9) & ~1, height: h };
}

export function sanitizeProfileValues(v = {}) {
  const clean = sanitizeSettings(v && typeof v === 'object' ? v : {});
  const out = {};
  for (const k of PROFILE_KEYS) if (clean[k] !== undefined) out[k] = clean[k];
  return out;
}

/** Validates a partial update; unknown or malformed fields are dropped. */
export function sanitizeSettings(input = {}) {
  const out = {};
  const set = (k, v) => { if (v !== undefined) out[k] = v; };
  set('fps', intIn(input.fps, 10, 240));
  set('bitrate', intIn(input.bitrate, 500, 200000));
  set('resolution', sanitizeResolution(input.resolution));
  if (typeof input.monitor === 'string' && (input.monitor === 'primary' || input.monitor === 'all' ||
      /^-?\d{1,6},-?\d{1,6},\d{1,5},\d{1,5}$/.test(input.monitor))) set('monitor', input.monitor);
  if (typeof input.profile === 'string' && /^[a-z0-9-]{1,40}$/.test(input.profile)) set('profile', input.profile);
  if (Array.isArray(input.profiles)) {
    const list = [];
    for (const p of input.profiles.slice(0, 20)) {
      const name = str(p?.name, 40);
      if (!name || !/^[\p{L}\p{N} ._()+&'-]+$/u.test(name)) continue;
      const id = typeof p.id === 'string' && /^u-[a-z0-9-]{1,40}$/.test(p.id) ? p.id : `u-${slug(name)}`;
      list.push({ id, name, values: sanitizeProfileValues(p.values) });
    }
    out.profiles = list;
  }
  if (input.portalTokens && typeof input.portalTokens === 'object' && !Array.isArray(input.portalTokens)) {
    const tokens = {};
    for (const [k, v] of Object.entries(input.portalTokens).slice(0, 16)) {
      if (/^[\w,:-]{1,64}$/.test(k) && typeof v === 'string' && /^[\w-]{1,256}$/.test(v)) tokens[k] = v;
    }
    out.portalTokens = tokens;
  }
  set('encoder', oneOf(input.encoder, ['', 'auto', 'nvenc', 'amf', 'qsv', 'mf', 'vaapi', 'x264', 'software']));
  set('source', oneOf(input.source, ['', 'dxgi', 'gdi', 'portal', 'x11', 'synthetic']));
  if (typeof input.display === 'string' && /^[0-9]{0,2}$/.test(input.display.trim())) set('display', input.display.trim());
  for (const k of ['lowLatency', 'adaptiveBitrate', 'audio', 'audioExcludeVoice', 'allowInput', 'allowGamepad', 'sendKbm', 'sendPad', 'forceRelay', 'noStun']) {
    if (typeof input[k] === 'boolean') out[k] = input[k];
  }
  set('stun', str(input.stun));
  for (const k of ['audioExclude', 'audioOnly']) {
    const v = str(input[k], 400);
    if (v !== undefined && /^[\p{L}\p{N} ._+,-]*$/u.test(v)) out[k] = v;
  }
  const rv = str(input.rendezvous);
  if (rv !== undefined && (rv === '' || /^wss?:\/\//.test(rv))) out.rendezvous = rv;

  if (input.relay && typeof input.relay === 'object') {
    const r = input.relay;
    const relay = {};
    const rset = (k, v) => { if (v !== undefined) relay[k] = v; };
    rset('mode', oneOf(r.mode, RELAY_MODES));
    rset('cfKeyId', str(r.cfKeyId, 128));
    rset('turnUser', str(r.turnUser, 256));
    const url = str(r.url, 1024);
    if (url !== undefined && (url === '' || /^https:\/\//i.test(url))) relay.url = url;
    const turn = str(r.turn, 512);
    if (turn !== undefined && (turn === '' || /^turns?:/i.test(turn) || /^[\w.-]+(:\d+)?$/.test(turn))) relay.turn = turn;
    // Secrets: undefined keeps the stored value, '' clears it.
    for (const k of SECRETS) {
      if (typeof r[k] === 'string') relay[k] = r[k].slice(0, 512);
    }
    out.relay = relay;
  }
  return out;
}

export class SettingsStore {
  constructor(dir = configDir()) {
    this.file = path.join(dir, 'settings.json');
    this.values = structuredClone({ ...DEFAULT_SETTINGS, relay: { ...DEFAULT_SETTINGS.relay } });
    try {
      const saved = sanitizeSettings(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      this.#merge(saved);
    } catch { /* first run or unreadable: defaults */ }
  }

  #merge(patch) {
    const { relay, ...rest } = patch;
    Object.assign(this.values, rest);
    if (relay) Object.assign(this.values.relay, relay);
  }

  get() { return structuredClone(this.values); }

  update(input) {
    this.#merge(sanitizeSettings(input));
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return this.get();
  }

  /** Applies a built-in or saved profile's values; returns the new settings. */
  applyProfile(id) {
    const p = BUILTIN_PROFILES.find((x) => x.id === id) ?? this.values.profiles.find((x) => x.id === id);
    if (!p) throw new Error('unknown profile');
    return this.update({ ...p.values, profile: p.id });
  }

  /** Saves the current stream settings as a named profile (replacing one with the same name). */
  saveProfile(name) {
    const clean = str(name, 40);
    if (!clean || !/^[\p{L}\p{N} ._()+&'-]+$/u.test(clean)) throw new Error('profile names may use letters, numbers, spaces and . _ ( ) + & \' -');
    const values = {};
    for (const k of PROFILE_KEYS) values[k] = this.values[k];
    const id = `u-${slug(clean)}`;
    const profiles = this.values.profiles.filter((p) => p.id !== id);
    if (profiles.length >= 20) throw new Error('you can save up to 20 profiles; delete one first');
    profiles.push({ id, name: clean, values });
    return this.update({ profiles, profile: id });
  }

  deleteProfile(id) {
    return this.update({ profiles: this.values.profiles.filter((p) => p.id !== id) });
  }

  /** Safe to hand to the UI: secrets become booleans. */
  publicSettings() {
    const v = this.get();
    delete v.portalTokens;   // opaque compositor grants; the UI has no use for them
    v.builtinProfiles = BUILTIN_PROFILES;
    for (const k of SECRETS) {
      v.relay[`${k}Set`] = Boolean(v.relay[k]);
      delete v.relay[k];
    }
    return v;
  }
}
