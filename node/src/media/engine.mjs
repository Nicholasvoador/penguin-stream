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

/**
 * Maps the media engine's monotonic clock onto this process's.
 *
 * On Linux both are CLOCK_MONOTONIC, but on Windows std::chrono::steady_clock
 * (QueryPerformanceCounter) and Node's hrtime have different origins, so a raw
 * engine timestamp is meaningless here. Each stats message carries the
 * engine's "now"; the smallest (node - engine) difference seen is the best
 * estimate of the offset (pipe delay only ever adds to it).
 */
export class EngineClock {
  constructor() { this.offset = null; }
  observe(engineNow) {
    if (!Number.isFinite(engineNow) || engineNow <= 0) return;
    const d = Number(process.hrtime.bigint() / 1000n) - engineNow;
    if (this.offset === null || d < this.offset) this.offset = d;
  }
  /** engine µs -> node µs (identity until the first observation). */
  toNode(engineUs) { return engineUs + (this.offset ?? 0); }
  toEngine(nodeUs) { return nodeUs - (this.offset ?? 0); }
}

/** Incremental parser for the framed stdio protocol. */
/** Bytes the stream window may have waiting on its stdin before frames are dropped. */
const VIEW_QUEUE_LIMIT = 512 * 1024;

export class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);   // unparsed bytes (less than one header, or a whole tail)
    this.msg = null;              // message being assembled: { type, body, filled }
  }

  /**
   * Linear in the input: a large message (keyframe) is copied once into a
   * buffer of its final size as pipe reads arrive, instead of re-joining
   * the whole partial buffer on every read (1.3.1: O(n^2), 6 ms for a 3 MB
   * IDR). Small messages are sliced out without a copy.
   * @returns {{type:number, payload:Buffer}[]}
   */
  push(chunk) {
    const out = [];
    let data = chunk;
    if (this.msg) {
      const m = this.msg;
      const n = Math.min(data.length, m.body.length - m.filled);
      data.copy(m.body, m.filled, 0, n);
      m.filled += n;
      if (m.filled < m.body.length) return out;
      out.push({ type: m.type, payload: m.body });
      this.msg = null;
      data = data.subarray(n);
    }
    if (this.buf.length) { data = Buffer.concat([this.buf, data]); this.buf = Buffer.alloc(0); }
    let off = 0;
    while (data.length - off >= 5) {
      const payloadLen = data.readUInt32LE(off);
      if (payloadLen < 1 || payloadLen > MAX_MESSAGE_BYTES) {
        throw new Error(`ps-media sent an implausible message length ${payloadLen}`);
      }
      const type = data.readUInt8(off + 4);
      const bodyLen = payloadLen - 1;
      const start = off + 5;
      if (data.length - start >= bodyLen) {
        // Complete in this read. Copy so the pipe's chunk can be freed (a
        // slice would pin the whole 64 KB read for each small message).
        out.push({ type, payload: Buffer.from(data.subarray(start, start + bodyLen)) });
        off = start + bodyLen;
      } else {
        const body = Buffer.allocUnsafe(bodyLen);
        const have = data.length - start;
        data.copy(body, 0, start);
        this.msg = { type, body, filled: have };
        return out;
      }
    }
    if (off < data.length) this.buf = Buffer.from(data.subarray(off));
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
    this.clock = new EngineClock();
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
    // EPIPE on a dead engine arrives as an async 'error' event, not a throw.
    // Unhandled, it crashed the whole app (UI + session). The 'exit' event
    // reports the engine's death; the pipe error itself is noise.
    this.proc.stdin.on('error', () => {});

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
          this.clock.observe(this.config.now);
          delete this.config.now;   // engine-local; meaningless to the peer
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
        try {
          const s = JSON.parse(msg.payload.toString('utf8'));
          this.clock.observe(s.now);
          this.emit('stats', s);
        } catch { /* ignore */ }
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
    if (!this.proc || this.proc.killed || this.proc.exitCode !== null || !this.proc.stdin.writable) return false;
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
    this.clock = new EngineClock();
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
    if (this.opts.overlay === true) args.push('--overlay');

    // No windowsHide here: on Windows it sets SW_HIDE in STARTUPINFO, which
    // the child's first ShowWindow obeys - the stream window would stay hidden.
    this.proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    this.proc.stdin.on('error', () => {});   // see CaptureEngine: EPIPE must not crash the app

    const proc = this.proc;
    this.proc.stdout.on('data', (chunk) => {
      if (this.proc !== proc) return;     // stopped: ignore what was still buffered
      let messages;
      try {
        messages = this.parser.push(chunk);
      } catch (err) {
        // The byte stream is out of sync; every later chunk would fail too
        // (1.4.0 kept going and logged an error per chunk, forever). Stop the
        // window like CaptureEngine does - the session reports it and the
        // viewer reconnects cleanly.
        this.emit('error', err);
        this.stop();
        return;
      }
      for (const msg of messages) {
        if (msg.type === MsgType.Input) {
          try { this.emit('input', JSON.parse(msg.payload.toString('utf8'))); } catch { /* ignore */ }
        } else if (msg.type === MsgType.Control) {
          try {
            const m = JSON.parse(msg.payload.toString('utf8'));
            if (m?.t === 'viewer-state') this.emit('viewer-state', m);
            else if (m?.t === 'view-stats') { this.clock.observe(m.now); this.emit('view-stats', m); }
            else if (m?.t === 'need-keyframe') this.emit('need-keyframe');
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

  /**
   * @param {{ptsUs: bigint, keyframe: boolean, frame: Buffer}} v
   * @returns {boolean} false if the frame was dropped (decoder behind)
   */
  sendVideo({ ptsUs, keyframe, frame }) {
    // Backpressure: the stream window decodes synchronously as it reads. If
    // it falls behind (slow CPU, 4K, first-frame GPU init), frames used to
    // queue here without limit and were shown late, in order - latency that
    // grew by the second and showed up in no stage of the meter. Keep at
    // most ~2 frames in flight: drop until the pipe drains, then resync on a
    // keyframe (later P-frames would reference the dropped ones).
    const queued = this.proc?.stdin?.writableLength ?? 0;
    if (!keyframe && (queued > VIEW_QUEUE_LIMIT || this.dropUntilKeyframe)) {
      this.dropped = (this.dropped ?? 0) + 1;
      if (!this.dropUntilKeyframe) {
        this.dropUntilKeyframe = true;
        this.emit('behind', { queuedBytes: queued });
      }
      if (queued <= VIEW_QUEUE_LIMIT / 4) this.emit('need-keyframe');
      return false;
    }
    if (keyframe) this.dropUntilKeyframe = false;
    const payload = Buffer.allocUnsafe(12 + frame.length);
    payload.writeBigUInt64LE(BigInt(ptsUs), 0);
    payload.writeUInt32LE(keyframe ? 1 : 0, 8);
    frame.copy(payload, 12);
    return this.#write(encodeMessage(MsgType.VideoPacket, payload));
  }

  /** Live toggles from the UI: { kbm?, pad?, capture?, overlay? } (booleans). */
  setInput(state) {
    const msg = { t: 'viewer-set' };
    for (const k of ['kbm', 'pad', 'capture', 'overlay']) if (typeof state?.[k] === 'boolean') msg[k] = state[k];
    return this.#control(msg);
  }

  /** Stats text for the in-window overlay (shown only while it is switched on). */
  overlay(text) {
    return this.#control({ t: 'overlay', text: String(text).slice(0, 3000) });
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
    if (!this.proc || this.proc.exitCode !== null || !this.proc.stdin.writable) return false;
    try { this.proc.stdin.write(buf); return true; } catch { return false; }
  }

  stop() {
    if (!this.proc) return;
    const p = this.proc;
    this.#write(encodeMessage(MsgType.Shutdown, Buffer.alloc(0)));
    this.proc = null;
    try { p.stdin.end(); } catch { /* already closed */ }
    if (p.exitCode !== null || p.signalCode !== null) return;
    // A stream window stuck in a GPU driver ignores SIGTERM; 1.4.0 then left
    // it running forever. Escalate to SIGKILL.
    const { termMs = 1000, killMs = 3500 } = this.opts.stopTimeouts ?? {};
    const term = setTimeout(() => { try { p.kill('SIGTERM'); } catch { /* gone */ } }, termMs);
    const kill = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, killMs);
    term.unref?.();
    kill.unref?.();
    p.once('exit', () => { clearTimeout(term); clearTimeout(kill); });
  }
}
