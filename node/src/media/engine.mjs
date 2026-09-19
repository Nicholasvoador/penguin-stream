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

/** Locates the built ps-media binary, or returns null with a build hint. */
export function findMediaBinary() {
  const exe = process.platform === 'win32' ? 'ps-media.exe' : 'ps-media';
  const candidates = [
    process.env.PS_MEDIA_BIN,
    path.join(REPO_ROOT, 'media', 'build', exe),
    path.join(REPO_ROOT, 'media', 'build', 'Release', exe),
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
    if (!bin) {
      throw new Error(
        'ps-media binary not found. Build it with:\n' +
        '  cmake -B media/build -S media -G Ninja && cmake --build media/build',
      );
    }

    const args = ['capture'];
    if (this.opts.source) args.push('--source', this.opts.source);
    if (this.opts.fps) args.push('--fps', String(this.opts.fps));
    if (this.opts.bitrateKbps) args.push('--bitrate', String(this.opts.bitrateKbps));
    if (this.opts.encoder) args.push('--encoder', this.opts.encoder);
    if (this.opts.width) args.push('--width', String(this.opts.width));
    if (this.opts.height) args.push('--height', String(this.opts.height));
    if (this.opts.maxFrames) args.push('--max-frames', String(this.opts.maxFrames));
    if (this.opts.allowInput === true) args.push('--allow-input');

    this.proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

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
      default:
        break;
    }
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

  stop() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    try { p.stdin.end(); } catch { /* already closed */ }
    try { p.kill('SIGTERM'); } catch { /* already dead */ }
    // Escalate if it ignores SIGTERM, so we never leak a capture process that
    // is still holding the screen.
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
    t.unref?.();
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
    if (!bin) throw new Error('ps-media binary not found; build media/ first');

    const args = ['view'];
    if (this.opts.title) args.push('--title', this.opts.title);
    if (this.opts.noInput) args.push('--no-input');

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

  #write(buf) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    try { this.proc.stdin.write(buf); return true; } catch { return false; }
  }

  stop() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    try { p.stdin.end(); } catch { /* already closed */ }
    try { p.kill('SIGTERM'); } catch { /* already dead */ }
  }
}
