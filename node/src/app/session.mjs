/**
 * Application layer: turns a share code into a running desktop stream.
 *
 * This is the piece the CLI and the UI both drive, so the two front ends
 * cannot drift apart in behaviour or in what they enforce.
 *
 * Security rules enforced here, not in the UI:
 *   - media never starts before the peer is SECURE (Noise done + consent given)
 *   - input is only accepted from the viewer, only while secure, and only if
 *     the host enabled it for this session
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';

import { hostSession, joinSession } from '../signal/client.mjs';
import { parseInvitation } from '../signal/code.mjs';
import { loadOrCreateIdentity, TrustStore, fingerprint } from '../crypto/identity.mjs';
import { CHANNEL } from '../crypto/session.mjs';
import { MAX_PAYLOAD } from '../transport/peer.mjs';
import { Chunker, Reassembler } from '../media/chunker.mjs';
import { CaptureEngine, ViewEngine } from '../media/engine.mjs';
import { AudioCapture, AudioPlayer } from '../media/audio.mjs';
import { createInputValidator, inputClass } from '../media/input.mjs';
import { resolveRelay, describeRelay } from '../net/relay.mjs';
import { AdaptiveBitrate, ClockSync, QueueDelay, Summary, nowUs, latencyTips } from './latency.mjs';

/** Optional self-hosted rendezvous. Pairing uses public Nostr relays by default. */
export const DEFAULT_RENDEZVOUS = process.env.PENGUIN_RENDEZVOUS || undefined;

export const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
  } catch { return 'unknown'; }
})();
/** Bumped whenever the peer-to-peer message formats change incompatibly. */
export const PROTOCOL_VERSION = 2;

const cancelled = () => Object.assign(new Error('cancelled'), { code: 'CANCELLED' });

/** Warns when the peer never introduces itself (Penguin Stream 0.9 and older). */
function expectHello(peer, emit) {
  let seen = false;
  const onControl = (msg) => { if (msg?.t === 'hello') seen = true; };
  peer.on('control', onControl);
  const timer = setTimeout(() => {
    peer.off('control', onControl);
    if (!seen && peer.state === 'secure') {
      emit('error', new Error('the other side runs an older Penguin Stream (0.9 or earlier): ' +
        'video may work but keyboard, mouse and controllers will not - update both machines'));
    }
  }, 6000);
  timer.unref?.();
}

function checkHello(msg, emit) {
  if (msg?.t !== 'hello') return;
  if (msg.protocol !== PROTOCOL_VERSION) {
    emit('error', new Error(`the other side runs Penguin Stream ${String(msg.version).slice(0, 20)} ` +
      `(protocol ${String(msg.protocol).slice(0, 5)}), this is ${APP_VERSION} (protocol ${PROTOCOL_VERSION}); ` +
      'input will not work until both sides run the same version'));
  } else {
    emit('log', `peer runs Penguin Stream ${String(msg.version).slice(0, 20)}`);
  }
}

export const DEFAULT_STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

/** Builds the ICE server list from config/env. */
export function resolveIceServers(opts = {}) {
  const servers = [];
  const stun = opts.stun ?? process.env.PENGUIN_STUN;
  if (stun === 'none' || stun === 'off' || stun === false || opts.noStun) {
    // Explicitly disabled by user (offline LAN / air-gapped)
  } else if (stun) {
    for (const s of String(stun).split(',').map((x) => x.trim()).filter(Boolean)) {
      servers.push({ urls: s.startsWith('stun:') ? s : `stun:${s}` });
    }
  } else {
    // Default high-availability public STUN servers for direct P2P NAT traversal
    for (const s of DEFAULT_STUN_SERVERS) {
      servers.push({ urls: s });
    }
  }
  const turn = opts.turn ?? process.env.PENGUIN_TURN;
  if (turn) {
    const user = opts.turnUser ?? process.env.PENGUIN_TURN_USER;
    const pass = opts.turnPassword ?? process.env.PENGUIN_TURN_PASSWORD;
    for (const s of String(turn).split(',').map((x) => x.trim()).filter(Boolean)) {
      servers.push({
        urls: s.startsWith('turn') ? s : `turn:${s}`,
        username: user,
        credential: pass,
      });
    }
  }
  return servers;
}

/**
 * STUN/TURN from options plus the saved relay. A broken relay must not stop a
 * session that could connect directly, so failures are reported, not thrown.
 */
