/**
 * Desktop audio, host -> viewer. No processes start during import/construction.
 *
 * Both ends use the native media engine (no ffmpeg/ffplay/pactl needed):
 *   host:   `ps-media audio-capture` - PipeWire (Linux) or WASAPI loopback
 *           (Windows), optionally leaving apps out (e.g. Discord, so a viewer in
 *           the same voice call does not hear everyone twice)
 *   viewer: `ps-media audio-play` - SDL output with a bounded jitter buffer
 * Wire: 8-byte header ('PA01' + u32 sequence) + s16le 48 kHz stereo PCM.
 */
import { EventEmitter } from 'node:events';
import { spawn as spawnProcess } from 'node:child_process';

import { findMediaBinary, MEDIA_MISSING } from './engine.mjs';

export const AUDIO_HEADER_BYTES = 8;
export const AUDIO_FORMAT = Object.freeze({ sampleRate: 48000, channels: 2, sampleBytes: 2 });
const MAGIC = Buffer.from('PA01'); // version 1 fixes the PCM format above
const FRAME_BYTES = 4;
const PCM_CHUNK_BYTES = 3840;      // largest accepted packet: 20 ms
const CAPTURE_CHUNK_BYTES = 1920;  // what we send: 10 ms, less packetisation delay
const TRANSPORT_LIMIT = 60_000;    // Peer.MAX_PAYLOAD; callers should pass MAX_PAYLOAD
const LOG_LIMIT = 8192;
const SUPPORTED = new Set(['linux', 'win32']);
const APP_NAME = /^[\p{L}\p{N} ._+-]{1,64}$/u;

function payloadLimit(value = 3848) {
  if (!Number.isInteger(value) || value < 12 || value > TRANSPORT_LIMIT) {
    throw new RangeError('maxPayload must be an integer from 12 through 60000');
  }
  return value;
}

/**
 * Validates an app filter and turns it into engine arguments.
 * @param {{excludeVoice?:boolean, exclude?:string[]|string, only?:string}} filter
 */
export function audioFilterArgs(filter = {}) {
  const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map((s) => String(s).trim()).filter(Boolean);
  const exclude = list(filter.exclude);
  const only = list(filter.only);
  for (const name of [...exclude, ...only]) {
    if (!APP_NAME.test(name)) throw new Error(`invalid app name for audio filter: ${JSON.stringify(name.slice(0, 80))}`);
  }
  if (exclude.length > 32 || only.length > 1) throw new Error('audio filter: at most 32 excluded apps and 1 "only" app');
  const args = [];
  if (only.length) return ['--only', only[0]];   // "only" overrides exclusions
  if (filter.excludeVoice === true) args.push('--exclude-voice');
  if (exclude.length) args.push('--exclude', exclude.join(','));
  return args;
}

/** Strict wire validation; no allocations proportional to an untrusted length field. */
export function decodeAudio(payload, maxPayload = 3848) {
  if (!Buffer.isBuffer(payload) || payload.length < 12 || payload.length > maxPayload
      || payload.length > AUDIO_HEADER_BYTES + PCM_CHUNK_BYTES
      || (payload.length - AUDIO_HEADER_BYTES) % FRAME_BYTES !== 0
      || !payload.subarray(0, 4).equals(MAGIC)) return null;
  return { sequence: payload.readUInt32LE(4), pcm: payload.subarray(AUDIO_HEADER_BYTES) };
}

class AudioProcess extends EventEmitter {
  constructor({ enabled = false, platform = process.platform, spawn = spawnProcess,
    binary, maxPayload, killAfterMs = 500 } = {}) {
    super();
    this.enabled = enabled === true;
    this.platform = platform;
    this.spawn = spawn;
    this.binary = binary;
    this.maxPayload = payloadLimit(maxPayload);
    if (!Number.isInteger(killAfterMs) || killAfterMs < 1 || killAfterMs > 5000) {
      throw new RangeError('killAfterMs must be from 1 through 5000');
    }
    this.killAfterMs = killAfterMs;
    this.proc = null;
    this.stopped = false;
    this.logBytes = 0;
    this.stopPromise = null;
    this.lineBuf = '';
  }

  checkEnabled() {
    if (!this.enabled) throw new Error('Desktop audio requires explicit enabled: true');
    if (!SUPPORTED.has(this.platform)) {
      throw new Error(`Desktop audio unsupported on ${this.platform}; Linux and Windows are supported`);
    }
    if (this.stopped) throw new Error('Audio instance stopped; create a new instance');
  }

