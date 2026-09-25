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

/** Optional self-hosted rendezvous. Pairing uses public Nostr relays by default. */
export const DEFAULT_RENDEZVOUS = process.env.PENGUIN_RENDEZVOUS || undefined;

export const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
  } catch { return 'unknown'; }
})();
/** Bumped whenever the peer-to-peer message formats change incompatibly. */
export const PROTOCOL_VERSION = 2;

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
    // Live-switchable: the host can grant or revoke control mid-session.
    this.permissions = { kbm: opts.allowInput === true, pad: opts.allowGamepad === true };
    this.inputStatus = null;
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

    this.session = await hostSession({
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
      sessionTimeoutMs: this.opts.sessionTimeoutMs ?? 30 * 60_000,   // how long an invitation waits for a viewer
    });

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
    });

    this.engine.on('config', (config) => {
      this.emit('log', `capturing with ${config.capture}, encoding with ${config.encoder}`);
      // The viewer needs codec parameters before it can decode anything.
      try { peer.sendControl({ t: 'media-config', config }); } catch { /* closing */ }
      this.emit('media-config', config);
    });

    this.engine.on('video', (v) => {
      if (peer.state !== 'secure') return;
      // Low-latency pacing: if SCTP queue has built up (>128KB), drop intermediate
      // non-keyframes immediately to prevent bufferbloat and latency buildup.
      if (!v.keyframe && peer.bufferedAmount > 128 * 1024) {
        this.stats.dropped++;
        return;
      }
      const chunks = this.chunker.split(v.data, { ptsUs: v.ptsUs, keyframe: v.keyframe });
      for (const chunk of chunks) {
        try {
          if (!peer.sendMedia(CHANNEL.VIDEO, chunk)) this.stats.dropped++;
        } catch {
          this.stats.dropped++;
        }
      }
      this.stats.framesSent++;
      this.stats.bytesSent += v.data.length;
    });

    this.engine.on('stats', (s) => {
      const transport = peer.transportInfo();
      this.emit('stats', { ...s, ...this.stats, transport });
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
      if (msg?.t === 'keyframe-request') this.engine?.requestKeyframe();
      if (msg?.t === 'set-bitrate' && Number.isFinite(msg.kbps) && msg.kbps >= 500 && msg.kbps <= 200000) {
        this.engine?.setBitrate(Math.round(msg.kbps));
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

    this.engine.start();
    if (this.opts.audio === true) {
      this.audio = new AudioCapture({ enabled: true, maxPayload: MAX_PAYLOAD });
      this.audio.on('error', e => this.emit('log', `audio stopped: ${e.message}`));
      this.audio.on('data', payload => {
        if (peer.state !== 'secure' || peer.bufferedAmount > 65536) return;
        try { peer.sendMedia(CHANNEL.AUDIO, payload); } catch { void this.audio?.stop(); }
      });
      try { this.audio.start(); } catch (e) {
        this.emit('log', `audio unavailable: ${e.message}`); void this.audio.stop();
      }
    }
  }

  close(reason = 'closed') {
    if (this._closed) return;
    this._closed = true;
    this.engine?.sendInput({ t: 'release_all' });
    void this.audio?.stop();
    this.engine?.stop();
    this.session?.close();
    this.emit('closed', reason);
  }
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

    this.session = await joinSession({
      code,
      rendezvousUrl: rendezvousUrl || DEFAULT_RENDEZVOUS,
      nostr: this.opts.nostr,
      identity: this.identity.keypair,
      iceServers: await iceServersFor(this.opts, (...a) => this.emit(...a)),
      iceTransportPolicy: this.opts.forceRelay ? 'relay' : 'all',
      onStatus: (s, d) => this.emit('status', s, d),
      sessionTimeoutMs: this.opts.sessionTimeoutMs ?? 120_000,
    });

    const peer = this.session.peer;

    // Surface the SAS so the human can compare it with the host's.
    this.emit('sas', { phrase: peer.sas.phrase, words: peer.sas.words });
    this.emit('secure', this.session.transport);

    // Displaying SAS is not proof the viewer verified it. Do not persist trust
    // without an explicit verification action.

    this.engine = new ViewEngine({
      title: this.opts.title || 'Penguin Stream',
      noInput: this.opts.noInput,
      sendKbm: this.opts.sendKbm,
      sendPad: this.opts.sendPad,
      lowLatency: this.opts.lowLatency,
      noVsync: this.opts.noVsync,
    });

    this.engine.on('input', (event) => {
      try { peer.sendInput(event); } catch { /* not secure / closing */ }
    });
    this.engine.on('viewer-state', (st) => {
      this.viewerState = st;
      this.emit('viewer-state', st);
      try { peer.sendControl({ t: 'viewer-state', kbm: st.kbm, pad: st.pad, pads: st.pads }); } catch { /* closing */ }
    });
    this.engine.on('exit', () => this.close('viewer window closed'));
    this.engine.on('error', (e) => this.emit('error', e));
    this.engine.start();
    if (this.opts.audio === true) {
      this.audio = new AudioPlayer({ enabled: true, maxPayload: MAX_PAYLOAD });
      this.audio.on('error', e => this.emit('log', `audio stopped: ${e.message}`));
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
      }
      checkHello(msg, (...a) => this.emit(...a));
    });
    try { peer.sendControl({ t: 'hello', app: 'penguin-stream', version: APP_VERSION, protocol: PROTOCOL_VERSION }); } catch { /* closing */ }
    expectHello(peer, (...a) => this.emit(...a));

    let lastKeyframeReq = 0;
    const requestKeyframeImmediate = () => {
      const now = Date.now();
      if (now - lastKeyframeReq > 100 && peer.state === 'secure') {
        lastKeyframeReq = now;
        try {
          peer.sendControl({ t: 'keyframe-request' });
          this.reassembler.acknowledgeKeyframe();
        } catch { /* closing */ }
      }
    };

    peer.on('video', (payload) => {
      this.stats.bytesReceived += payload.length;
      const done = this.reassembler.push(payload);
      // Fast recovery: if chunks were lost, request a fresh keyframe immediately (<100ms)
      // rather than waiting for the 1-second background poll.
      if (this.reassembler.needsKeyframe) {
        requestKeyframeImmediate();
      }
      if (!done) return;
      this.stats.framesShown++;
      this.engine.sendVideo({ ptsUs: done.ptsUs, keyframe: done.keyframe, frame: done.frame });
    });

    peer.on('closed', (reason) => this.close(reason));

    // If we are losing frames, ask for a keyframe - but rate-limited, or a
    // lossy link would turn into a keyframe storm and make things worse.
    this._keyframeTimer = setInterval(() => {
      if (this.reassembler.needsKeyframe && peer.state === 'secure') {
        try {
          peer.sendControl({ t: 'keyframe-request' });
          this.reassembler.acknowledgeKeyframe();
        } catch { /* closing */ }
      }
      const transport = peer.transportInfo();
      this.emit('stats', { ...this.stats, ...this.reassembler.stats, transport });
    }, 1000);
    this._keyframeTimer.unref?.();

    return this.session;
  }

  /** Live viewer toggles: { kbm?, pad?, capture? }. */
  setInput(state) {
    this.engine?.setInput(state);
  }

  close(reason = 'closed') {
    if (this._closed) return;
    this._closed = true;
    if (this._keyframeTimer) clearInterval(this._keyframeTimer);
    void this.audio?.stop();
    this.engine?.stop();
    this.session?.close();
    this.emit('closed', reason);
  }
}
