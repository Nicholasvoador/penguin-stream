/**
 * Node-side driver for the ps-media child process.
 *
 * Mirrors media/src/ipc/framing.h. stdio is used rather than a socket so the
 * same code works on Windows.
 *
 * Wire format (little-endian): u32 payloadLen | u8 type | payload
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

export const MsgType = Object.freeze({
  VideoPacket: 0x01,
  Config: 0x02,
  Control: 0x03,
  Input: 0x04,
  Log: 0x05,
  Stats: 0x06,
  Shutdown: 0x07,
});

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export const MEDIA_MISSING = process.platform === 'win32'
  ? 'the media engine (bin\\ps-media.exe) is missing: download the Windows release zip, or build it with scripts\\build-windows.ps1'
  : 'the media engine is not built: run ./setup.sh (or cmake -S media -B media/build && cmake --build media/build)';

/** Locates the built ps-media binary, or returns null with a build hint. */
export function findExecutable(name) {
  const isWin = process.platform === 'win32';
  const binName = isWin && !name.toLowerCase().endsWith('.exe') ? `${name}.exe` : name;
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter);
  for (const dir of dirs) {
    const full = path.join(dir, binName);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch { /* continue */ }
  }
  return null;
}

export function findMediaBinary() {
  const exe = process.platform === 'win32' ? 'ps-media.exe' : 'ps-media';
  const candidates = [
    process.env.PS_MEDIA_BIN,
    path.join(REPO_ROOT, 'bin', exe),                              // release bundles
    path.join(REPO_ROOT, 'media', 'build', exe),                   // Ninja / Makefiles
    path.join(REPO_ROOT, 'media', 'build', 'Release', exe),
    path.join(REPO_ROOT, 'media', 'build', 'windows', 'Release', exe),  // scripts/build-windows.ps1
    path.join(REPO_ROOT, 'media', 'build', 'Debug', exe),
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Incremental parser for the framed stdio protocol. */
export class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  /** @returns {{type:number, payload:Buffer}[]} */
  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out = [];

    for (;;) {
      if (this.buf.length < 5) break;
      const payloadLen = this.buf.readUInt32LE(0);
      if (payloadLen < 1 || payloadLen > MAX_MESSAGE_BYTES) {
        throw new Error(`ps-media sent an implausible message length ${payloadLen}`);
      }
      const total = 4 + payloadLen;
      if (this.buf.length < total) break;

      const type = this.buf.readUInt8(4);
      const payload = this.buf.subarray(5, total);
      out.push({ type, payload: Buffer.from(payload) });
      this.buf = this.buf.subarray(total);
    }
    return out;
  }
}

export function encodeMessage(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const buf = Buffer.allocUnsafe(5 + body.length);
  buf.writeUInt32LE(body.length + 1, 0);
  buf.writeUInt8(type, 4);
  body.copy(buf, 5);
  return buf;
}

export function parseVideoPayload(payload) {
  if (payload.length < 12) return null;
  return {
    ptsUs: payload.readBigUInt64LE(0),
    keyframe: (payload.readUInt32LE(8) & 1) !== 0,
    data: payload.subarray(12),
  };
}

/**
 * Runs `ps-media capture`: emits 'config' once, then 'video' per encoded frame.
 */
