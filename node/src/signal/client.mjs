/**
 * Ties a share code to a live Peer: talks to the rendezvous server, encrypts
 * every signaling payload with the code-derived key, and hands decrypted
 * signals to the Peer.
 *
 * Neither helper resolves until the connection is actually SECURE (handshake
 * done and consent granted), so callers never get a half-open session.
 */

import { WebSocket } from 'ws';

import {
  generateShareCode, normalizeShareCode, roomIdFor,
  signalingKey, noisePrologue, sealSignal, openSignal,
} from './code.mjs';
import { Peer, PeerState } from '../transport/peer.mjs';

const CONNECT_TIMEOUT_MS = 20_000;

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

/**
 * Shared plumbing for both roles.
 * @returns {Promise<{peer: Peer, code: string, close: Function}>}
 */
async function run({
  role, code, rendezvousUrl, identity, iceServers, iceTransportPolicy,
  onConsentRequest, onCode, onStatus, sessionTimeoutMs = 60_000,
}) {
  const canonical = normalizeShareCode(code);
  const key = signalingKey(canonical);
  const room = roomIdFor(canonical);
  const prologue = noisePrologue(canonical);

  const ws = await openSocket(rendezvousUrl);
  const status = (s, detail) => onStatus?.(s, detail);

  const peer = new Peer({
    initiator: role === 'client',
    identity,
    prologue,
    iceServers,
    iceTransportPolicy,
    onConsentRequest,
    name: role,
  });

  // Signals may be produced before the peer has joined; queue until 'ready'.
  let peerPresent = role === 'client';
  const outbox = [];
  const flush = () => {
    while (outbox.length && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'sig', payload: outbox.shift() }));
    }
  };

  peer.on('signal', (sig) => {
    outbox.push(sealSignal(key, sig));
    if (peerPresent) flush();
  });
  peer.on('state', (s) => status(s));
  peer.on('ice-state', (s) => status('ice', s));

  const cleanup = () => {
    try { ws.close(); } catch { /* already closed */ }
    peer.close('session ended');
  };

  const secure = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`session did not become secure within ${sessionTimeoutMs}ms (state=${peer.state})`));
    }, sessionTimeoutMs);
    timer.unref?.();

    peer.once('secure', (info) => { clearTimeout(timer); resolve(info); });
    peer.once('error', (err) => { clearTimeout(timer); reject(err); });
    peer.once('consent-denied', (reason) => {
      clearTimeout(timer);
      reject(new Error(`connection refused: ${reason}`));
    });
    peer.once('closed', (reason) => {
      if (peer.state !== PeerState.SECURE) {
        clearTimeout(timer);
        reject(new Error(`connection closed before it was secure: ${reason}`));
      }
    });
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }

    switch (msg.t) {
      case 'ready':
        status('rendezvous-ready', msg.role);
        if (role === 'client') flush();
        break;
      case 'peer-joined':
        peerPresent = true;
        status('peer-joined');
        flush();
        break;
      case 'sig': {
        let sig;
        try {
          sig = openSignal(key, msg.payload);
        } catch {
          // Wrong code, or someone probing the room. Not fatal: ignore it and
          // let the rendezvous rate limiter handle repeat offenders.
          status('signal-rejected');
          return;
        }
        peerPresent = true;
        peer.applySignal(sig);
        break;
      }
      case 'error':
        peer._fail(new Error(`rendezvous: ${msg.message}`));
        break;
      case 'closed':
        if (peer.state !== PeerState.SECURE) peer._fail(new Error(`rendezvous closed room: ${msg.reason}`));
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    // Once media is flowing the rendezvous server is irrelevant, so only treat
    // this as fatal if we never got there.
    if (peer.state !== PeerState.SECURE) peer._fail(new Error('rendezvous disconnected'));
  });
  ws.on('error', (e) => {
    if (peer.state !== PeerState.SECURE) peer._fail(new Error(`rendezvous error: ${e.message}`));
  });

  ws.send(JSON.stringify({ t: role === 'host' ? 'host' : 'join', room }));
  if (role === 'host') onCode?.(canonical);

  try {
    const info = await secure;
    status('secure', info);
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
 * @param {(code:string) => void} [opts.onCode] called with the code to show the user
 */
export function hostSession(opts) {
  const code = opts.code || generateShareCode();
  return run({ ...opts, role: 'host', code });
}

/** Connect to a session using a code the user typed. */
export function joinSession(opts) {
  if (!opts.code) throw new Error('a share code is required to connect');
  return run({ ...opts, role: 'client' });
}
