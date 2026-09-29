/**
 * Adaptive bitrate against simulated links: a bottleneck with a queue, jitter
 * like busy Wi-Fi, loss, and the encoder's real behaviour (it follows the
 * target within a frame, but cannot go below ~1.4 Mbps on a busy 1080p60
 * picture - measured on NVENC, see CHANGELOG 1.4.0).
 *
 * The 1.3.1 field log that motivated this: RTT 33 ms, no send queue, no
 * skipped frames - yet the bitrate fell from 10 to 1.5 Mbps in 10 s and never
 * came back, because ordinary Wi-Fi jitter looked like congestion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AdaptiveBitrate, QueueDelay } from '../../src/app/latency.mjs';

/** Tiny deterministic PRNG so every run sees the same "Wi-Fi". */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * Runs `seconds` of a 60 fps stream through a link.
 * link(t) -> { kbps, jitterMs, lossPct } (capacity may change over time)
 */
function simulate({ seconds, link, maxKbps = 10000, encoderFloorKbps = 1400, seed = 1, rttMs = 33 }) {
  const rand = rng(seed);
  const abr = new AdaptiveBitrate({ maxKbps });
  const qd = new QueueDelay();
  const fps = 60;
  const dt = 1000 / fps;
  let linkBusyUntil = 0;       // ms: when the bottleneck finishes what it holds
  let bytesSent = 0, sentAt = 0;
  let lost = 0, frames = 0;
  const arrivals = [];         // [arrivalMs, bytes] for the viewer's received rate
  const trace = [];            // [t, target, delayMs]
  let t = 0;
  let nextTick = 250;
  for (let i = 0; i < seconds * fps; i++, t += dt) {
    const L = link(t / 1000);
    // encoder: actual size follows the target, but never below its floor
    const kbps = Math.max(abr.current, encoderFloorKbps) * (0.9 + 0.2 * rand());
    const bytes = (kbps * 1000 / 8) / fps;
    // bottleneck queue (FIFO at L.kbps)
    const start = Math.max(t, linkBusyUntil);
    const txMs = (bytes * 8) / L.kbps;
    linkBusyUntil = start + txMs;
    const queuedBytes = Math.max(0, (linkBusyUntil - t - txMs)) * L.kbps / 8;
    abr.observeQueue(Math.min(queuedBytes, 256 * 1024) * 0);   // bottleneck is downstream: host queue stays ~0
    bytesSent += bytes;
    const jitter = L.jitterMs * rand() ** 3;                   // mostly small, sometimes big
    const delay = (linkBusyUntil - t) + rttMs / 2 + jitter;
    const dropped = rand() * 100 < L.lossPct || delay > 2000;
    if (dropped) lost++; else { frames++; qd.add(delay + 12345); arrivals.push([t + delay, bytes]); }   // +offset: raw delay has an unknown constant
    trace.push([t, abr.current, delay]);
    if (t >= nextTick) {
      nextTick += 250;
      abr.observeSent(bytesSent, t - sentAt);
      bytesSent = 0; sentAt = t;
      abr.observeRtt(rttMs);
      const q = qd.take(t);
      let rxBytes = 0;
      while (arrivals.length && arrivals[0][0] <= t) rxBytes += arrivals.shift()[1];
      const rxKbps = (rxBytes * 8) / 250;
      if (q !== null || lost) abr.observeViewer({ qdMs: q ?? 0, frames, lost, rxKbps });
      frames = 0; lost = 0;
      const k = abr.tick(t);
      void k;
    }
  }
  return { abr, trace };
}

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const window = (trace, from, to) => trace.filter(([t]) => t >= from * 1000 && t < to * 1000);

test('Wi-Fi jitter alone (the field case) does not collapse the bitrate', () => {
  // Plenty of capacity (50 Mbps), 0-60 ms jitter spikes, 0.3 % loss.
  const { abr, trace } = simulate({ seconds: 60, link: () => ({ kbps: 50_000, jitterMs: 60, lossPct: 0.3 }) });
  const late = window(trace, 30, 60).map(([, k]) => k);
  assert.ok(Math.min(...late) >= 8000, `stayed high on a jittery but uncongested link (min ${Math.min(...late)})`);
  assert.ok(abr.current >= 9000, `ends near the ceiling (${abr.current})`);
});