export class CaptureEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.source] synthetic | x11 | portal | dxgi
   * @param {number} [opts.fps]
   * @param {number} [opts.bitrateKbps]
   * @param {string} [opts.encoder]
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.proc = null;
    this.config = null;
    this.parser = new FrameParser();
    this.stats = { frames: 0, bytes: 0 };
  }

  start() {
    const bin = findMediaBinary();
    if (!bin) throw new Error(MEDIA_MISSING);

    const args = ['capture'];
    if (this.opts.source) args.push('--source', this.opts.source);
    if (this.opts.fps) args.push('--fps', String(this.opts.fps));
    if (this.opts.bitrateKbps) args.push('--bitrate', String(this.opts.bitrateKbps));
    if (this.opts.encoder) args.push('--encoder', this.opts.encoder);
    if (this.opts.width) args.push('--width', String(this.opts.width));
    if (this.opts.height) args.push('--height', String(this.opts.height));
    if (this.opts.maxFrames) args.push('--max-frames', String(this.opts.maxFrames));
    if (this.opts.display !== undefined && this.opts.display !== '') args.push('--display', String(this.opts.display));
    const rect = (r) => (r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0
      ? `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}` : null);
    if (rect(this.opts.monitor)) args.push('--monitor', rect(this.opts.monitor));
    if (rect(this.opts.workspace)) args.push('--workspace', rect(this.opts.workspace));
    if (typeof this.opts.restoreToken === 'string' && /^[\w-]{1,256}$/.test(this.opts.restoreToken)) {
      args.push('--restore-token', this.opts.restoreToken);
    }
    if (this.opts.allowInput === true) args.push('--allow-input');
    if (this.opts.allowGamepad === true) args.push('--allow-gamepad');
    // Ask the OS for remote-control permission up front (Wayland prompts only
    // once, at share start) so keyboard/mouse can be switched on later.
    if (this.opts.inputCapable === true) args.push('--input-capable');

    this.proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    this.proc.stdout.on('data', (chunk) => {
      let messages;
      try {
        messages = this.parser.push(chunk);
      } catch (err) {
        this.emit('error', err);
        this.stop();
        return;
      }
      for (const msg of messages) this.#dispatch(msg);
    });

    // ps-media writes human-readable diagnostics to stderr; surface them rather
    // than letting failures look like silence.
    this.proc.stderr.on('data', (d) => this.emit('stderr', d.toString().trim()));
    this.proc.on('error', (err) => this.emit('error', err));
    this.proc.on('exit', (code, signal) => this.emit('exit', { code, signal }));
    return this;
  }

  #dispatch(msg) {
    switch (msg.type) {
      case MsgType.Config: {
        try {
          this.config = JSON.parse(msg.payload.toString('utf8'));
          this.emit('config', this.config);
        } catch {
          this.emit('error', new Error('ps-media sent malformed config'));
        }
        break;
      }
      case MsgType.VideoPacket: {
        const v = parseVideoPayload(msg.payload);
        if (!v) break;
        this.stats.frames++;
        this.stats.bytes += v.data.length;
        this.emit('video', v);
        break;
      }
      case MsgType.Stats:
        try { this.emit('stats', JSON.parse(msg.payload.toString('utf8'))); } catch { /* ignore */ }
        break;
      case MsgType.Log:
        this.emit('log', msg.payload.toString('utf8'));
        break;
      case MsgType.Control: {
        let m;
        try { m = JSON.parse(msg.payload.toString('utf8')); } catch { break; }
        if (m?.t === 'input-status') this.emit('input-status', m);
        else if (m?.t === 'rumble') this.emit('rumble', m);
        else if (m?.t === 'restore-token' && typeof m.token === 'string') this.emit('restore-token', m.token);
        break;
      }
      default:
        break;
    }
  }

  /** Live keyboard/mouse and controller permission (host UI toggles). */
  setPermissions({ kbm, pad }) {
    this.#send(MsgType.Control, JSON.stringify({ t: 'permissions', kbm: kbm === true, pad: pad === true }));
  }

  /** Ask the encoder for an immediate keyframe (new viewer, or reported loss). */
  requestKeyframe() {
    this.#send(MsgType.Control, JSON.stringify({ t: 'keyframe' }));
  }

  setBitrate(kbps) {
    this.#send(MsgType.Control, JSON.stringify({ t: 'bitrate', kbps }));
  }

  /** Forwards a viewer input event to the host-side injector. */
  sendInput(event) {
    this.#send(MsgType.Input, JSON.stringify(event));
  }

  #send(type, json) {
    if (!this.proc || this.proc.killed || !this.proc.stdin.writable) return false;
    try {
      this.proc.stdin.write(encodeMessage(type, Buffer.from(json, 'utf8')));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Graceful first: the engine releases held keys/buttons and unplugs virtual
   * controllers when it sees Shutdown or EOF. On Windows kill() is an
   * immediate TerminateProcess, so it is only the fallback after a grace
   * period; we never leak a capture process that still holds the screen.
   */
  stop() {
    if (!this.proc) return;
    const p = this.proc;
    this.#send(MsgType.Shutdown, '');
    this.proc = null;
    try { p.stdin.end(); } catch { /* already closed */ }
    if (p.exitCode !== null || p.signalCode !== null) return;
    const term = setTimeout(() => { try { p.kill('SIGTERM'); } catch { /* gone */ } }, 1500);
    const kill = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 3500);
    term.unref?.();
    kill.unref?.();
    p.once('exit', () => { clearTimeout(term); clearTimeout(kill); });
  }
}