async function iceServersFor(opts, emit) {
  const servers = resolveIceServers(opts);
  if (!opts.relay || opts.relay.mode === 'none' || !opts.relay.mode) return servers;
  try {
    const relay = await resolveRelay(opts.relay);
    emit('log', `relay ready: ${describeRelay(opts.relay)} (used only if a direct path fails)`);
    return [...servers, ...relay];
  } catch (err) {
    emit('log', `relay unavailable (${describeRelay(opts.relay)}): ${err.message} - trying direct only`);
    return servers;
  }
}

/**
 * Host: shares this machine's screen.
 *
 * Emits: 'code', 'consent-request', 'secure', 'stats', 'log', 'closed', 'error'
 */
export class Host extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.identity = loadOrCreateIdentity();
    this.trust = new TrustStore();
    this.session = null;
    this.engine = null;
    this.chunker = new Chunker({ maxPayload: MAX_PAYLOAD });
    this.stats = { framesSent: 0, bytesSent: 0, dropped: 0 };
    this.abr = new AdaptiveBitrate({
      maxKbps: opts.bitrateKbps ?? 15000,
      enabled: opts.adaptiveBitrate !== false,
    });
    this.hostLatency = { send: new Summary() };   // engine output -> handed to the network
    this.engineStats = null;
    this.viewerReport = null;
    // Live-switchable: the host can grant or revoke control mid-session.
    this.permissions = { kbm: opts.allowInput === true, pad: opts.allowGamepad === true };
    this.inputStatus = null;
    this._abort = new AbortController();   // Stop pressed while waiting/connecting
  }

  /** Grants/revokes keyboard+mouse and controller control during a session. */
  setPermissions({ kbm = this.permissions.kbm, pad = this.permissions.pad } = {}) {
    this.permissions = { kbm: kbm === true, pad: pad === true };
    this.engine?.setPermissions(this.permissions);
    this.#announcePermissions();
    this.emit('permissions', this.permissions);
  }

  #announcePermissions() {
    const peer = this.session?.peer;
    // Wait for the engine's first report so the viewer is never told
    // "unavailable" merely because the host has not finished starting.
    if (!peer || peer.state !== 'secure' || !this.inputStatus) return;
    const st = this.inputStatus;
    try {
      peer.sendControl({
        t: 'host-permissions', kbm: this.permissions.kbm, pad: this.permissions.pad,
        kbmReady: st.kbmReady === true, padReady: st.padReady === true,
        padError: typeof st.padError === 'string' ? st.padError.slice(0, 200) : '',
      });
    } catch { /* closing */ }
  }

  /**
   * @param {(info) => Promise<boolean>} approve called with { sas, fingerprint, trusted }
   */
  async start(approve) {
    const iceServers = await iceServersFor(this.opts, (...a) => this.emit(...a));
    if (this._closed) throw cancelled();

    const session = await hostSession({
      signal: this._abort.signal,
      code: this.opts.code,
      rendezvousUrl: this.opts.rendezvousUrl || DEFAULT_RENDEZVOUS,
      nostr: this.opts.nostr,
      identity: this.identity.keypair,
      iceServers,
      iceTransportPolicy: this.opts.forceRelay ? 'relay' : 'all',
      onCode: (code) => this.emit('code', code),
      onStatus: (s, d) => this.emit('status', s, d),
      onConsentRequest: async (info) => {
        const known = this.trust.get(info.remoteStatic);
        const request = {
          sas: info.sas.phrase,
          sasWords: info.sas.words,
          fingerprint: fingerprint(info.remoteStatic),
          trusted: Boolean(known),
          label: known?.label || null,
          transport: info.transport,
        };
        this.emit('consent-request', request);

        // Fail closed: if no approver was supplied, refuse.
        const ok = approve ? await approve(request) : false;
        if (ok) {
          this.trust.trust(info.remoteStatic, {
            label: this.opts.peerLabel || known?.label || 'paired viewer',
            role: 'client',
          });
        }
        return ok;
      },
      // No idle timer: an invitation waits for a viewer until the host stops
      // sharing (1.3.1 silently gave up after 30 minutes).
      sessionTimeoutMs: this.opts.sessionTimeoutMs ?? 0,
    });
    // Stop pressed in the last instant: never start capturing afterwards.
    if (this._closed) { session.close(); throw cancelled(); }
    this.session = session;

    this.#startMedia();
    this.emit('secure', this.session.transport);
    return this.session;
  }

  #startMedia() {
    const peer = this.session.peer;

    this.engine = new CaptureEngine({
      source: this.opts.source,
      display: this.opts.display,
      allowInput: this.permissions.kbm,
      allowGamepad: this.permissions.pad,
      inputCapable: this.opts.inputCapable === true || this.permissions.kbm,
      fps: this.opts.fps ?? 60,
      bitrateKbps: this.opts.bitrateKbps ?? 15000,
      encoder: this.opts.encoder,
      width: this.opts.width,
      height: this.opts.height,
      monitor: this.opts.monitor,
      workspace: this.opts.workspace,
      restoreToken: this.opts.restoreToken,
    });
    this.engine.on('restore-token', (token) => this.emit('restore-token', token));

    this.engine.on('config', (config) => {
      this.emit('log', `capturing with ${config.capture}, encoding with ${config.encoder}`);
      // The viewer needs codec parameters before it can decode anything.
      try { peer.sendControl({ t: 'media-config', config }); } catch { /* closing */ }
      this.emit('media-config', config);
    });

    this.engine.on('video', (v) => {
      if (peer.state !== 'secure') return;
      const queued = peer.bufferedAmount;
      this.abr.observeQueue(queued);
      // Never let video pile up behind the network: if more than ~2 frames'
      // worth of time is still waiting to be sent, skip this frame. Every
      // later frame references the skipped one, so sending them would only
      // show a corrupted picture: hold them back too, and ask for a fresh
      // keyframe once the queue drains. The budget is TIME at the rate we
      // really send (an encoder can overshoot a low target), with a floor of
      // one typical keyframe so a single IDR never triggers a skip.
      const rateKbps = Math.max(this.abr.sentKbps ?? 0, this.abr.current);
      const budget = Math.max(48 * 1024, (rateKbps * 1000 / 8) * (2 / (this.opts.fps ?? 60)));
      if (!v.keyframe && (queued > budget || this._awaitingKeyframe)) {
        this.stats.dropped++;
        if (!this._awaitingKeyframe) {
          this._awaitingKeyframe = true;
          this._keyframeAskedAt = 0;
        }
        const now = Date.now();
        if (queued < budget / 2 && now - this._keyframeAskedAt > 250) {
          this._keyframeAskedAt = now;
          this.engine?.requestKeyframe();
        }
        return;
      }
      if (v.keyframe) this._awaitingKeyframe = false;
      // pts = the frame's capture time on the engine's monotonic clock. Put it
      // on this process's clock (the one ping/pong syncs) before it leaves.
      const pts = Number(v.ptsUs);
      const ptsNode = pts > 0 && this.engine.clock.offset !== null ? Math.round(this.engine.clock.toNode(pts)) : 0;
      if (ptsNode > 0) this.hostLatency.send.add((nowUs() - ptsNode) / 1000);
      const chunks = this.chunker.split(v.data, { ptsUs: ptsNode > 0 ? BigInt(ptsNode) : v.ptsUs, keyframe: v.keyframe });
      for (const chunk of chunks) {
        try {
          if (!peer.sendMedia(CHANNEL.VIDEO, chunk)) this.stats.dropped++;
        } catch {
          this.stats.dropped++;
        }
      }
      this.stats.framesSent++;
      this.stats.bytesSent += v.data.length;
      this._abrBytes = (this._abrBytes ?? 0) + v.data.length;
    });

    this.engine.on('stats', (s) => {
      this.engineStats = s;
      const transport = peer.transportInfo();
      const sendMs = this.hostLatency.send.take();
      const latency = {
        captureMs: s.captureMs?.avg ?? null,
        encodeMs: s.encodeMs?.avg ?? null,
        sendMs: sendMs?.avg ?? null,           // capture -> handed to the network
        targetKbps: this.abr.current,
        queueKb: Math.round(peer.bufferedAmount / 1024),
        viewer: this.viewerReport,             // what the viewer measured (latest)
      };
      this.emit('stats', { ...s, ...this.stats, transport, latency });
      // Share host-side timings so the viewer can show the full breakdown.
      try {
        peer.sendControl({ t: 'host-stats', captureMs: latency.captureMs, encodeMs: latency.encodeMs,
          sendMs: latency.sendMs, kbps: Math.round(s.kbps ?? 0), targetKbps: this.abr.current,
          fps: Math.round(s.fps ?? 0), maxFrameBytes: s.maxFrameBytes ?? 0, dropped: this.stats.dropped });
      } catch { /* closing */ }
    });
    this.engine.on('log', (m) => this.emit('log', m));
    this.engine.on('input-status', (st) => {
      this.inputStatus = st;
      this.emit('input-status', st);
      this.#announcePermissions();
    });
    this.engine.on('rumble', ({ slot, lo, hi }) => {
      if (peer.state !== 'secure' || !this.permissions.pad) return;
      try { peer.sendControl({ t: 'rumble', slot, lo, hi }); } catch { /* closing */ }
    });
    this.engine.on('stderr', (m) => this.emit('log', `ps-media: ${m}`));
    this.engine.on('error', (e) => this.emit('error', e));
    this.engine.on('exit', ({ code }) => {
      this.emit('log', `capture engine exited (code ${code})`);
      this.close('capture ended');
    });

    // Handle control messages from viewer (keyframe requests, dynamic bitrate adjustments)
    peer.on('control', (msg) => {
      if (msg?.t === 'keyframe-request') {
        // Coalesce: several viewer requests for one loss burst need ONE IDR.
        const now = Date.now();
        if (now - (this._lastIdrAt ?? 0) >= 200) { this._lastIdrAt = now; this.engine?.requestKeyframe(); }
      }
      if (msg?.t === 'set-bitrate' && Number.isFinite(msg.kbps) && msg.kbps >= 500 && msg.kbps <= 200000) {
        this.setBitrate(Math.round(msg.kbps));
      }
      // Clock sync for the latency meter: answer with our monotonic clock.
      if (msg?.t === 'ping' && Number.isFinite(msg.t0)) {
        try { peer.sendControl({ t: 'pong', t0: msg.t0, th: nowUs() }); } catch { /* closing */ }
      }
      if (msg?.t === 'viewer-report' && (Number.isFinite(msg.delayRiseMs) || Number.isFinite(msg.qdMs))) {
        const clamp = (v, hi) => (Number.isFinite(v) ? Math.max(0, Math.min(hi, v)) : undefined);
        const rep = {
          // 1.4.0+: queue delay from the fastest frames (jitter-proof) + frame count.
          qdMs: clamp(msg.qdMs, 10000),
          frames: Number.isInteger(msg.frames) ? Math.max(0, Math.min(100000, msg.frames)) : undefined,
          rxKbps: clamp(msg.rxKbps, 1_000_000),
          // 1.3.x viewers send only this (average minus floor: includes jitter).
          delayRiseMs: clamp(msg.delayRiseMs, 10000),
          lost: Number.isInteger(msg.lost) ? Math.max(0, Math.min(100000, msg.lost)) : 0,
          totalMs: Number.isFinite(msg.totalMs) ? msg.totalMs : null,
          networkMs: Number.isFinite(msg.networkMs) ? msg.networkMs : null,
        };
        // Stats for the UI only when the report carries them (fast reports don't).
        if (rep.totalMs !== null || !this.viewerReport) this.viewerReport = rep;
        this.abr.observeViewer(rep);
      }
      if (msg?.t === 'viewer-state' && typeof msg.kbm === 'boolean' && typeof msg.pad === 'boolean') {
        this.emit('viewer-state', { kbm: msg.kbm, pad: msg.pad, pads: Number.isInteger(msg.pads) ? msg.pads : 0 });
      }
      checkHello(msg, (...a) => this.emit(...a));
    });

    const validateInput = createInputValidator();
    peer.on('input', (event) => {
      if (peer.state !== 'secure') return;
      const valid = validateInput(event);
      if (!valid || !this.permissions[inputClass(valid)]) return;
      this.emit('input', valid);
      this.engine?.sendInput(valid);
    });

    try { peer.sendControl({ t: 'hello', app: 'penguin-stream', version: APP_VERSION, protocol: PROTOCOL_VERSION }); } catch { /* closing */ }
    expectHello(peer, (...a) => this.emit(...a));
    this.#announcePermissions();

    peer.on('closed', (reason) => this.close(reason));

    // Adaptive bitrate: 4 decisions per second from the send queue, the
    // measured sending rate, the round trip and the viewer's reports.
    let abrAt = Date.now();
    this._abrTimer = setInterval(() => {
      const now = Date.now();
      this.abr.observeSent(this._abrBytes ?? 0, now - abrAt);
      this._abrBytes = 0;
      abrAt = now;
      const rtt = peer.transportInfo?.()?.rttMs;
      if (Number.isFinite(rtt)) this.abr.observeRtt(rtt);
      const kbps = this.abr.tick(now);
      if (kbps) {
        this.engine?.setBitrate(kbps);
        this.emit('log', `bitrate ${kbps >= this.abr.maxKbps ? 'restored' : 'adapted'} to ${(kbps / 1000).toFixed(1)} Mbps (${this.abr.reason})`);
      }
    }, 250);
    this._abrTimer.unref?.();

    this.engine.start();
    if (this.opts.audio === true) {
      this.audio = new AudioCapture({ enabled: true, maxPayload: MAX_PAYLOAD, filter: this.opts.audioFilter });
      this.audio.on('error', e => this.emit('log', `audio stopped: ${e.message}`));
      this.audio.on('log', line => this.emit('log', line));
      this.audio.on('warning', w => this.emit('audio-warning', w));
      this.audio.on('data', payload => {
        if (peer.state !== 'secure' || peer.bufferedAmount > 65536) return;
        try { peer.sendMedia(CHANNEL.AUDIO, payload); } catch { void this.audio?.stop(); }
      });
      try { this.audio.start(); } catch (e) {
        this.emit('log', `audio unavailable: ${e.message}`); void this.audio.stop();
      }
    }
  }

  /** Live bitrate change (UI or viewer): becomes the new ceiling for adaptation. */
  setBitrate(kbps) {
    if (!Number.isInteger(kbps) || kbps < 500 || kbps > 200000) return;
    this.opts.bitrateKbps = kbps;
    this.abr.setMax(kbps);
    this.engine?.setBitrate(this.abr.current);
  }

  setAdaptive(on) {
    this.abr.enabled = on === true;
    if (!this.abr.enabled) { this.abr.current = this.abr.maxKbps; this.engine?.setBitrate(this.abr.current); }
  }

  close(reason = 'closed') {
    if (this._closed) return;
    this._closed = true;
    this._abort.abort();
    if (this._abrTimer) clearInterval(this._abrTimer);
    this.engine?.sendInput({ t: 'release_all' });
    void this.audio?.stop();
    this.engine?.stop();
    this.session?.close();
    this.emit('closed', reason);
  }
}

