/**
 * Troubleshooting log.
 *
 * A plain-text file per machine, written as things happen, so a problem can be
 * diagnosed afterwards - even from a friend's computer:
 *   Windows: %APPDATA%\penguin-stream\logs\penguin-stream.log
 *   Linux:   ~/.config/penguin-stream/logs/penguin-stream.log
 *
 * What goes in: app/OS versions, session start/stop, route (direct/relay),
 * encoder and capture backend, errors, media-engine messages, and a latency /
 * bitrate / loss line every 10 s during a session.
 *
 * What never goes in: invitation codes, relay passwords or API tokens, the UI
 * access token. Public IP addresses are masked to their first half. Every
 * line passes through redact() on its way to disk.
 *
 * Size is bounded: the file rotates at 1 MB, keeping 3 old files.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configDir } from '../crypto/identity.mjs';

const MAX_BYTES = 1024 * 1024;
const KEEP = 3;

// 160-bit invitations: 8 groups of 4 Crockford characters (optionally @url).
const INVITE_RE = /\b[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){7}\b(?:@\S+)?/gi;
const SECRET_KV_RE = /\b(token|password|passwd|secret|credential|cfToken|turnPassword|authorization)(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi;
const BEARER_RE = /\bBearer\s+[\w.~+/=-]+/gi;
const URL_TOKEN_RE = /([#?&]token=)[\w.~-]+/gi;
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
const IPV6_RE = /\b([0-9a-f]{1,4}):([0-9a-f]{1,4}):(?:[0-9a-f]{0,4}:){1,6}[0-9a-f]{0,4}\b/gi;

const isPrivateV4 = (a, b) => a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
  || (a === 100 && b >= 64 && b <= 127) || a === 0 || (a === 169 && b === 254);

/** Removes secrets and masks public addresses. Exported for tests. */
export function redact(text) {
  return String(text)
    .replace(INVITE_RE, '[invitation]')
    .replace(BEARER_RE, 'Bearer [hidden]')
    .replace(URL_TOKEN_RE, '$1[hidden]')
    .replace(SECRET_KV_RE, '$1$2[hidden]')
    .replace(IPV4_RE, (m, a, b) => {
      const n = [a, b].map(Number);
      if ([a, b, m.split('.')[2], m.split('.')[3]].some((x) => Number(x) > 255)) return m;  // not an address (e.g. a version)
      return isPrivateV4(n[0], n[1]) ? m : `${a}.${b}.x.x`;
    })
    .replace(IPV6_RE, (m, a, b) => (/^(fe80|fd|fc)/i.test(a) || m === '::1' ? m : `${a}:${b}:…`));
}

export class Logbook {
  constructor(dir = path.join(configDir(), 'logs')) {
    this.dir = dir;
    this.file = path.join(dir, 'penguin-stream.log');
    this.fd = null;
    this.size = 0;
    this.failed = false;
  }

  #open() {
    if (this.fd !== null || this.failed) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.fd = fs.openSync(this.file, 'a', 0o600);
      this.size = fs.fstatSync(this.fd).size;
    } catch {
      this.failed = true;   // read-only home, full disk…: logging must never break the app
    }
  }

  #rotate() {
    try {
      fs.closeSync(this.fd);
      this.fd = null;
      for (let i = KEEP - 1; i >= 1; i--) {
        const from = `${this.file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`);
      }
      fs.renameSync(this.file, `${this.file}.1`);
    } catch { /* keep writing to whatever we have */ }
    this.#open();
  }

  /** @param {'info'|'warn'|'error'|'stat'} level */
  write(level, message) {
    this.#open();
    if (this.fd === null) return;
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
    const lines = redact(message).split(/\r?\n/).filter((l) => l.trim()).slice(0, 40);
    const text = lines.map((l) => `${ts} ${level.toUpperCase().padEnd(5)} ${l.slice(0, 2000)}`).join('\n') + '\n';
    try {
      fs.writeSync(this.fd, text);
      this.size += Buffer.byteLength(text);
      if (this.size > MAX_BYTES) this.#rotate();
    } catch { /* ignore */ }
  }

  info(m) { this.write('info', m); }
  warn(m) { this.write('warn', m); }
  error(m) { this.write('error', m); }
  stat(m) { this.write('stat', m); }

  /** Last `lines` lines of the current file (plus the previous one if short). */
  tail(lines = 400) {
    const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
    let text = read(this.file);
    if (text.split('\n').length < lines) text = read(`${this.file}.1`) + text;
    return text.split('\n').slice(-lines - 1).join('\n');
  }

  /** Header written once per start: enough to reproduce the environment. */
  startup({ version, extra = {} } = {}) {
    this.info('=== Penguin Stream start ===');
    this.info(`version ${version} · ${process.platform} ${os.release()} ${process.arch} · ` +
      `node ${process.versions.node}${process.versions.electron ? ` · electron ${process.versions.electron}` : ''}`);
    this.info(`cpu ${os.cpus()[0]?.model?.trim() ?? '?'} ×${os.cpus().length} · ram ${Math.round(os.totalmem() / 2 ** 30)} GB` +
      (process.env.XDG_SESSION_TYPE ? ` · session ${process.env.XDG_SESSION_TYPE}` : '') +
      (process.env.XDG_CURRENT_DESKTOP ? ` · desktop ${process.env.XDG_CURRENT_DESKTOP}` : ''));
    for (const [k, v] of Object.entries(extra)) this.info(`${k}: ${v}`);
  }

  close() {
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch { /* ignore */ } }
    this.fd = null;
  }
}

/** One compact line summarising a stats message (called every ~10 s). */
export function statLine(role, s) {
  const l = s?.latency ?? {};
  const t = s?.transport ?? {};
  const f = (v) => (Number.isFinite(v) ? (Math.round(v * 10) / 10).toString() : '-');
  const route = t.relayed ? 'relay' : t.connected ? `direct ${t.localType ?? ''}->${t.remoteType ?? ''} ${t.protocol ?? ''}`.trim() : '-';
  if (role === 'host') {
    const v = l.viewer ?? {};
    return `host fps=${f(s.fps)} kbps=${f(s.kbps)} target=${f(l.targetKbps)} capture=${f(l.captureMs)} encode=${f(l.encodeMs)} ` +
      `send=${f(l.sendMs)} queueKB=${f(l.queueKb)} viewerTotal=${f(v.totalMs)} viewerNet=${f(v.networkMs)} ` +
      `skipped=${s.dropped ?? 0} rtt=${f(t.rttMs)} route=${route}`;
  }
  return `view total=${f(l.totalMs)} capture=${f(l.captureMs)} encode=${f(l.encodeMs)} net=${f(l.networkMs)} ` +
    `netP95=${f(l.networkP95Ms)} decode=${f(l.decodeMs)} display=${f(l.displayMs)} input=${f(l.inputMs)} ` +
    `rtt=${f(l.rttMs)} loss=${f(l.lostPct)}% kbps=${f(l.kbps)} fps=${f(l.fps)} shown=${s.framesShown ?? 0} ` +
    `vsync=${l.vsync ? 'on' : 'off'} route=${route}`;
}