/**
 * Runs `ps-media view`: feed it config + encoded frames, receive input events.
 */
export class ViewEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.proc = null;
    this.parser = new FrameParser();
    this.configSent = false;
  }

  start() {
    const bin = findMediaBinary();
    if (!bin) throw new Error(MEDIA_MISSING);

    const args = ['view'];
    if (this.opts.title) args.push('--title', this.opts.title);
    if (this.opts.noInput) args.push('--no-input');
    if (this.opts.sendKbm === false) args.push('--no-kbm');
    if (this.opts.sendPad === false) args.push('--no-gamepad');
    if (this.opts.lowLatency || this.opts.noVsync) args.push('--low-latency');

    // No windowsHide here: on Windows it sets SW_HIDE in STARTUPINFO, which
    // the child's first ShowWindow obeys - the stream window would stay hidden.
    this.proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'inherit'] });

    this.proc.stdout.on('data', (chunk) => {
      let messages;
      try {
        messages = this.parser.push(chunk);
      } catch (err) {
        this.emit('error', err);
        return;
      }
      for (const msg of messages) {
        if (msg.type === MsgType.Input) {
          try { this.emit('input', JSON.parse(msg.payload.toString('utf8'))); } catch { /* ignore */ }
        } else if (msg.type === MsgType.Control) {
          try {
            const m = JSON.parse(msg.payload.toString('utf8'));
            if (m?.t === 'viewer-state') this.emit('viewer-state', m);
            else if (m?.t === 'view-stats') this.emit('view-stats', m);
          } catch { /* ignore */ }
        } else if (msg.type === MsgType.Log) {
          this.emit('log', msg.payload.toString('utf8'));
        }
      }
    });

    this.proc.on('error', (err) => this.emit('error', err));
    this.proc.on('exit', (code, signal) => this.emit('exit', { code, signal }));
    return this;
  }

  sendConfig(config) {
    this.configSent = true;
    return this.#write(encodeMessage(MsgType.Config, Buffer.from(JSON.stringify(config), 'utf8')));
  }

  /** @param {{ptsUs: bigint, keyframe: boolean, frame: Buffer}} v */
  sendVideo({ ptsUs, keyframe, frame }) {
    const payload = Buffer.allocUnsafe(12 + frame.length);
    payload.writeBigUInt64LE(BigInt(ptsUs), 0);
    payload.writeUInt32LE(keyframe ? 1 : 0, 8);
    frame.copy(payload, 12);
    return this.#write(encodeMessage(MsgType.VideoPacket, payload));
  }

  /** Live toggles from the UI: { kbm?, pad?, capture? } (booleans). */
  setInput(state) {
    const msg = { t: 'viewer-set' };
    for (const k of ['kbm', 'pad', 'capture']) if (typeof state?.[k] === 'boolean') msg[k] = state[k];
    return this.#control(msg);
  }

  /** What the host currently allows, shown in the viewer's title bar. */
  hostPermissions({ kbm, pad }) {
    return this.#control({ t: 'host-permissions', kbm: kbm === true, pad: pad === true });
  }

  /** Force feedback from the host's virtual controller. */
  rumble({ slot, lo, hi }) {
    if (!Number.isInteger(slot) || slot < 0 || slot > 3) return false;
    const clamp = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
    return this.#control({ t: 'rumble', slot, lo: clamp(lo), hi: clamp(hi) });
  }

  #control(obj) {
    return this.#write(encodeMessage(MsgType.Control, Buffer.from(JSON.stringify(obj), 'utf8')));
  }

  #write(buf) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    try { this.proc.stdin.write(buf); return true; } catch { return false; }
  }

  stop() {
    if (!this.proc) return;
    const p = this.proc;
    this.#write(encodeMessage(MsgType.Shutdown, Buffer.alloc(0)));
    this.proc = null;
    try { p.stdin.end(); } catch { /* already closed */ }
    if (p.exitCode !== null || p.signalCode !== null) return;
    const term = setTimeout(() => { try { p.kill('SIGTERM'); } catch { /* gone */ } }, 1000);
    term.unref?.();
    p.once('exit', () => clearTimeout(term));
  }
}