/**
 * Text for the stream-window overlay. Plain ASCII (the overlay font has no
 * other glyphs); lines starting with '#' are headings, '!' warnings.
 */
export function overlayText(l, h = {}, v = {}, t = {}) {
  const f = (x) => (Number.isFinite(x) ? (x < 10 ? x.toFixed(1) : String(Math.round(x))) : '--');
  const route = t?.relayed ? 'relay' : t?.connected === false ? '--' : `direct ${t?.protocol ?? ''}`.trim();
  const lines = [
    `#Penguin Stream   ${route}   ${f(l.fps)} fps   ${l.kbps ? (l.kbps / 1000).toFixed(1) : '--'} Mbps`,
    `Total      ${f(l.totalMs).padStart(5)} ms   capture -> screen`,
    `Input      ${f(l.inputMs).padStart(5)} ms   click -> result (est.)`,
    `Host       ${f((l.captureMs ?? 0) + (l.encodeMs ?? 0)).padStart(5)} ms   capture ${f(l.captureMs)} + encode ${f(l.encodeMs)}`,
    `Network    ${f(l.networkMs).padStart(5)} ms   p95 ${f(l.networkP95Ms)}   ping ${f(l.rttMs)}`,
    `Viewer     ${f(l.viewerMs).padStart(5)} ms   decode ${f(l.decodeMs)} + display ${f(l.displayMs)}`,
    `Loss ${f(l.lostPct)}%   skipped ${h?.dropped ?? 0}   vsync ${l.vsync ? 'on' : 'off'}   target ${l.targetKbps ? (l.targetKbps / 1000).toFixed(1) : '--'} Mbps`,
  ];
  for (const tip of (l.tips ?? []).filter((x) => x.level === 'warn').slice(0, 2)) {
    lines.push(`!${tip.text.replace(/[^\x20-\x7e]/g, '').slice(0, 78)}`);
  }
  lines.push('Ctrl+Alt+Shift+S hides this');
  return lines.join('\n');
}

