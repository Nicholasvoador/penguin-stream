/**
 * Peer connection: ICE/DTLS/SCTP from libdatachannel, with our Noise session
 * layered on top and an explicit consent gate before any media flows.
 *
 * Two data channels, because they need different reliability:
 *   ctl   - reliable, ordered. Handshake, consent, input, control messages.
 *   media - unreliable, unordered. Video/audio. A late frame is worse than a
 *           lost one, so we never retransmit.
 *
 * Connection sequence (client initiates):
 *   ICE/DTLS connect -> ctl opens -> Noise XX (3 messages) -> SAS computed
 *   -> host consent -> 'secure' -> media allowed
 */

import { EventEmitter } from 'node:events';
import dc from 'node-datachannel';

import { HandshakeState } from '../crypto/noise.mjs';
import { SecureSession, CHANNEL } from '../crypto/session.mjs';
import { deriveSAS } from '../crypto/sas.mjs';

export const PeerState = Object.freeze({
  NEW: 'new',
  CONNECTING: 'connecting',
  HANDSHAKING: 'handshaking',
  AWAITING_CONSENT: 'awaiting-consent',
  SECURE: 'secure',
  CLOSED: 'closed',
  FAILED: 'failed',
});

/** Largest app payload we hand to SCTP in one message. */
export const MAX_PAYLOAD = 60_000;

let loggerReady = false;
function initLogger(level = 'error') {
  if (loggerReady) return;
  try { dc.initLogger(level); } catch { /* signature varies by build; non-fatal */ }
  try {
    // Ultra-low latency SCTP settings:
    // delayedSackTime: 0 disables delayed SACK timers (eliminating up to 200ms of ACK delay)
    // 4MB send/recv buffers prevent keyframe bursts from stalling the SCTP queue
    dc.setSctpSettings({
      recvBufferSize: 4 * 1024 * 1024,
      sendBufferSize: 4 * 1024 * 1024,
      maxChunksOnQueue: 8192,
      delayedSackTime: 0,
    });
  } catch { /* non-fatal on non-supported libdatachannel builds */ }
  loggerReady = true;
}

/**
 * @param {Array<string|{urls?:string,hostname?:string,port?:number,username?:string,password?:string,credential?:string}>} servers
 * @returns {Array} shape libdatachannel expects
 */
// libjuice (node-datachannel's ICE agent) relays over UDP only and keeps at
// most two relay entries; TCP/TLS TURN URLs would only produce errors.
const MAX_TURN_SERVERS = 2;

export function normalizeIceServers(servers = []) {
  const out = [];
  let turns = 0;
  for (const s of servers) {
    if (typeof s === 'string') { out.push(s); continue; }
    if (s.hostname && s.port) {
      if (s.relayType && s.relayType !== 'TurnUdp') continue;
      if (s.relayType && turns++ >= MAX_TURN_SERVERS) continue;
      out.push({
        hostname: s.hostname,
        port: s.port,
        ...(s.username ? { username: s.username } : {}),
        ...(s.password || s.credential ? { password: s.password || s.credential } : {}),
        ...(s.relayType ? { relayType: s.relayType } : {}),
      });
      continue;
    }
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls || s.url];
    for (const url of urls) {
      if (typeof url !== 'string') continue;
      const m = /^(stun|turn|turns):(\[[0-9a-f:.]+\]|[^:?]+)(?::(\d+))?(?:\?transport=(udp|tcp))?/i.exec(url);
      if (!m) continue;
      const [, rawScheme, rawHost, port, transport] = m;
      const scheme = rawScheme.toLowerCase();
      const host = rawHost.replace(/^\[|\]$/g, '');
      const entry = { hostname: host, port: port ? Number(port) : (scheme === 'turns' ? 5349 : 3478) };
      if (scheme.startsWith('turn')) {
        if (scheme === 'turns' || transport?.toLowerCase() === 'tcp' || entry.port === 53) continue;
        if (turns++ >= MAX_TURN_SERVERS) continue;
        entry.relayType = 'TurnUdp';
        if (s.username) entry.username = s.username;
        if (s.credential || s.password) entry.password = s.credential || s.password;
      }
      out.push(entry);
    }
  }
  return out;
}

