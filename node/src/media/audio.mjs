/** Opt-in Linux desktop audio. No processes start during import/construction. */
import { EventEmitter } from 'node:events';
import { spawn as spawnProcess, execFileSync } from 'node:child_process';

export const AUDIO_HEADER_BYTES = 8;
export const AUDIO_FORMAT = Object.freeze({ sampleRate: 48000, channels: 2, sampleBytes: 2 });
const MAGIC = Buffer.from('PA01'); // version 1 fixes the PCM format above
const FRAME_BYTES = 4;
const PCM_CHUNK_BYTES = 3840; // at most 20ms per packet
const TRANSPORT_LIMIT = 60_000; // Peer.MAX_PAYLOAD; callers should pass MAX_PAYLOAD
const LOG_LIMIT = 8192;

function payloadLimit(value = 3848) {
  if (!Number.isInteger(value) || value < 12 || value > TRANSPORT_LIMIT) {
    throw new RangeError('maxPayload must be an integer from 12 through 60000');
  }
  return value;
}

/** Fail closed: a monitor-looking name alone does not authorize microphone capture. */
export function selectDefaultMonitor(sink, sources) {
  if (typeof sink !== 'string' || !/^[A-Za-z0-9_.:-]{1,255}$/.test(sink)) {
    throw new Error('Invalid or unavailable PulseAudio default sink');
  }
  if (!Array.isArray(sources)) throw new Error('Invalid PulseAudio source inventory');
  const source = sources.find(s => s?.name === `${sink}.monitor`);
  const monitorIndex = source?.monitor_of_sink;
  const isMonitor = source?.properties?.['device.class'] === 'monitor'
    || source?.monitor_source === sink
    || (Number.isInteger(monitorIndex) && monitorIndex >= 0 && monitorIndex < 0xffffffff);
  if (!source || !isMonitor) throw new Error('Verified default sink monitor unavailable; no microphone fallback');
  return source.name;
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
    maxPayload, killAfterMs = 500 } = {}) {
    super();
    this.enabled = enabled === true;
    this.platform = platform;
    this.spawn = spawn;
    this.maxPayload = payloadLimit(maxPayload);
    if (!Number.isInteger(killAfterMs) || killAfterMs < 1 || killAfterMs > 5000) {
      throw new RangeError('killAfterMs must be from 1 through 5000');
    }
    this.killAfterMs = killAfterMs;
    this.proc = null;
    this.stopped = false;
    this.logBytes = 0;
    this.stopPromise = null;
  }

  checkEnabled() {
    if (!this.enabled) throw new Error('Desktop audio requires explicit enabled: true');
    if (this.platform !== 'linux') {
      throw new Error(`Desktop audio unsupported on ${this.platform}; only Linux PulseAudio is implemented`);
    }
    if (this.stopped) throw new Error('Audio instance stopped; create a new instance');
  }

  launch(binary, args, stdio) {
    const proc = this.spawn(binary, args, { shell: false, windowsHide: true, stdio });
    this.proc = proc;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    proc.stderr.on('data', data => {
      const size = Math.min(data.length, LOG_LIMIT - this.logBytes);
      if (size <= 0 || this.stopped) return;
      this.logBytes += size;
      this.emit('log', data.subarray(0, size).toString('utf8'));
    });
    const failed = err => {
      if (this.stopped) return;
      void this.stop();
      this.emit('error', new Error(`${binary}: ${err.message}`, { cause: err }));
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
        this.emit('error', new Error(`${binary} exited unexpectedly (code=${code}, signal=${signal})`));
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
  constructor({ source = 'default-monitor', probe = execFileSync, ...options } = {}) {
    super(options);
    this.source = source;
    this.probe = probe;
    this.sequence = 0;
    this.used = 0;
    this.chunkBytes = Math.min(PCM_CHUNK_BYTES,
      Math.floor((this.maxPayload - AUDIO_HEADER_BYTES) / FRAME_BYTES) * FRAME_BYTES);
    this.pending = Buffer.allocUnsafe(this.chunkBytes);
    this.started = false;
  }

  /** Attach error/data/log listeners first. Preflight errors throw synchronously. */
  start() {
    this.checkEnabled();
    if (this.started) throw new Error('AudioCapture already started');
    if (this.source !== 'default-monitor') {
      throw new Error('Audio source not allowed; only default-monitor is supported');
    }
    const probeOptions = { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024,
      shell: false, stdio: ['ignore', 'pipe', 'pipe'] };
    let monitor;
    try {
      const sink = this.probe('pactl', ['get-default-sink'], probeOptions).trim();
      const sources = JSON.parse(this.probe('pactl', ['-f', 'json', 'list', 'sources'], probeOptions));
      monitor = selectDefaultMonitor(sink, sources);
    } catch (err) {
      throw new Error(`Desktop audio preflight failed (pactl/PulseAudio required): ${err.message}`, { cause: err });
    }
    this.started = true;
    let proc;
    try {
      proc = this.launch('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-nostdin',
        '-thread_queue_size', '8', '-f', 'pulse', '-i', monitor, '-vn',
        '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'],
      ['ignore', 'pipe', 'pipe']);
    } catch (err) { void this.stop(); throw err; }
    proc.stdout.on('data', data => {
      // Fixed staging buffer: never concatenate arbitrary stdout chunks or queue packets.
      for (let offset = 0; offset < data.length && !this.stopped;) {
        const size = Math.min(this.chunkBytes - this.used, data.length - offset);
        data.copy(this.pending, this.used, offset, offset + size);
        this.used += size;
        offset += size;
        if (this.used !== this.chunkBytes) continue;
        const packet = Buffer.allocUnsafe(AUDIO_HEADER_BYTES + this.chunkBytes);
        MAGIC.copy(packet);
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

  /** true = submitted to ffplay, false = dropped. Never retry a dropped packet. */
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
        const proc = this.launch('ffplay', ['-hide_banner', '-loglevel', 'warning',
          '-nodisp', '-autoexit', '-noinfbuf', '-sync', 'audio', '-f', 's16le',
          '-sample_rate', '48000', '-ch_layout', 'stereo', '-i', 'pipe:0'],
        ['pipe', 'ignore', 'pipe']);
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
      this.emit('error', new Error(`ffplay input: ${err.message}`, { cause: err }));
      return false;
    }
  }
}
