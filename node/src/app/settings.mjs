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

export const DEFAULT_SETTINGS = Object.freeze({
  fps: 60,
  bitrate: 20000,
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

/** Validates a partial update; unknown or malformed fields are dropped. */
export function sanitizeSettings(input = {}) {
  const out = {};
  const set = (k, v) => { if (v !== undefined) out[k] = v; };
  set('fps', intIn(input.fps, 10, 240));
  set('bitrate', intIn(input.bitrate, 500, 200000));
  set('encoder', oneOf(input.encoder, ['', 'auto', 'nvenc', 'amf', 'qsv', 'mf', 'vaapi', 'x264', 'software']));
  set('source', oneOf(input.source, ['', 'dxgi', 'gdi', 'portal', 'x11', 'synthetic']));
  if (typeof input.display === 'string' && /^[0-9]{0,2}$/.test(input.display.trim())) set('display', input.display.trim());
  for (const k of ['lowLatency', 'audio', 'audioExcludeVoice', 'allowInput', 'allowGamepad', 'sendKbm', 'sendPad', 'forceRelay', 'noStun']) {
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

  /** Safe to hand to the UI: secrets become booleans. */
  publicSettings() {
    const v = this.get();
    for (const k of SECRETS) {
      v.relay[`${k}Set`] = Boolean(v.relay[k]);
      delete v.relay[k];
    }
    return v;
  }
}