export class Peer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {boolean} opts.initiator true on the connecting (viewer) side
   * @param {{privateKey:object, pub:Buffer}} opts.identity static keypair
   * @param {Buffer} opts.prologue binds the handshake to the share code
   * @param {Array} [opts.iceServers]
   * @param {'all'|'relay'} [opts.iceTransportPolicy]
   * @param {(info) => Promise<boolean>} [opts.onConsentRequest] responder-side gate
   * @param {number} [opts.handshakeTimeoutMs]
   */
  constructor({
    initiator,
    identity,
    prologue,
    iceServers = [],
    iceTransportPolicy = 'all',
    onConsentRequest = null,
    handshakeTimeoutMs = 30_000,
    name = initiator ? 'client' : 'host',
  }) {
    super();
    initLogger();

    this.initiator = initiator;
    this.name = name;
    this.state = PeerState.NEW;
    this.session = null;
    this.sas = null;
    this.remoteStatic = null;
    this.onConsentRequest = onConsentRequest;
    this.iceTransportPolicy = iceTransportPolicy;

    this.handshake = new HandshakeState({
      initiator,
      staticKeypair: identity,
      prologue,
    });

    // Note: enableIceUdpMux is deliberately NOT set. It binds a single shared
    // UDP port, which makes two peers in one process collide and never
    // connect (verified). We have at most a couple of connections per
    // process, so the mux buys us nothing.
    this.pc = new dc.PeerConnection(name, {
      iceServers: normalizeIceServers(iceServers),
      iceTransportPolicy,
    });

    this.ctl = null;
    this.media = null;
    this._closed = false;
    this._consentSent = false;
    this._remoteDescriptionSet = false;
    this._pendingCandidates = [];

    this._hsTimer = setTimeout(() => {
      if (this.state !== PeerState.SECURE && !this._closed) {
        this._fail(new Error(`handshake timed out after ${handshakeTimeoutMs}ms in state ${this.state}`));
      }
    }, handshakeTimeoutMs);
    this._hsTimer.unref?.();

    this._wirePeerConnection();
    if (initiator) this._createChannels();
  }

  /* ------------------------------ wiring ------------------------------ */

  _wirePeerConnection() {
    this.pc.onLocalDescription((sdp, type) => this.emit('signal', { kind: 'sdp', sdp, type }));
    this.pc.onLocalCandidate((candidate, mid) => this.emit('signal', { kind: 'candidate', candidate, mid }));

    this.pc.onStateChange((s) => {
      this.emit('ice-state', s);
      if (s === 'connecting' && this.state === PeerState.NEW) this._setState(PeerState.CONNECTING);
      if (s === 'failed') this._fail(new Error('ICE connection failed'));
      if (s === 'closed' && !this._closed) this._setState(PeerState.CLOSED);
    });

    this.pc.onGatheringStateChange((s) => this.emit('gathering-state', s));

    if (!this.initiator) {
      this.pc.onDataChannel((channel) => {
        const label = channel.getLabel();
        if (label === 'ctl') this._attachCtl(channel);
        else if (label === 'media') this._attachMedia(channel);
        else channel.close();
      });
    }
  }

  _createChannels() {
    this._attachCtl(this.pc.createDataChannel('ctl', { ordered: true, protocol: 'penguin-ctl-1' }));
    this._attachMedia(this.pc.createDataChannel('media', {
      ordered: false,
      maxRetransmits: 0,
      protocol: 'penguin-media-1',
    }));
  }

  _attachCtl(channel) {
    this.ctl = channel;
    channel.onOpen(() => {
      this._setState(PeerState.HANDSHAKING);
      this.emit('ctl-open');
      // The Noise initiator speaks first.
      if (this.initiator) this._send(this.handshake.writeMessage(Buffer.alloc(0)));
    });
    channel.onMessage((msg) => this._onCtlMessage(msg));
    channel.onClosed(() => { if (!this._closed) this.close('control channel closed'); });
    channel.onError((e) => this._fail(new Error(`control channel error: ${e}`)));
  }

  _attachMedia(channel) {
    this.media = channel;
    channel.onOpen(() => this.emit('media-open'));
    channel.onMessage((msg) => this._onMediaMessage(msg));
    channel.onError((e) => this.emit('warning', `media channel error: ${e}`));
  }

  _send(buf) {
    // node-datachannel wants a Buffer for binary sends.
    this.ctl.sendMessageBinary(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  }

  /* --------------------------- handshake ------------------------------ */

  async _onCtlMessage(msg) {
    const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
    try {
      if (!this.handshake.done || !this.session) {
        await this._onHandshakeMessage(buf);
        return;
      }
      const { channel, plaintext } = this.session.open(buf);
      this._dispatchSecure(channel, plaintext);
    } catch (err) {
      this._fail(err);
    }
  }

  async _onHandshakeMessage(buf) {
    if (this.initiator) {
      // Expecting message 2, after which we can finish with message 3.
      this.handshake.readMessage(buf);
      this._send(this.handshake.writeMessage(Buffer.alloc(0)));
      this._completeHandshake();
      // Initiator waits for the responder's consent verdict before going live.
      this._setState(PeerState.AWAITING_CONSENT);
      return;
    }

    if (!this.handshake.done && this.handshake.step === 0) {
      this.handshake.readMessage(buf);            // message 1
      this._send(this.handshake.writeMessage(Buffer.alloc(0))); // message 2
      return;
    }

    this.handshake.readMessage(buf);              // message 3
    this._completeHandshake();
    await this._runConsentGate();
  }

  _completeHandshake() {
    this.session = new SecureSession(this.handshake.split());
    this.remoteStatic = this.handshake.remoteStatic;
    this.sas = deriveSAS(this.handshake.handshakeHash);
    clearTimeout(this._hsTimer);
    this.emit('handshake-complete', {
      sas: this.sas,
      remoteStatic: this.remoteStatic,
      transport: this.transportInfo(),
    });
  }

  /**
   * Responder side. Media must not flow until this resolves true. A thrown
   * or falsy result closes the connection — fail closed.
   */
  async _runConsentGate() {
    this._setState(PeerState.AWAITING_CONSENT);
    let approved = false;
    let reason = 'declined';
    try {
      approved = this.onConsentRequest
        ? await this.onConsentRequest({
            sas: this.sas,
            remoteStatic: this.remoteStatic,
            transport: this.transportInfo(),
          })
        : false;
    } catch (err) {
      approved = false;
      reason = `consent handler failed: ${err.message}`;
    }

    if (!approved) {
      this._sendSecure(CHANNEL.CONTROL, { t: 'consent', ok: false, reason });
      this.emit('consent-denied', reason);
      setTimeout(() => this.close('consent denied'), 50); // let the record flush
      return;
    }

    this._sendSecure(CHANNEL.CONTROL, { t: 'consent', ok: true });
    this._setState(PeerState.SECURE);
  }

  _dispatchSecure(channel, plaintext) {
    if (channel === CHANNEL.CONTROL) {
      let msg;
      try { msg = JSON.parse(plaintext.toString('utf8')); }
      catch { return this.emit('warning', 'malformed control message'); }

      if (msg.t === 'consent') {
        if (!msg.ok) {
          this.emit('consent-denied', msg.reason || 'declined by host');
          this.close('consent denied by host');
          return;
        }
        this._setState(PeerState.SECURE);
        return;
      }
      this.emit('control', msg);
      return;
    }

    if (channel === CHANNEL.INPUT) {
      // Only the viewer may drive input, and only once consent is granted.
      if (this.state !== PeerState.SECURE) {
        return this.emit('warning', 'input received before consent; dropped');
      }
      if (this.initiator) {
        return this.emit('warning', 'viewer received an input record; dropped');
      }
      try { this.emit('input', JSON.parse(plaintext.toString('utf8'))); }
      catch { this.emit('warning', 'malformed input record'); }
      return;
    }

    if (channel === CHANNEL.STATS) {
      try { this.emit('stats', JSON.parse(plaintext.toString('utf8'))); }
      catch { /* ignore */ }
      return;
    }

    this.emit('record', { channel, plaintext });
  }

  _onMediaMessage(msg) {
    if (!this.session) return; // pre-handshake noise; ignore
    const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
    try {
      const { channel, plaintext, seq } = this.session.open(buf);
      if (this.state !== PeerState.SECURE) return; // not consented yet
      if (channel === CHANNEL.VIDEO) this.emit('video', plaintext, seq);
      else if (channel === CHANNEL.AUDIO) this.emit('audio', plaintext, seq);
    } catch (err) {
      // A forged or replayed media packet is not fatal; count and move on.
      this.emit('media-reject', err.message);
    }
  }

  /* ------------------------------- api -------------------------------- */

  _sendSecure(channel, obj) {
    if (!this.session) throw new Error('session not established');
    const pt = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj), 'utf8');
    this._send(this.session.seal(channel, pt));
  }

  /** Reliable, ordered. Throws if the session is not secure. */
  sendControl(obj) {
    this._requireSecure();
    this._sendSecure(CHANNEL.CONTROL, obj);
  }

  sendInput(event) {
    this._requireSecure();
    if (!this.initiator) throw new Error('only the viewer may send input');
    this._sendSecure(CHANNEL.INPUT, event);
  }

  sendStats(obj) {
    if (this.state !== PeerState.SECURE) return;
    this._sendSecure(CHANNEL.STATS, obj);
  }

  /**
   * Unreliable media send. Payload must already be <= MAX_PAYLOAD; chunking is
   * the media layer's job because only it knows frame boundaries.
   * @returns {boolean} false if the channel is not writable right now
   */
  sendMedia(channel, payload) {
    this._requireSecure();
    if (payload.length > MAX_PAYLOAD) {
      throw new Error(`media payload ${payload.length} exceeds MAX_PAYLOAD ${MAX_PAYLOAD}`);
    }
    if (!this.media || !this.media.isOpen()) return false;
    this.media.sendMessageBinary(this.session.seal(channel, payload));
    return true;
  }

  get bufferedAmount() {
    try { return this.media?.bufferedAmount?.() ?? 0; } catch { return 0; }
  }

  _requireSecure() {
    if (this.state !== PeerState.SECURE) {
      throw new Error(`connection is '${this.state}', not secure`);
    }
  }

  /**
   * Feed a signaling message received from the rendezvous channel.
   *
   * Candidates routinely arrive before the SDP they belong to, because both
   * travel as separate rendezvous messages and trickling starts immediately.
   * Handing one to libdatachannel early throws a Napi error that aborts the
   * whole process, so queue until the remote description lands.
   */
  applySignal(sig) {
    if (this._closed) return;
    try {
      if (sig.kind === 'sdp') {
        this.pc.setRemoteDescription(sig.sdp, sig.type);
        this._remoteDescriptionSet = true;
        const queued = this._pendingCandidates;
        this._pendingCandidates = [];
        for (const c of queued) this._addCandidate(c);
      } else if (sig.kind === 'candidate') {
        if (!this._remoteDescriptionSet) this._pendingCandidates.push(sig);
        else this._addCandidate(sig);
      }
    } catch (err) {
      this.emit('warning', `failed to apply ${sig.kind} signal: ${err.message}`);
    }
  }

  _addCandidate(sig) {
    try {
      this.pc.addRemoteCandidate(sig.candidate, sig.mid);
    } catch (err) {
      // A single malformed or late candidate must never take the process down.
      this.emit('warning', `rejected remote candidate: ${err.message}`);
    }
  }

  /** Which candidate pair won, and whether we ended up on a relay. */
  transportInfo() {
    let pair = null;
    try { pair = this.pc.getSelectedCandidatePair(); } catch { /* not selected yet */ }
    if (!pair) return { connected: false, policy: this.iceTransportPolicy };
    const localType = pair.local?.type ?? 'unknown';
    const remoteType = pair.remote?.type ?? 'unknown';
    let rtt = -1;
    try { rtt = this.pc.rtt(); } catch { /* ignore */ }
    return {
      connected: true,
      policy: this.iceTransportPolicy,
      relayed: localType === 'relay' || remoteType === 'relay',
      localType,
      remoteType,
      localAddress: pair.local?.address,
      localPort: pair.local?.port,
      remoteAddress: pair.remote?.address,
      remotePort: pair.remote?.port,
      protocol: pair.local?.transportType || 'UDP',
      rttMs: rtt >= 0 ? rtt : undefined,
      bytesSent: this.pc.bytesSent?.() ?? 0,
      bytesReceived: this.pc.bytesReceived?.() ?? 0,
    };
  }

  _setState(s) {
    if (this.state === s || this._closed) return;
    this.state = s;
    this.emit('state', s);
    if (s === PeerState.SECURE) this.emit('secure', this.transportInfo());
  }

  _fail(err) {
    if (this._closed) return;
    this.state = PeerState.FAILED;
    this.emit('error', err);
    this.close(err.message);
  }

  close(reason = 'closed') {
    if (this._closed) return;
    this._closed = true;
    clearTimeout(this._hsTimer);
    for (const ch of [this.ctl, this.media]) {
      try { ch?.close(); } catch { /* already gone */ }
    }
    try { this.pc.close(); } catch { /* already gone */ }
    if (this.state !== PeerState.FAILED) this.state = PeerState.CLOSED;
    this.emit('closed', reason);
    this.removeAllListeners('video');
    this.removeAllListeners('audio');
  }
}

/** Frees libdatachannel's global thread pool; call once at process exit. */
export function cleanupTransport() {
  try { dc.cleanup(); } catch { /* not initialised */ }
}