/**
 * Viewer: connects to a host and displays its screen.
 *
 * Emits: 'secure', 'sas', 'media-config', 'stats', 'closed', 'error'
 */
export class Viewer extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.identity = loadOrCreateIdentity();
    this.trust = new TrustStore();
    this.session = null;
    this.engine = null;
    this.reassembler = new Reassembler();
    this.stats = { framesShown: 0, bytesReceived: 0 };
    this._keyframeTimer = null;
    this.clock = new ClockSync();
    this.lat = { network: new Summary(), arrival: new Summary() };
    this.qd = new QueueDelay();   // queue delay for the host's bitrate control
    this.framesWindow = 0;        // complete frames since the last fast report
    this.hostStats = null;
    this.viewStats = null;
    this.lostWindow = 0;
    this.latency = null;
    this._abort = new AbortController();
  }

  async start() {
    if (!this.opts.code) throw new Error('a share code is required');
    let code = this.opts.code;
    let rendezvousUrl = this.opts.rendezvousUrl;
    try {
      const parsed = parseInvitation(this.opts.code);
      code = parsed.code;
      if (!rendezvousUrl && parsed.rendezvousUrl) rendezvousUrl = parsed.rendezvousUrl;
    } catch { /* keep raw */ }

    const iceServers = await iceServersFor(this.opts, (...a) => this.emit(...a));
    if (this._closed) throw cancelled();
    const session = await joinSession({
      signal: this._abort.signal,
      code,
      rendezvousUrl: rendezvousUrl || DEFAULT_RENDEZVOUS,
      nostr: this.opts.nostr,
      identity: this.identity.keypair,
      iceServers,
      iceTransportPolicy: this.opts.forceRelay ? 'relay' : 'all',
      onStatus: (s, d) => this.emit('status', s, d),
      // The words are known once the handshake completes - show them now,
      // while the host is being asked to compare them.
      onHandshake: ({ sas }) => this.emit('sas', { phrase: sas.phrase, words: sas.words }),
      // Finding the host (Nostr) + the host clicking Allow can take a while;
      // Cancel stops it at any time.
      sessionTimeoutMs: this.opts.sessionTimeoutMs ?? 180_000,
    });
    if (this._closed) { session.close(); throw cancelled(); }
    this.session = session;

    const peer = this.session.peer;

    // Surface the SAS so the human can compare it with the host's.
    this.emit('sas', { phrase: peer.sas.phrase, words: peer.sas.words });
    this.emit('secure', this.session.transport);

    // Displaying SAS is not proof the viewer verified it. Do not persist trust
    // without an explicit verification action.

    let requestKeyframe = null;   // set once the peer is wired below
    this.engine = new ViewEngine({
      title: this.opts.title || 'Penguin Stream',
      noInput: this.opts.noInput,
      sendKbm: this.opts.sendKbm,
      sendPad: this.opts.sendPad,
      lowLatency: this.opts.lowLatency,
      noVsync: this.opts.noVsync,
      overlay: this.opts.overlay === true,
    });

    this.engine.on('input', (event) => {
      try { peer.sendInput(event); } catch { /* not secure / closing */ }
    });
    this.engine.on('viewer-state', (st) => {
      this.viewerState = st;
      this.emit('viewer-state', st);
      try { peer.sendControl({ t: 'viewer-state', kbm: st.kbm, pad: st.pad, pads: st.pads }); } catch { /* closing */ }
    });
    this.engine.on('view-stats', (v) => { this.viewStats = v; });
    // The decoder saw corruption (loss the reassembler could not see, e.g. a
    // frame that arrived whole but references a lost one): recover now.
    this.engine.on('need-keyframe', () => requestKeyframe?.());
    this.engine.on('behind', ({ queuedBytes }) => this.emit('log',
      `stream window fell behind (${Math.round(queuedBytes / 1024)} KB waiting): skipping to the next keyframe - lower the resolution if this repeats`));
    this.engine.on('exit', () => this.close('viewer window closed'));
    this.engine.on('error', (e) => this.emit('error', e));
    this.engine.start();
    if (this.opts.audio === true) {
      this.audio = new AudioPlayer({ enabled: true, maxPayload: MAX_PAYLOAD });
      this.audio.on('error', e => this.emit('log', `audio stopped: ${e.message}`));
      this.audio.on('log', line => this.emit('log', line));
      peer.on('audio', payload => {
        if (peer.state !== 'secure') return;
        try { this.audio.write(payload); } catch (e) {
          this.emit('log', `audio unavailable: ${e.message}`); void this.audio.stop();
        }
      });
    }

    peer.on('control', (msg) => {
      if (msg?.t === 'media-config') {
        this.emit('media-config', msg.config);
        this.engine.sendConfig(msg.config);
      } else if (msg?.t === 'host-permissions') {
        this.hostPermissions = {
          kbm: msg.kbm === true, pad: msg.pad === true,
          kbmReady: msg.kbmReady === true, padReady: msg.padReady === true,
          padError: typeof msg.padError === 'string' ? msg.padError.slice(0, 200) : '',
        };
        this.engine.hostPermissions(this.hostPermissions);
        this.emit('host-permissions', this.hostPermissions);
      } else if (msg?.t === 'rumble') {
        this.engine.rumble(msg);
      } else if (msg?.t === 'pong' && Number.isFinite(msg.t0) && Number.isFinite(msg.th)) {
        this.clock.add(msg.t0, msg.th, nowUs());
      } else if (msg?.t === 'host-stats') {
        const num = (v) => (Number.isFinite(v) ? v : null);
        this.hostStats = {
          captureMs: num(msg.captureMs), encodeMs: num(msg.encodeMs), sendMs: num(msg.sendMs),
          kbps: num(msg.kbps), targetKbps: num(msg.targetKbps), fps: num(msg.fps),
          maxFrameBytes: num(msg.maxFrameBytes), dropped: num(msg.dropped),
        };
      }
      checkHello(msg, (...a) => this.emit(...a));
    });
    // Clock sync: a burst at start, then every 2 s (tiny, rides the control channel).
    const ping = () => { try { peer.sendControl({ t: 'ping', t0: nowUs() }); } catch { /* closing */ } };
    for (let i = 0; i < 5; i++) setTimeout(ping, 50 + i * 120).unref?.();
    this._pingTimer = setInterval(ping, 2000);
    this._pingTimer.unref?.();
    try { peer.sendControl({ t: 'hello', app: 'penguin-stream', version: APP_VERSION, protocol: PROTOCOL_VERSION }); } catch { /* closing */ }
    expectHello(peer, (...a) => this.emit(...a));

    // Keyframe requests: ask at once when a frame is lost, then wait for the
    // keyframe to arrive (or ~1.5 round trips) before asking again. Frames
    // already in flight when we asked are lost too; re-asking for each of
    // them made an IDR storm on lossy links (each IDR is 5-20x a P-frame,
    // which causes more loss). With intra refresh the picture also heals on
    // its own within a second.
    let lastKeyframeReq = 0;
    let awaitingKeyframe = false;
    const requestKeyframeImmediate = requestKeyframe = () => {
      const now = Date.now();
      const rtt = this.clock.minRttMs ?? 50;
      const wait = awaitingKeyframe ? Math.max(250, 1.5 * rtt + 100) : 100;
      if (now - lastKeyframeReq > wait && peer.state === 'secure') {
        lastKeyframeReq = now;
        awaitingKeyframe = true;
        try {
          peer.sendControl({ t: 'keyframe-request' });
          this.reassembler.acknowledgeKeyframe();
        } catch { /* closing */ }
      } else {
        this.reassembler.acknowledgeKeyframe();   // already asked; this loss is covered
      }
    };

    peer.on('video', (payload) => {
      this.stats.bytesReceived += payload.length;
      this.rxWindow = (this.rxWindow ?? 0) + payload.length;
      const droppedBefore = this.reassembler.stats.dropped;
      const done = this.reassembler.push(payload);
      this.lostWindow += Math.max(0, this.reassembler.stats.dropped - droppedBefore);
      // Fast recovery: if chunks were lost, request a fresh keyframe immediately (<100ms)
      // rather than waiting for the 1-second background poll.
      if (this.reassembler.needsKeyframe) {
        requestKeyframeImmediate();
      }
      if (!done) return;
      if (done.keyframe) awaitingKeyframe = false;
      this.stats.framesShown++;
      this.framesWindow++;
      const arrived = nowUs();
      // Queue delay needs no clock sync: (viewer now - host capture time)
      // carries a constant unknown offset that cancels against its own
      // minimum. Using the synced offset instead made the baseline jump
      // whenever a faster ping refined it - that read as "congestion".
      this.qd.add((arrived - Number(done.ptsUs)) / 1000);
      // capture (host clock) -> complete frame here (viewer clock), via the offset.
      const offset = this.clock.offset;
      if (offset !== null && this.clock.ready) {
        const ms = (arrived + offset - Number(done.ptsUs)) / 1000;
        if (ms > -50 && ms < 10000) this.lat.arrival.add(ms);
      }
      if (!this.engine.sendVideo({ ptsUs: done.ptsUs, keyframe: done.keyframe, frame: done.frame })) this.stats.viewerSkipped = (this.stats.viewerSkipped ?? 0) + 1;
    });

    peer.on('closed', (reason) => this.close(reason));

    // Fast congestion feedback for the host's bitrate control, 4x a second:
    // a queue shows up here within ~250 ms instead of up to a second.
    let reportAt = Date.now();
    this._reportTimer = setInterval(() => {
      if (peer.state !== 'secure') return;
      const now = Date.now();
      const rxKbps = Math.round(((this.rxWindow ?? 0) * 8) / Math.max(1, now - reportAt));
      this.rxWindow = 0;
      reportAt = now;
      const qdMs = this.qd.take();
      const frames = this.framesWindow, lost = this.lostWindow - (this._lostReported ?? 0);
      this.framesWindow = 0;
      this._lostReported = this.lostWindow;
      this.lastQdMs = qdMs;
      if (qdMs === null && !lost) return;
      // delayRiseMs keeps 1.3.x hosts adapting (they ignore the new fields).
      try { peer.sendControl({ t: 'viewer-report', qdMs: qdMs ?? 0, delayRiseMs: qdMs ?? 0, frames, lost: Math.max(0, lost), rxKbps }); }
      catch { /* closing */ }
    }, 250);
    this._reportTimer.unref?.();

    // If we are losing frames, ask for a keyframe - but rate-limited, or a
    // lossy link would turn into a keyframe storm and make things worse.
    this._keyframeTimer = setInterval(() => {
      if (this.reassembler.needsKeyframe && peer.state === 'secure') requestKeyframeImmediate();
      const transport = peer.transportInfo();
      this.latency = this.#latencyBreakdown(transport);
      try {
        peer.sendControl({ t: 'viewer-report', qdMs: this.lastQdMs ?? 0, delayRiseMs: this.lastQdMs ?? 0, frames: 0, lost: 0,
          totalMs: this.latency.totalMs, networkMs: this.latency.networkMs });
      } catch { /* closing */ }
      this.lostWindow = 0;
      this._lostReported = 0;
      this.emit('stats', { ...this.stats, ...this.reassembler.stats, transport, latency: this.latency });
    }, 1000);
    this._keyframeTimer.unref?.();

    return this.session;
  }

  /**
   * Capture-to-screen breakdown (ms):
   *   host:    capture handoff + encode   (measured by the host engine)
   *   network: encoded frame leaves the host engine -> complete frame here,
   *            minus the host's own queueing (clock-synced)
   *   viewer:  decode + upload + present  (measured by the viewer engine)
   */
  #latencyBreakdown(transport) {
    const arrival = this.lat.arrival.take();
    const h = this.hostStats ?? {};
    const v = this.viewStats ?? {};
    const hostMs = (h.captureMs ?? 0) + (h.encodeMs ?? 0);
    const arrivalMs = arrival?.avg ?? null;
    const networkMs = arrivalMs !== null ? Math.max(0, arrivalMs - hostMs) : null;
    const viewerMs = Number.isFinite(v.viewerMs) ? v.viewerMs : null;
    const totalMs = arrivalMs !== null && viewerMs !== null ? arrivalMs + viewerMs : null;
    const delayRiseMs = Number.isFinite(this.lastQdMs) ? this.lastQdMs : null;
    const frames = arrival?.n ?? 0;
    const lostPct = frames + this.lostWindow > 0 ? (100 * this.lostWindow) / (frames + this.lostWindow) : 0;
    // Input -> result on screen, estimated from measured parts: an input needs
    // half a round trip to reach the host, then waits on average half a frame
    // for the next capture, then takes the full capture -> screen path.
    const fps = h.fps || 60;
    const inputMs = totalMs !== null && Number.isFinite(this.clock.rttMs)
      ? this.clock.minRttMs / 2 + 500 / fps + totalMs : null;
    const out = {
      synced: this.clock.ready,
      inputMs,
      rttMs: this.clock.rttMs, minRttMs: this.clock.minRttMs,
      captureMs: h.captureMs, encodeMs: h.encodeMs,
      networkMs, networkP95Ms: arrival ? Math.max(0, arrival.p95 - hostMs) : null,
      decodeMs: Number.isFinite(v.decodeMs) ? v.decodeMs : null,
      displayMs: Number.isFinite(v.displayMs) ? v.displayMs : null,
      viewerMs, totalMs, delayRiseMs, lostPct,
      queueMs: h.sendMs !== null && h.sendMs !== undefined ? Math.max(0, h.sendMs - hostMs) : null,
      fps: h.fps, kbps: h.kbps, targetKbps: h.targetKbps, replaced: v.replaced ?? 0, vsync: v.vsync === true,
      relayed: transport?.relayed === true,
    };
    out.tips = latencyTips(out);
    this.engine?.overlay(overlayText(out, this.hostStats, this.viewStats, transport));
    return out;
  }

  /** Live viewer toggles: { kbm?, pad?, capture? }. */
  setInput(state) {
    this.engine?.setInput(state);
  }

  /** Asks the host to change the stream bitrate (kbps). */
  requestBitrate(kbps) {
    try { this.session?.peer.sendControl({ t: 'set-bitrate', kbps }); } catch { /* closing */ }
  }

  close(reason = 'closed') {
    if (this._closed) return;
    this._closed = true;
    this._abort.abort();
    if (this._keyframeTimer) clearInterval(this._keyframeTimer);
    if (this._reportTimer) clearInterval(this._reportTimer);
    if (this._pingTimer) clearInterval(this._pingTimer);
    void this.audio?.stop();
    this.engine?.stop();
    this.session?.close();
    this.emit('closed', reason);
  }
}