  launch(args, stdio) {
    const binary = this.binary ?? findMediaBinary();
    if (!binary) throw new Error(MEDIA_MISSING);
    const proc = this.spawn(binary, args, { shell: false, windowsHide: true, stdio });
    this.proc = proc;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    proc.stderr.on('data', data => {
      const size = Math.min(data.length, LOG_LIMIT - this.logBytes);
      if (size <= 0 || this.stopped) return;
      this.logBytes += size;
      // Engine status lines ("audio: ...") become log events; warnings are
      // surfaced separately so the UI can tell the user (e.g. Discord could
      // not be left out on this Windows version).
      this.lineBuf += data.subarray(0, size).toString('utf8');
      const lines = this.lineBuf.split(/\r?\n/);
      this.lineBuf = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const warning = /^audio: warning: (.*)$/.exec(line);
        if (warning) this.emit('warning', warning[1]);
        this.emit('log', line);
      }
    });
    const failed = err => {
      if (this.stopped) return;
      void this.stop();
      this.emit('error', new Error(`audio engine: ${err.message}`, { cause: err }));
    };
    proc.on('error', failed);
    proc.stdin?.on('error', failed); // EPIPE is an ordinary audio failure, not a crash
    proc.stdout?.on('error', failed);
    proc.stderr.on('error', failed);
    proc.on('close', (code, signal) => {
      this.proc = null;
      clearTimeout(this.killTimer);
      this.resolveClosed();
      if (!this.stopped) {
        void this.stop();
        this.emit('error', new Error(`audio engine exited unexpectedly (code=${code}, signal=${signal})`));
      }
    });
    return proc;
  }

  /** Idempotent; resolves when the child closes, escalates TERM to KILL. */
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.used = 0;
    const proc = this.proc;
    this.stopPromise = this.closed ?? Promise.resolve();
    if (proc) {
      proc.stdout?.destroy();
      proc.stdin?.destroy();
      // Register the deadline first: even a synchronous test child may close on TERM.
      this.killTimer = setTimeout(() => {
        if (this.proc === proc) proc.kill('SIGKILL');
      }, this.killAfterMs);
      this.killTimer.unref?.();
      proc.kill('SIGTERM');
    }
    return this.stopPromise;
  }
}

export class AudioCapture extends AudioProcess {
  constructor({ filter = {}, ...options } = {}) {
    super(options);
    this.filter = filter;
    this.sequence = 0;
    this.used = 0;
    this.chunkBytes = Math.min(CAPTURE_CHUNK_BYTES,
      Math.floor((this.maxPayload - AUDIO_HEADER_BYTES) / FRAME_BYTES) * FRAME_BYTES);
    this.pending = Buffer.allocUnsafe(this.chunkBytes);
    this.started = false;
  }

  /** Attach error/data/log listeners first. Validation errors throw synchronously. */
  start() {
    this.checkEnabled();
    if (this.started) throw new Error('AudioCapture already started');
    const filterArgs = audioFilterArgs(this.filter);
    this.started = true;
    let proc;
    try {
      proc = this.launch(['audio-capture', ...filterArgs], ['ignore', 'pipe', 'pipe']);
    } catch (err) { void this.stop(); throw err; }
    proc.stdout.on('data', data => {
      let offset = 0;
      while (!this.stopped && offset < data.length) {
        const n = Math.min(this.chunkBytes - this.used, data.length - offset);
        data.copy(this.pending, this.used, offset, offset + n);
        this.used += n;
        offset += n;
        if (this.used < this.chunkBytes) break;
        const packet = Buffer.allocUnsafe(AUDIO_HEADER_BYTES + this.chunkBytes);
        MAGIC.copy(packet, 0);
        packet.writeUInt32LE(this.sequence, 4);
        this.sequence = (this.sequence + 1) >>> 0;
        this.pending.copy(packet, AUDIO_HEADER_BYTES);
        this.used = 0;
        this.emit('data', packet); // listener sends immediately or drops; no retry queue
      }
    });
    return this;
  }
}

export class AudioPlayer extends AudioProcess {
  constructor(options = {}) {
    super(options);
    this.lastSequence = null;
    this.blocked = false;
  }

  /** true = submitted to the player, false = dropped. Never retry a dropped packet. */
  write(payload) {
    this.checkEnabled();
    const frame = decodeAudio(payload, this.maxPayload);
    if (!frame) return false;
    if (this.lastSequence !== null) {
      const distance = (frame.sequence - this.lastSequence) >>> 0;
      if (distance === 0 || distance >= 0x80000000) return false;
    }
    this.lastSequence = frame.sequence;
    if (!this.proc) {
      try {
        const proc = this.launch(['audio-play'], ['pipe', 'ignore', 'pipe']);
        proc.stdin.on('drain', () => { this.blocked = false; });
      } catch (err) { void this.stop(); throw err; }
    }
    const input = this.proc.stdin;
    // Respect write(false), cap the writable buffer as well, and retain no pending queue.
    if (this.blocked || input.destroyed || !input.writable
        || input.writableLength + frame.pcm.length > PCM_CHUNK_BYTES * 4) return false;
    try {
      // Copy out of the network packet so an in-flight write cannot be mutated by callers.
      this.blocked = !input.write(Buffer.from(frame.pcm));
      return true;
    } catch (err) {
      void this.stop();
      this.emit('error', new Error(`audio player input: ${err.message}`, { cause: err }));
      return false;
    }
  }
}
