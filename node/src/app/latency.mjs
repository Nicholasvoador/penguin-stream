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
 * queue, and comes back once it is clean. Too much bitrate for the path
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
 * Host-side adaptive bitrate: keeps the stream just under what the path
 * carries, because a bitrate the path cannot carry does not buy quality - it
 * buys delay (frames wait in buffers). Latency first, quality second.
 *
 * Signals, strongest first:
 *   - send queue: bytes waiting to leave this machine, in ms at the rate we
 *     actually send (the SCTP buffer is small, so this is visible at once)
 *   - queue delay (viewer): how much the FASTEST frames of the last 250 ms
 *     arrived later than the fastest frames of the last ~10 s. Wi-Fi jitter
 *     spreads the distribution but leaves its minimum alone; a real queue
 *     delays every frame. (1.3.1 compared the average with the minimum, so
 *     ordinary Wi-Fi jitter looked like congestion and the bitrate collapsed
 *     to the floor and stayed there.)
 *   - loss: the share of frames that never arrived complete
 *
 * Reaction: decrease fast - straight below the rate the viewer actually
 * receives while a queue stands (that IS the link's rate), else from the rate
 * really sent - and hold for about one round trip so one congestion episode
 * is not punished twice. Then come back: at once to just below the capacity
 * found, carefully around it, and with growing steps once it has clearly
 * been beaten. Changes are sparse and at least 6% apart (every bitrate change
 * costs an NVENC keyframe).
 */
export class AdaptiveBitrate {
  constructor({ maxKbps, minKbps = 1500, enabled = true } = {}) {
    this.maxKbps = maxKbps;
    this.minKbps = Math.min(minKbps, maxKbps);
    this.enabled = enabled;
    this.current = maxKbps;
    this.lastChange = -Infinity;
    this.lastDecrease = -Infinity;
    this.cleanSince = 0;
    this.queueMaxMs = 0;
    this.reports = [];        // viewer reports since the last tick
    this.sentKbps = null;     // measured sending rate (EWMA)
    this.capacity = null;     // what the link delivered when it last congested
    this.capacityAt = 0;
    this.inEpisode = false;   // inside one congestion episode
    this.probeStep = 0;       // consecutive clean probes above the known capacity
    this.rttMs = null;
    this.firstTick = null;
    this.reason = '';         // why the last change happened (for the log)
  }

  setMax(kbps) {
    this.maxKbps = kbps;
    this.minKbps = Math.min(this.minKbps, kbps);
    if (this.current > kbps || !this.enabled) this.current = kbps;
  }

  /** Bytes handed to the network over `ms` milliseconds. */
  observeSent(bytes, ms) {
    if (!(ms > 0) || !(bytes >= 0)) return;
    const kbps = (bytes * 8) / ms;
    this.sentKbps = this.sentKbps === null ? kbps : this.sentKbps * 0.6 + kbps * 0.4;
  }

  observeRtt(ms) { if (Number.isFinite(ms) && ms >= 0 && ms < 5000) this.rttMs = ms; }

  /** Called for every frame sent, with the bytes still queued for sending. */
  observeQueue(bufferedBytes) {
    const rate = Math.max(this.sentKbps ?? 0, this.current, 1);
    const ms = (bufferedBytes * 8) / rate;   // bytes*8 / kbit/s = ms
    if (ms > this.queueMaxMs) this.queueMaxMs = ms;
  }

  /**
   * Viewer report. v2 (1.4.0+): { qdMs, lost, frames, rxKbps }. v1 (1.3.x)
   * only has { delayRiseMs, lost }, an average-minus-minimum that includes
   * jitter, so it is discounted heavily.
   */
  observeViewer(report) { if (report) this.reports.push(report); }

  #viewerSignal() {
    const reps = this.reports;
    this.reports = [];
    if (!reps.length) return null;
    let qd = 0, lost = 0, frames = 0, v2 = false, rx = null;
    for (const r of reps) {
      if (Number.isFinite(r.qdMs)) { v2 = true; qd = Math.max(qd, r.qdMs); }
      else if (Number.isFinite(r.delayRiseMs)) qd = Math.max(qd, r.delayRiseMs - 30);
      lost += Number.isFinite(r.lost) ? r.lost : 0;
      frames += Number.isFinite(r.frames) ? r.frames : 0;
      if (Number.isFinite(r.rxKbps) && r.rxKbps > 0) rx = rx === null ? r.rxKbps : Math.max(rx, r.rxKbps);
    }
    // v1 reports carry no frame count: assume a second of 60 fps each.
    if (!v2 && !frames) frames = 60 * reps.length;
    return { qd: Math.max(0, qd), lost, rx, lossPct: lost + frames > 0 ? (100 * lost) / (lost + frames) : 0 };
  }

  /** Called on a timer (~every 250 ms). Returns the new kbps or null. */
  tick(now = Date.now()) {
    const queue = this.queueMaxMs;
    this.queueMaxMs = 0;
    const rep = this.#viewerSignal();
    if (!this.enabled) return null;
    if (this.firstTick === null) this.firstTick = now;
    // The viewer's delay baseline needs a moment to form after the start.
    const warm = now - this.firstTick >= 2000;
    const qd = warm && rep ? rep.qd : 0;
    const lossPct = rep && rep.lost >= 2 ? rep.lossPct : 0;

    const severe = queue > 60 || qd > 80 || lossPct > 10;
    const congested = severe || queue > 15 || qd > 25 || lossPct > 3;
    const clean = queue < 5 && qd < 10 && lossPct < 1;

    if (congested) {
      this.cleanSince = 0;
      this.probeStep = 0;
      const sent = this.sentKbps && this.sentKbps > 0 ? this.sentKbps : this.current;
      // While a queue stands, what the viewer receives IS the link's rate.
      const rx = rep?.rx && qd > 25 ? rep.rx : null;
      if (!this.inEpisode) {
        this.inEpisode = true;
        this.capacity = Math.max(this.minKbps, rx ?? sent * 0.95);
      } else if (rx !== null) {
        this.capacity = Math.max(this.minKbps, Math.min(this.capacity, rx));
      }
      this.capacityAt = now;
      // One round trip (plus a little) for the last change to take effect.
      const hold = Math.max(400, 2 * (this.rttMs ?? 50) + 150);
      if (now - this.lastDecrease < hold) return null;
      // Back off from what really goes out (an encoder can overshoot a low
      // target; cutting a target it already misses changes nothing). With the
      // link rate known, go straight below it - far enough below that a
      // standing queue drains in about a second.
      const base = Math.min(this.current, Math.max(sent, this.current * 0.5));
      let next = base * (severe ? 0.65 : 0.85);
      if (rx !== null) next = Math.min(next, rx * (qd > 200 ? 0.6 : qd > 80 ? 0.75 : 0.85));
      const why = queue > 15 ? `send queue ${Math.round(queue)} ms` : qd > 25 ? `queue delay ${Math.round(qd)} ms`
        : `${lossPct.toFixed(1)}% frames lost`;
      const k = this.#set(Math.max(this.minKbps, Math.round(next)), now, why, 0.03);
      if (k !== null) this.lastDecrease = now;
      return k;
    }
    if (!clean) { this.cleanSince = 0; return null; }
    this.inEpisode = false;
    if (this.current >= this.maxKbps) return null;
    if (!this.cleanSince) this.cleanSince = now;
    const cleanFor = now - this.cleanSince;
    const sinceChange = now - this.lastChange;
    const known = this.capacity !== null && now - this.capacityAt < 20_000 ? this.capacity : null;
    if (known !== null && this.current < known * 0.85) {
      // Well below what the link carried a moment ago: come back at once.
      if (cleanFor >= 750 && sinceChange >= 1000) {
        return this.#set(Math.min(this.maxKbps, Math.round(Math.max(this.current * 1.2, known * 0.85))), now, 'link clear, recovering');
      }
      return null;
    }
    // Near or above the last known capacity: probe. Small steps while the
    // estimate may be right, growing steps once it has clearly been beaten
    // (the squeeze is over - get back to full quality quickly).
    if (known !== null && this.current < known * 1.15) {
      if (cleanFor >= 2000 && sinceChange >= 2000) {
        return this.#set(Math.min(this.maxKbps, Math.round(this.current * 1.1) + 100), now, 'link clear, probing up');
      }
      return null;
    }
    if (cleanFor >= 1500 && sinceChange >= 1500) {
      const factor = [1.15, 1.25, 1.4, 1.6][Math.min(3, this.probeStep++)];
      return this.#set(Math.min(this.maxKbps, Math.round(this.current * factor) + 100), now, 'link clear, probing up');
    }
    return null;
  }

  #set(kbps, now, reason, minStep = 0.06) {
    if (kbps === this.current) return null;
    if (Math.abs(kbps - this.current) < this.current * minStep && kbps !== this.maxKbps && kbps !== this.minKbps) return null;
    this.current = kbps;
    this.lastChange = now;
    this.reason = reason;
    return kbps;
  }
}

/**
 * Viewer side of the queue-delay signal. Feed it the raw one-way delay of
 * every complete frame (viewer clock now - host capture time; the unknown
 * clock offset between the machines cancels out), take() every ~250 ms.
 */
export class QueueDelay {
  constructor({ baselineMs = 10_000 } = {}) {
    this.baselineMs = baselineMs;
    this.windowMin = Infinity;
    this.ring = [];           // [{ t, v }] window minima within baselineMs
  }

  add(rawMs) { if (Number.isFinite(rawMs) && rawMs < this.windowMin) this.windowMin = rawMs; }

  /** @returns {number|null} ms the fastest recent frames are late vs. the baseline */
  take(now = Date.now()) {
    const w = this.windowMin;
    this.windowMin = Infinity;
    if (!Number.isFinite(w)) return null;
    this.ring.push({ t: now, v: w });
    while (this.ring.length && now - this.ring[0].t > this.baselineMs) this.ring.shift();
    let base = Infinity;
    for (const e of this.ring) if (e.v < base) base = e.v;
    return Math.max(0, w - base);
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
