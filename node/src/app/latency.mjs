/**
 * Latency measurement and control.
 *
 * Clock: every timestamp in the pipeline is a monotonic microsecond counter.
 * The C++ engine uses std::chrono::steady_clock and Node uses
 * process.hrtime - on Linux both are CLOCK_MONOTONIC, on Windows both are
 * QueryPerformanceCounter, so within one machine they agree.
 *
 * Across machines the counters have unrelated origins. ClockSync estimates the
 * offset with NTP-style ping/pong over the encrypted control channel, trusting
 * the fastest round trips (least queueing, most symmetric). The error is at
 * most half the round trip's asymmetry: well under a millisecond on a LAN, a
 * few ms over the internet. That is plenty to see where time goes.
 *
 * AdaptiveBitrate lowers the encoder bitrate as soon as the link starts to
 * queue, and creeps back up once it is clean. Too much bitrate for the path
 * never buys quality - it buys delay, because frames wait in buffers.
 */

export const nowUs = () => Number(process.hrtime.bigint() / 1000n);

export class ClockSync {
  constructor({ window = 16 } = {}) {
    this.window = window;
    this.samples = [];   // { rtt, offset }
  }

  /**
   * @param {number} t0 viewer clock when the ping left
   * @param {number} th host clock when it answered
   * @param {number} t1 viewer clock when the pong arrived
   */
  add(t0, th, t1) {
    const rtt = t1 - t0;
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 5_000_000 || !Number.isFinite(th)) return false;
    this.samples.push({ rtt, offset: th - (t0 + t1) / 2 });
    if (this.samples.length > this.window) this.samples.shift();
    return true;
  }

  get ready() { return this.samples.length >= 3; }

  /** host clock - viewer clock (µs), from the fastest recent exchange. */
  get offset() {
    if (!this.samples.length) return null;
    return this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
  }

  /** Round trip over the control channel (ms): latest and best. */
  get rttMs() { return this.samples.length ? this.samples.at(-1).rtt / 1000 : null; }
  get minRttMs() { return this.samples.length ? Math.min(...this.samples.map((s) => s.rtt)) / 1000 : null; }
}

/** Small rolling summary: avg / p95 / max of the values added since the last take(). */
export class Summary {
  constructor() { this.values = []; }
  add(v) { if (Number.isFinite(v)) this.values.push(v); }
  take() {
    const v = this.values.sort((a, b) => a - b);
    this.values = [];
    if (!v.length) return null;
    const avg = v.reduce((a, b) => a + b, 0) / v.length;
    return { avg: round(avg), p95: round(v[Math.min(v.length - 1, Math.floor(v.length * 0.95))]), max: round(v.at(-1)), n: v.length };
  }
}

const round = (x) => Math.round(x * 100) / 100;

/**
 * Host-side controller. Feed it observations; it returns a new bitrate (kbps)
 * when one should be applied, else null.
 *
 * Signals (any one is enough to back off):
 *   - send queue: bytes waiting in the SCTP buffer, as milliseconds of video
 *   - delay rise: the viewer's frame arrival delay above its recent minimum
 *   - loss: frames the viewer had to abandon
 */
export class AdaptiveBitrate {
  constructor({ maxKbps, minKbps = 1500, enabled = true } = {}) {
    this.maxKbps = maxKbps;
    this.minKbps = Math.min(minKbps, maxKbps);
    this.enabled = enabled;
    this.current = maxKbps;
    this.lastChange = 0;
    this.cleanSince = 0;
    this.queueMaxMs = 0;
    this.report = null;   // latest viewer report { delayRiseMs, lost }
  }

  setMax(kbps) {
    this.maxKbps = kbps;
    this.minKbps = Math.min(this.minKbps, kbps);
    if (this.current > kbps || !this.enabled) this.current = kbps;
  }

  /** Called for every frame sent. */
  observeQueue(bufferedBytes) {
    const ms = (bufferedBytes * 8) / this.current;   // bytes*8 / kbit/s = ms
    if (ms > this.queueMaxMs) this.queueMaxMs = ms;
  }

