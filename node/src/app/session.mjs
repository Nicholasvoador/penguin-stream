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

import { hostSession, joinSession } from '../signal/client.mjs';
import { loadOrCreateIdentity, TrustStore, fingerprint } from '../crypto/identity.mjs';
import { CHANNEL } from '../crypto/session.mjs';
import { MAX_PAYLOAD } from '../transport/peer.mjs';
import { Chunker, Reassembler } from '../media/chunker.mjs';
import { CaptureEngine, ViewEngine } from '../media/engine.mjs';
import { AudioCapture, AudioPlayer } from '../media/audio.mjs';
import { createInputValidator } from '../media/input.mjs';

export const DEFAULT_RENDEZVOUS = process.env.PENGUIN_RENDEZVOUS || 'ws://127.0.0.1:8787';

/** Builds the ICE server list from config/env. */
export function resolveIceServers(opts = {}) {
  const servers = [];
  const stun = opts.stun ?? process.env.PENGUIN_STUN;
  if (stun) {
    for (const s of String(stun).split(',').map((x) => x.trim()).filter(Boolean)) {
      servers.push({ urls: s.startsWith('stun:') ? s : `stun:${s}` });
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
    this.allowInput = opts.allowInput === true;
  }

  /**
   * @param {(info) => Promise<boolean>} approve called with { sas, fingerprint, trusted }
   */
  async start(approve) {
    const iceServers = resolveIceServers(this.opts);

    this.session = await hostSession({
      code: this.opts.code,
      rendezvousUrl: this.opts.rendezvousUrl || DEFAULT_RENDEZVOUS,
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
      sessionTimeoutMs: this.opts.sessionTimeoutMs ?? 120_000,
    });

    this.#startMedia();
    this.emit('secure', this.session.transport);
    return this.session;
  }

  #startMedia() {
    const peer = this.session.peer;

    this.engine = new CaptureEngine({
      source: this.opts.source,
      allowInput: this.allowInput,
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

    this.engine.on('stats', (s) => this.emit('stats', { ...s, ...this.stats }));
    this.engine.on('log', (m) => this.emit('log', m));
    this.engine.on('stderr', (m) => this.emit('log', `ps-media: ${m}`));
    this.engine.on('error', (e) => this.emit('error', e));
    this.engine.on('exit', ({ code }) => {
      this.emit('log', `capture engine exited (code ${code})`);
      this.close('capture ended');
    });

    // The viewer asks for a keyframe when it loses one; honour it.
    peer.on('control', (msg) => {
      if (msg?.t === 'keyframe-request') this.engine?.requestKeyframe();
    });

    const validateInput = createInputValidator();
    peer.on('input', (event) => {
      if (!this.allowInput || peer.state !== 'secure') return;
      const valid = validateInput(event);
      if (!valid) return;
      this.emit('input', valid);
      this.engine?.sendInput(valid);
    });

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
    if (this.allowInput) this.engine?.sendInput({ t: 'release_all' });
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

    this.session = await joinSession({
      code: this.opts.code,
      rendezvousUrl: this.opts.rendezvousUrl || DEFAULT_RENDEZVOUS,
      identity: this.identity.keypair,
      iceServers: resolveIceServers(this.opts),
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
      title: this.opts.title || 'penguin-stream',
      noInput: this.opts.noInput,
    });

    this.engine.on('input', (event) => {
      try { peer.sendInput(event); } catch { /* not secure / closing */ }
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
      }
    });

    peer.on('video', (payload) => {
      this.stats.bytesReceived += payload.length;
      const done = this.reassembler.push(payload);
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
      this.emit('stats', { ...this.stats, ...this.reassembler.stats });
    }, 1000);
    this._keyframeTimer.unref?.();

    return this.session;
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
