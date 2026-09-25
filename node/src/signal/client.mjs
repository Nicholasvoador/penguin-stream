/**
 * Ties an invitation to a live Peer: exchanges the WebRTC offer/answer and ICE
 * candidates through one or more signaling transports, encrypting every
 * payload with the invitation-derived key.
 *
 * Transports (used together when several are configured):
 *   - Nostr: public relays, zero setup, works across the Internet and CGNAT.
 *     Enabled by default; PENGUIN_NOSTR=0 or { nostr: false } disables it.
 *   - Rendezvous: a self-hosted `penguin-stream rendezvous` WebSocket server,
 *     for offline LANs or people who prefer their own infrastructure.
 *
 * Both are treated as lossy broadcast channels: each side keeps a log of its
 * signals, (re)sends it until ICE connects, and the receiver applies every
 * sequence number once. That makes message loss, duplicates across relays and
 * "who arrived first" irrelevant.
 *
 * Neither helper resolves until the connection is actually SECURE (handshake
 * done and consent granted), so callers never get a half-open session.
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

import {
  generateShareCode, normalizeShareCode, roomIdFor,
  signalingKey, noisePrologue, sealSignal, openSignal,
} from './code.mjs';
import { NostrChannel, nostrTopicFor } from './nostr.mjs';
import { Peer, PeerState } from '../transport/peer.mjs';

const CONNECT_TIMEOUT_MS = 20_000;
const RESEND_INTERVAL_MS = 2000;
const BATCH_DELAY_MS = 40;
const MAX_LOG = 256;
// From first contact to SECURE, including the host's consent prompt (the UI
// gives the host 120 s to answer).
const HANDSHAKE_TIMEOUT_MS = 180_000;

export function nostrEnabled(option) {
  if (option === true || option === false) return option;
  return process.env.PENGUIN_NOSTR !== '0' && process.env.PENGUIN_NOSTR !== 'off';
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: CONNECT_TIMEOUT_MS });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`rendezvous connect timed out: ${url}`));
    }, CONNECT_TIMEOUT_MS);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(timer); reject(new Error(`rendezvous connect failed: ${e.message}`)); });
  });
}

/** Self-hosted rendezvous server as a broadcast channel between two parties. */
class RendezvousChannel extends EventEmitter {
  constructor(ws, room, role) {
    super();
    this.ws = ws;
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (msg.t === 'ready') this.emit('open');
      else if (msg.t === 'sig' && typeof msg.payload === 'string') this.emit('data', msg.payload);
      else if (msg.t === 'error') this.emit('failure', new Error(`rendezvous: ${msg.message}`));
      else if (msg.t === 'closed') this.emit('failure', new Error(`rendezvous closed room: ${msg.reason}`));
    });
    ws.on('close', () => this.emit('failure', new Error('rendezvous disconnected')));
    ws.on('error', (e) => this.emit('failure', new Error(`rendezvous error: ${e.message}`)));
    ws.send(JSON.stringify({ t: role === 'host' ? 'host' : 'join', room }));
  }

  send(payload) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ t: 'sig', payload }));
  }

  close() {
    this.removeAllListeners('failure');
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

/**
 * Shared plumbing for both roles.
 * @returns {Promise<{peer: Peer, code: string, transport: object, close: Function}>}
 */
async function run({
  role, code, rendezvousUrl, nostr, nostrRelays, identity, iceServers, iceTransportPolicy,
  onConsentRequest, onCode, onStatus, sessionTimeoutMs = 60_000,
}) {
  const canonical = normalizeShareCode(code);
  const codeBytes = Buffer.from(canonical.replaceAll('-', ''), 'utf8');
  const key = signalingKey(canonical);
  const prologue = noisePrologue(canonical);
  const status = (s, detail) => onStatus?.(s, detail);
  const useNostr = nostrEnabled(nostr);
  if (!useNostr && !rendezvousUrl) {
    throw new Error('no signaling transport: enable Nostr or pass a rendezvous URL');
  }

  // --- transports -----------------------------------------------------------
  const channels = [];
  if (rendezvousUrl) {
    try {
      const ws = await openSocket(rendezvousUrl);
      channels.push(new RendezvousChannel(ws, roomIdFor(canonical), role));
    } catch (err) {
      if (!useNostr) throw err;
      status('rendezvous-unavailable', err.message);
    }
  }
  if (useNostr) {
    const { topic, kind } = nostrTopicFor(codeBytes);
    const channel = new NostrChannel({ topic, kind, ...(nostrRelays ? { relays: nostrRelays } : {}) });
    channel.on('relay-error', (url, message) => status('nostr-relay-error', `${url}: ${message}`));
    channels.push(channel.start());
  }

  // --- reliable-enough signal exchange over lossy broadcast ------------------
  const self = crypto.randomBytes(8).toString('hex');
  let partner = null;                 // the one remote session we talk to
  let peer = null;                    // created when there is someone to talk to
  const log = [];                     // [seq, signal] we have produced
  const pending = new Map();          // remote seq -> signal, awaiting its turn
  let nextRemote = 0;                 // next remote seq to apply
  let sentUpTo = 0;
  let batchTimer = null;
  let signalingDone = false;

  let settle;
  const secure = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  let settled = false;
  const finish = (err, info) => {
    if (settled) return;
    settled = true;
    clearTimeout(waitTimer);
    if (err) settle.reject(err); else settle.resolve(info);
  };

  const broadcast = (entries) => {
    if (signalingDone) return;
    let payload;
    try {
      payload = sealSignal(key, { v: 2, from: self, role, ...(partner ? { to: partner } : {}), entries });
    } catch (err) {
      // Runs from timers: an escaped throw here is an uncaught exception that
      // kills the Electron main process. Fail the session instead.
      finish(new Error(`could not encrypt signaling: ${err.message}`));
      return;
    }
    for (const ch of channels) {
      try {
        const r = ch.send(payload);
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch { /* transport gone */ }
    }
  };
  // The host speaks only once it has a partner; the client announces itself.
  const canSpeak = () => role === 'client' || partner !== null;
  const flushNew = () => {
    batchTimer = null;
    if (!canSpeak() || sentUpTo >= log.length) return;
    broadcast(log.slice(sentUpTo));
    sentUpTo = log.length;
  };
  const resendAll = () => {
    if (!canSpeak()) return;
    broadcast(log);
    sentUpTo = log.length;
  };

  // The host creates its peer only when a viewer shows up, so an invitation
  // can wait for as long as the host keeps sharing; the handshake timeout
  // then starts and covers the consent prompt too.
  const createPeer = () => {
    peer = new Peer({
      initiator: role === 'client',
      identity,
      prologue,
      iceServers,
      iceTransportPolicy,
      onConsentRequest,
      name: role,
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    });
    peer.on('signal', (sig) => {
      if (process.env.PS_TRACE) {
        console.error(`[${role}] local ${sig.kind}`, sig.kind === 'candidate' ? sig.candidate : sig.type);
      }
      if (log.length >= MAX_LOG) return;
      log.push([log.length, sig]);
      if (!batchTimer) {
        batchTimer = setTimeout(flushNew, BATCH_DELAY_MS);
        batchTimer.unref?.();
      }
    });
    peer.on('state', (st) => status(st));
    peer.on('ice-state', (st) => {
      status('ice', st);
      if (st === 'connected' || st === 'completed') stopSignaling();
    });
    peer.once('secure', (info) => finish(null, info));
    peer.once('error', (err) => finish(err));
    peer.once('consent-denied', (reason) => finish(new Error(`connection refused: ${reason}`)));
    peer.once('closed', (reason) => {
      if (peer.state !== PeerState.SECURE) finish(new Error(`connection closed before it was secure: ${reason}`));
    });
  };

  const onData = (payload) => {
    let msg;
    try {
      msg = openSignal(key, payload);
    } catch {
      // Wrong invitation, or someone probing the topic: ignore it.
      status('signal-rejected');
      return;
    }
    if (!msg || msg.v !== 2 || typeof msg.from !== 'string' || !Array.isArray(msg.entries)) return;
    if (msg.from === self || msg.role === role) return;
    if (msg.to && msg.to !== self) return;               // addressed to another session
    if (partner === null) {
      partner = msg.from;
      status('peer-joined');
      if (!peer) createPeer();
      resendAll();                                       // answer at once, not on the next tick
    } else if (msg.from !== partner) {
      return;                                            // one viewer per invitation
    }
    // Apply strictly in sequence: a candidate must never overtake the SDP it
    // belongs to, even if it arrived first through a faster relay.
    for (const entry of msg.entries) {
      if (!Array.isArray(entry) || !Number.isInteger(entry[0])) continue;
      if (entry[0] < nextRemote || entry[0] >= MAX_LOG) continue;
      pending.set(entry[0], entry[1]);
    }
    while (pending.has(nextRemote)) {
      const sig = pending.get(nextRemote);
      pending.delete(nextRemote++);
      if (process.env.PS_TRACE) {
        console.error(`[${role}] remote ${sig?.kind}`, sig?.kind === 'candidate' ? sig.candidate : sig?.type);
      }
      peer.applySignal(sig);
    }
  };

  const waitTimer = setTimeout(() => {
    const hint = partner ? '' : role === 'client'
      ? ' - the host was not found: check the invitation and that the host is still sharing'
      : ' - nobody joined';
    finish(new Error(`session did not become secure within ${Math.round(sessionTimeoutMs / 1000)}s ` +
      `(state=${peer?.state ?? 'waiting'})${hint}`));
  }, sessionTimeoutMs);
  waitTimer.unref?.();

  let opened = false;
  for (const ch of channels) {
    ch.on('data', onData);
    ch.once('open', () => {
      if (!opened) { opened = true; status('rendezvous-ready', role); }
      resendAll();
    });
    ch.on('failure', (err) => {
      if (peer?.state === PeerState.SECURE) return;
      // Fatal only when it is the sole transport; otherwise the others carry on.
      if (channels.length === 1) finish(err);
      else status('rendezvous-unavailable', err.message);
    });
  }

  const resendTimer = setInterval(resendAll, RESEND_INTERVAL_MS);
  resendTimer.unref?.();

  function stopSignaling() {
    if (signalingDone) return;
    resendAll();              // one last full copy so late candidates still arrive
    signalingDone = true;
    clearInterval(resendTimer);
    if (batchTimer) clearTimeout(batchTimer);
  }

  const closeChannels = () => {
    stopSignaling();
    for (const ch of channels) {
      try { ch.close(); } catch { /* already closed */ }
    }
  };

  const cleanup = () => {
    closeChannels();
    peer?.close('session ended');
  };

  if (role === 'client') createPeer();       // the viewer makes the offer
  if (role === 'host') {
    // Nostr needs nothing but the code. A self-hosted rendezvous (other than
    // loopback, which only this machine can reach) travels in the invitation.
    const loopback = rendezvousUrl && /\/\/(127\.|localhost|\[::1\])/.test(rendezvousUrl);
    onCode?.(rendezvousUrl && !loopback ? `${canonical}@${rendezvousUrl}` : canonical);
  }

  try {
    const info = await secure;
    status('secure', info);
    closeChannels();            // signaling is no longer needed once secure
    return { peer, code: canonical, transport: info, close: cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Publish a session and wait for a viewer.
 * @param {object} opts
 * @param {(info:{sas:object,remoteStatic:Buffer}) => Promise<boolean>} opts.onConsentRequest
 * @param {(code:string) => void} [opts.onCode] called with the invitation to show the user
 */
export function hostSession(opts) {
  const code = opts.code || generateShareCode();
  return run({ ...opts, role: 'host', code });
}

/** Connect to a session using an invitation the user pasted. */
export function joinSession(opts) {
  if (!opts.code) throw new Error('a share code is required to connect');
  return run({ ...opts, role: 'client' });
}