  observeViewer(report) { this.report = report; }

  /** Called on a timer (~every 500 ms). Returns the new kbps or null. */
  tick(now = Date.now()) {
    const queue = this.queueMaxMs;
    this.queueMaxMs = 0;
    const rep = this.report;
    this.report = null;
    if (!this.enabled) return null;

    const congested = queue > 25 || (rep && (rep.delayRiseMs > 30 || rep.lost >= 2));
    const clean = queue < 6 && (!rep || (rep.delayRiseMs < 10 && rep.lost === 0));

    if (congested) {
      this.cleanSince = 0;
      if (now - this.lastChange < 700) return null;
      // Back off harder the worse it is: queues drain only when we send less
      // than the link carries.
      const factor = queue > 80 || rep?.delayRiseMs > 80 || rep?.lost >= 6 ? 0.6 : 0.8;
      return this.#set(Math.max(this.minKbps, Math.round(this.current * factor)), now);
    }
    if (clean && this.current < this.maxKbps) {
      if (!this.cleanSince) this.cleanSince = now;
      // Probe upward slowly (+8% every ~2 s of clean link).
      if (now - this.cleanSince >= 2000 && now - this.lastChange >= 2000) {
        return this.#set(Math.min(this.maxKbps, Math.round(this.current * 1.08) + 100), now);
      }
    } else if (!clean) {
      this.cleanSince = 0;
    }
    return null;
  }

  #set(kbps, now) {
    if (Math.abs(kbps - this.current) < this.current * 0.02) return null;
    this.current = kbps;
    this.lastChange = now;
    return kbps;
  }
}

/**
 * Plain-language advice from a latency breakdown (all values in ms). Each tip
 * names the setting that fixes it, so the numbers are actionable.
 */
export function latencyTips(b = {}) {
  const tips = [];
  const fps = b.fps || 60;
  const frame = 1000 / fps;
  if (b.relayed) tips.push({ level: 'warn', text: 'The connection goes through a relay. A direct route is usually 5–30 ms faster: check the Network page, or try IPv6.' });
  if (b.queueMs > 10) tips.push({ level: 'warn', text: `Video is waiting ${Math.round(b.queueMs)} ms in the send queue: the bitrate is more than this connection carries. Lower the bitrate, or keep “Adapt bitrate to the connection” on.` });
  if (b.lostPct > 1) tips.push({ level: 'warn', text: `${b.lostPct.toFixed(1)}% of frames are lost. Use a cable instead of Wi-Fi if possible, or lower the bitrate.` });
  if (b.encodeMs > frame * 0.6) tips.push({ level: 'warn', text: `Encoding takes ${b.encodeMs.toFixed(1)} ms per frame. Lower the stream resolution, or pick a hardware encoder (NVENC/AMF/Quick Sync).` });
  if (b.captureMs > 8) tips.push({ level: 'info', text: `Capture handoff takes ${b.captureMs.toFixed(1)} ms. A higher frame rate shortens it.` });
  if (b.decodeMs > frame * 0.6) tips.push({ level: 'warn', text: `Decoding takes ${b.decodeMs.toFixed(1)} ms on the viewer. Lower the stream resolution.` });
  if (b.displayMs > 8) tips.push({ level: 'info', text: b.vsync ? 'V-Sync is on at the viewer: turn on “Lowest latency display” to save up to one refresh.' : `Frames wait ${b.displayMs.toFixed(1)} ms to be drawn. Close heavy apps on the viewer, or lower the resolution.` });
  if (fps <= 30) tips.push({ level: 'info', text: 'At 30 fps every frame is 33 ms apart. 60 or 120 fps cuts the delay between your action and the next picture.' });
  if (!tips.length && Number.isFinite(b.totalMs)) tips.push({ level: 'ok', text: 'Nothing obvious to fix: this is about as fast as this connection allows.' });
  return tips;
}