test('a real bottleneck is found fast and delay stays low', () => {
  // 6 Mbps uplink under a 10 Mbps ceiling.
  const { trace } = simulate({ seconds: 40, link: () => ({ kbps: 6000, jitterMs: 5, lossPct: 0 }) });
  // Within 3 s the target is at or below the capacity...
  const early = window(trace, 3, 5).map(([, k]) => k);
  assert.ok(Math.max(...early) <= 6500, `backed off within 3 s (max ${Math.max(...early)})`);
  // ...and at steady state the queue delay stays small: latency first.
  const steady = window(trace, 10, 40).map(([, , d]) => d);
  const p95 = steady.sort((a, b) => a - b)[Math.floor(steady.length * 0.95)];
  assert.ok(p95 < 33 / 2 + 60, `p95 one-way delay ${p95.toFixed(1)} ms stays near the base delay`);
  // ...while still using most of the link (no collapse to the floor).
  const rate = avg(window(trace, 10, 40).map(([, k]) => k));
  assert.ok(rate >= 3500, `uses the link (${rate.toFixed(0)} kbps average)`);
});

test('recovers quickly after a temporary squeeze', () => {
  // 25 Mbps link that drops to 3 Mbps for 5 s (someone starts a download).
  const link = (s) => ({ kbps: s >= 10 && s < 15 ? 3000 : 25_000, jitterMs: 8, lossPct: 0 });
  const { trace } = simulate({ seconds: 40, link });
  const squeezed = window(trace, 12, 15).map(([, k]) => k);
  assert.ok(Math.max(...squeezed) <= 4000, `backed off during the squeeze (max ${Math.max(...squeezed)})`);
  const after = window(trace, 15, 40);
  const back = after.find(([, k]) => k >= 9000);
  assert.ok(back, 'returned to the ceiling');
  assert.ok(back[0] / 1000 - 15 <= 15, `back to >=9 Mbps ${(back[0] / 1000 - 15).toFixed(1)} s after the squeeze ended`);
  // ...and the queue built during the squeeze is gone within ~2 s of it starting
  const worst = Math.max(...window(trace, 12.5, 15).map(([, , d]) => d));
  assert.ok(worst < 250, `queue drained during the squeeze (worst one-way delay ${worst.toFixed(0)} ms)`);
});

test('an encoder that overshoots a low target does not pin the bitrate at the floor', () => {
  // 1.3.1 kept cutting a 1.5 Mbps target the encoder was not meeting.
  const { abr } = simulate({ seconds: 60, link: () => ({ kbps: 30_000, jitterMs: 15, lossPct: 0.2 }), encoderFloorKbps: 5000 });
  assert.ok(abr.current >= 8000, `bitrate recovers (${abr.current})`);
});

test('bitrate changes are sparse (each one costs an NVENC keyframe)', () => {
  const { trace } = simulate({ seconds: 60, link: (s) => ({ kbps: 8000 + 4000 * Math.sin(s / 6), jitterMs: 20, lossPct: 0.5 }) });
  let changes = 0;
  for (let i = 1; i < trace.length; i++) if (trace[i][1] !== trace[i - 1][1]) changes++;
  assert.ok(changes <= 40, `${changes} changes in 60 s`);
});

test('QueueDelay: the unknown clock offset cancels, jitter does not count, a queue does', () => {
  const q = new QueueDelay();
  let t = 0;
  for (let i = 0; i < 40; i++, t += 250) {        // 10 s: base 20 ms + jitter up to 40 ms, offset 1e6
    for (let f = 0; f < 15; f++) q.add(1e6 + 20 + (f % 5 === 0 ? 0 : 40 * Math.random()));
    const v = q.take(t);
    if (i > 2) assert.ok(v < 3, `jitter is not queueing (${v})`);
  }
  for (let f = 0; f < 15; f++) q.add(1e6 + 20 + 70 + Math.random() * 10);   // every frame 70 ms late
  assert.ok(q.take(t) >= 69, 'a standing queue is seen at once');
});
