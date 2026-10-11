/**
 * Local control UI.
 *
 * Plain HTTP on 127.0.0.1. Deliberately not HTTPS: a self-signed certificate
 * would produce the browser warning that makes Sunshine's first run feel
 * broken, and TLS buys nothing on a loopback socket. Nothing sensitive is
 * served here - the actual session is end-to-end encrypted elsewhere.
 *
 * It can start a screen share, so it is defended against the two attacks a
 * local web page could otherwise mount:
 *   - CSRF: every request must carry a per-run bearer token
 *   - DNS rebinding: Host and Origin headers must be loopback
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

import { Host, Viewer, DEFAULT_RENDEZVOUS, APP_VERSION } from '../app/session.mjs';
import { normalizeShareCode, parseInvitation } from '../signal/code.mjs';
import { nostrEnabled } from '../signal/client.mjs';
import { loadOrCreateIdentity, TrustStore } from '../crypto/identity.mjs';
import { cleanupTransport } from '../transport/peer.mjs';
import { SettingsStore, resolutionBox, sanitizeResolution } from '../app/settings.mjs';
import { listMonitors, resolveMonitor, workspaceOf } from '../app/monitors.mjs';
import { runNetcheck } from '../net/netcheck.mjs';
import { Logbook, statLine } from '../app/logbook.mjs';
import { findMediaBinary, CaptureEngine } from '../media/engine.mjs';
import { execFile } from 'node:child_process';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function isLoopbackHost(value) {
  if (!value) return false;
  const host = value.replace(/^https?:\/\//, '').split('/')[0];
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
}

/**
 * @param {object} [o]
 * @param {object} [o.desktop] hooks the desktop shell provides (all optional):
 *   notify(title, body), setStartAtLogin(on) -> boolean, onRemoteAccess(state)
 * @param {number} [o.remoteMediaStartMs] unattended sessions: how long screen
 *   capture may take to start before the session is ended and explained
 */
export async function startUi({ port = 47800, open = true, quiet = false, HostClass = Host, ViewerClass = Viewer,
  CaptureEngineClass = CaptureEngine, consentTimeoutMs = 120_000, onSessionChange = null, desktop = {},
  remoteMediaStartMs = 30_000 } = {}) {
  const token = crypto.randomBytes(24).toString('base64url');
  const identity = loadOrCreateIdentity();
  const trust = new TrustStore();
  const settings = new SettingsStore();
  const logbook = new Logbook();
  logbook.startup({ version: APP_VERSION, extra: { device: identity.fingerprint } });
  let lastNetcheck = null;
  let lastStatLog = 0;
  let netcheck = null;   // in-flight check, shared by concurrent callers

  /** @type {{kind:'host'|'viewer', instance:any}|null} */
  let active = null;
  let pendingConsent = null;   // { request, resolve, timer }
  let share = null;            // host: the running share (outlives single sessions)
  let viewerRetry = null;      // viewer: pending automatic reconnect { timer }
  let generation = 0;
  const bindSession = (instance) => {
    const epoch = ++generation;
    const current = () => generation === epoch && active?.instance === instance;
    return { current, on: (event, fn) => instance.on(event, (...args) => { if (current()) fn(...args); }) };
  };
  const clients = new Set();

  const broadcast = (type, data) => {
    const msg = JSON.stringify({ type, data });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  };

  const state = {
    mode: 'idle',
    code: null,
    sas: null,
    transport: null,
    mediaConfig: null,
    stats: {},
    log: [],
    permissions: null,     // host: what the viewer may control (live)
    inputStatus: null,     // host: what this machine can actually inject
    remoteViewer: null,    // host: what the viewer is currently sending
    viewerState: null,     // viewer: local switches, as the stream window reports them
    hostPermissions: null, // viewer: what the host allows
    reconnect: null,       // viewer: { attempt, reason, at } while reconnecting
    viewerAccess: false,   // viewer: connected with a remote access code (no words to compare)
  };

  const pushLog = (line) => {
    logbook.write(/^(error|host failed|connect failed)/.test(line) ? 'error' : /warn/i.test(line) ? 'warn' : 'info', line);
    state.log.push(`${new Date().toISOString().slice(11, 19)}  ${line}`);
    if (state.log.length > 200) state.log.shift();
    broadcast('log', line);
  };

  // Every ~10 s during a session: one line with the numbers that matter.
  const logStats = (role, s) => {
    const now = Date.now();
    if (now - lastStatLog < 10_000) return;
    lastStatLog = now;
    logbook.stat(statLine(role, s));
  };

  const setMode = (mode) => {
    if (mode !== state.mode) logbook.info(`mode ${state.mode} -> ${mode}`);
    state.mode = mode;
    broadcast('state', publicState());
  };

  const publicState = () => ({
    mode: state.mode,
    code: state.code,
    sas: state.sas,
    transport: state.transport,
    mediaConfig: state.mediaConfig,
    stats: state.stats,
    identity: { fingerprint: identity.fingerprint, label: identity.label },
    peers: trust.list().map((p) => ({ fingerprint: p.fingerprint, label: p.label, role: p.role })),
    pendingConsent: pendingConsent?.request ?? null,
    rendezvous: DEFAULT_RENDEZVOUS ?? null,
    permissions: state.permissions,
    inputStatus: state.inputStatus,
    remoteViewer: state.remoteViewer,
    viewerState: state.viewerState,
    hostPermissions: state.hostPermissions,
    reconnect: state.reconnect,
    // The last invitation that worked, for a one-click reconnect. Local UI
    // only (token-protected); never written to logs or diagnostics.
    lastInvitation: settings.get().lastInvitation || null,
    viewerAccess: state.viewerAccess,
    remote: remotePublic(),
    platform: process.platform,
    version: APP_VERSION,
  });

  // Ends the CURRENT host/viewer instance only. A share (or a viewer's
  // reconnect loop) may carry on with a fresh instance afterwards.
  // `notice` (host only) is shown to the viewer before the connection closes.
  const endSession = (reason, notice = null) => {
    const previous = active;
    active = null;
    ++generation;
    clearTimeout(pendingConsent?.timer);
    pendingConsent?.resolve?.(false);
    pendingConsent = null;
    try { previous?.instance.close(reason, notice); } catch { /* already closing */ }
    state.sas = null;
    state.transport = null;
    state.mediaConfig = null;
    state.stats = {};
    state.remoteViewer = null;
    state.viewerState = null;
    state.hostPermissions = null;
    state.viewerAccess = false;
    if (previous?.remote && remote) remote.live = null;
    onSessionChange?.(false);
    resumeRemoteListener();
    return previous;
  };

  // Stops everything: the share, a pending reconnect, the current session.
  // Remote access stays on (it is switched off on its own): if the session
  // being stopped was a remote one, the PC simply listens again.
  const stopActive = (reason = 'stopped by user') => {
    clearTimeout(share?.timer);
    share = null;
    clearTimeout(viewerRetry?.timer);
    viewerRetry = null;
    const previous = endSession(reason, /stopped by user/.test(reason) ? 'The session was ended at the remote computer.' : null);
    state.code = null;
    state.permissions = null;
    state.inputStatus = null;
    state.reconnect = null;
    setMode('idle');
    if (previous?.remote && remote) {
      pushLog(`remote access session ended: ${reason}`);
      remoteChanged();
      void armRemote();
    }
  };

  /* ----------------------------- actions ----------------------------- */

  // Network options shared by both roles. Request fields override the saved
  // settings; the saved relay (with its secrets) never travels through the UI.
  function commonOptions(opts) {
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const saved = settings.get();
    const pick = (k) => (opts[k] !== undefined ? opts[k] : saved[k]);
    return {
      rendezvousUrl: str(pick('rendezvous')) || DEFAULT_RENDEZVOUS,
      forceRelay: pick('forceRelay') === true,
      noStun: pick('noStun') === true,
      stun: str(pick('stun')),
      turn: str(opts.turn),
      turnUser: str(opts.turnUser),
      turnPassword: typeof opts.turnPassword === 'string' && opts.turnPassword ? opts.turnPassword : undefined,
      relay: saved.relay,
    };
  }

  /*
   * Sharing is a loop, not a one-shot: the host keeps its invitation (the
   * same code every time, unless the user asks for a new one) and, whenever
   * a session ends - the viewer left, the connection dropped, an attempt
   * failed or was refused - it simply waits for the next connection. Only
   * Stop ends the share. A device approved during this share is let back in
   * without asking again, so a friend can reconnect after any hiccup.
   */
  /**
   * Capture/encode/network options for a host session: the request may
   * override the saved settings (shares); remote access uses the saved ones.
   */
  async function hostOptions(opts = {}) {
    const saved = settings.get();
    const pick = (k) => (opts[k] !== undefined ? opts[k] : saved[k]);
    const box = resolutionBox(sanitizeResolution(pick('resolution')) ?? saved.resolution);
    const monitors = await listMonitors({ fresh: true }).catch(() => []);
    const monitorChoice = typeof pick('monitor') === 'string' ? pick('monitor') : 'primary';
    const monitor = resolveMonitor(monitors, monitorChoice);
    // Remote-desktop and screen-cast grants are different kinds of token.
    const tokenKey = `${process.platform}:rd:${monitor ? monitor.id : 'all'}`;
    const num = (v) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
    return {
      tokenKey, monitor, monitors, pick, num,
      hostOpts: {
        ...commonOptions(opts),
        source: typeof pick('source') === 'string' && /^(dxgi|gdi|portal|x11|synthetic)$/.test(pick('source')) ? pick('source') : undefined,
        display: typeof opts.display === 'string' && /^[0-9]{1,2}$/.test(opts.display) ? opts.display : undefined,
        fps: num(pick('fps')),
        bitrateKbps: num(pick('bitrate')),
        adaptiveBitrate: pick('adaptiveBitrate') !== false,
        width: box.width || undefined,
        height: box.height || undefined,
        monitor: monitor ?? undefined,
        workspace: monitor ? workspaceOf(monitors) ?? undefined : undefined,
        encoder: typeof pick('encoder') === 'string' && /^(auto|nvenc|amf|qsv|mf|vaapi|x264|software)$/.test(pick('encoder'))
          ? pick('encoder') : undefined,
        // Ask Wayland for remote-control permission up front, so control can be
        // switched on later in the session without restarting the share.
        inputCapable: true,
        audio: opts.audio === true,
        audioFilter: { excludeVoice: saved.audioExcludeVoice, exclude: saved.audioExclude, only: saved.audioOnly },
      },
    };
  }

  async function startHost(opts) {
    if (active || share || viewerRetry) throw new Error('a session is already running');
    const { tokenKey, monitor, monitors, pick, num, hostOpts } = await hostOptions(opts);
    if (active || share || viewerRetry) throw new Error('a session is already running');
    share = {
      code: typeof opts.code === 'string' && opts.code ? opts.code : settings.shareCode(),
      tokenKey,
      permissions: { kbm: opts.allowInput === true, pad: opts.allowGamepad === true },
      approved: new Set(),       // device fingerprints approved during this share
      fails: 0,
      timer: null,
      paused: false,             // a remote access session borrowed the screen
      hostOpts,
    };
    if (monitor) pushLog(`sharing monitor ${monitor.label || monitor.id}`);
    logbook.info(`share: fps=${num(pick('fps')) ?? 60} bitrate=${num(pick('bitrate')) ?? 15000} resolution=${pick('resolution')} ` +
      `adaptive=${pick('adaptiveBitrate') !== false} monitor=${monitor ? monitor.label : 'system picker'} ` +
      `monitors=${monitors.map((m) => `${m.name}:${m.id}${m.primary ? '*' : ''}`).join(' ') || 'unknown'}`);
    launchHost();
    return { ok: true };
  }

  /** One connection attempt / session of the current share. */
  function launchHost() {
    const s = share;
    if (!s || active || s.paused) return;
    const startedAt = Date.now();
    const host = new HostClass({
      ...s.hostOpts,
      code: s.code,
      allowInput: s.permissions.kbm,
      allowGamepad: s.permissions.pad,
      // The latest Wayland grant (saved after each session) avoids the picker.
      // Read when capture starts: the share may have waited for hours.
      restoreToken: () => settings.get().portalTokens?.[s.tokenKey],
    });

    active = { kind: 'host', instance: host };
    const scope = bindSession(host);
    state.permissions = { ...host.permissions };
    state.code = s.code;
    setMode('hosting-waiting');
    scope.on('permissions', (p) => { s.permissions = { ...p }; state.permissions = { ...p }; broadcast('state', publicState()); });
    scope.on('input-status', (st) => { state.inputStatus = st; broadcast('state', publicState()); });
    scope.on('viewer-state', (v) => { state.remoteViewer = v; broadcast('state', publicState()); });

    scope.on('code', (code) => { state.code = code; broadcast('state', publicState()); });
    // Wayland remembered the screen choice: reuse it next time (no picker).
    scope.on('restore-token', (tok) => {
      try { settings.update({ portalTokens: { ...(settings.get().portalTokens || {}), [s.tokenKey]: tok } }); } catch { /* best effort */ }
    });
    scope.on('audio-warning', (w) => { pushLog(`audio warning: ${w}`); broadcast('notice', w); });
    scope.on('log', pushLog);
    scope.on('stats', (st) => { state.stats = st; broadcast('stats', st); logStats('host', st); });
    scope.on('media-config', (cfg) => {
      state.mediaConfig = cfg;
      logbook.info(`stream ${cfg.width}x${cfg.height}@${cfg.fps} from ${cfg.sourceWidth ?? cfg.width}x${cfg.sourceHeight ?? cfg.height} ` +
        `encoder=${cfg.encoder} capture=${cfg.capture}${cfg.intraRefresh ? ' intra-refresh' : ''}`);
      broadcast('state', publicState());
    });
    scope.on('secure', (t) => {
      s.fails = 0;
      onSessionChange?.(true);
      pauseRemoteListener();
      logbook.info(`connected: ${t?.relayed ? 'relay' : 'direct'} ${t?.localType ?? ''}->${t?.remoteType ?? ''} ${t?.protocol ?? ''}`);
    });
    scope.on('error', (e) => pushLog(`error: ${e.message}`));
    scope.on('closed', (reason) => {
      pushLog(`session ended: ${reason} - still sharing, the same invitation works to reconnect`);
      rearmHost(reason, startedAt, false);
    });

    // Resolved by the /api/consent endpoint when the user clicks.
    host.start(async (request) => {
      if (!scope.current() || pendingConsent) return false;
      if (s.approved.has(request.fingerprint) && settings.get().autoReconnect !== false) {
        pushLog(`${request.label || 'viewer'} reconnected (approved earlier in this share)`);
        state.sas = request.sas;
        setMode('hosting-live');
        return true;
      }
      const consent = { request, resolve: null, timer: null };
      pendingConsent = consent;
      broadcast('consent', request);
      setMode('hosting-consent');

      const decision = await new Promise((resolve) => {
        consent.resolve = resolve;
        consent.timer = setTimeout(() => resolve(false), consentTimeoutMs);
        consent.timer.unref?.();
      });

      clearTimeout(consent.timer);
      if (!scope.current() || pendingConsent !== consent) return false;
      pendingConsent = null;
      if (decision) {
        s.approved.add(request.fingerprint);
        state.sas = request.sas;
        setMode('hosting-live');
      } else {
        pushLog('connection refused');
        setMode('hosting-waiting');
      }
      return decision;
    }).catch((err) => {
      if (!scope.current()) return;
      pushLog(`connection attempt ended: ${err.message} - still sharing, the invitation still works`);
      rearmHost(err.message, startedAt, true);
    });
  }

  /** The session ended: wait for the next one with the same invitation. */
  function rearmHost(reason, startedAt, failed) {
    if (!share || share.paused) return;
    endSession(reason);
    // Attempts that fail instantly (no network, signaling down) back off, so
    // a broken setup never spins; anything else re-arms right away.
    share.fails = failed && Date.now() - startedAt < 5000 ? share.fails + 1 : 0;
    const delay = share.fails ? Math.min(30_000, 1000 * 2 ** (share.fails - 1)) : 0;
    state.code = share.code;
    setMode('hosting-waiting');
    clearTimeout(share.timer);
    share.timer = setTimeout(() => { if (share) { share.timer = null; launchHost(); } }, delay);
    share.timer.unref?.();
  }

  /** New invitation code: the old one stops working for new connections. */
  function newShareCode() {
    const code = settings.newShareCode();
    if (share) {
      share.code = code;
      share.approved.clear();    // a new code means: start over with who may join
      state.code = code;
      // Waiting (not live): restart the attempt so the new code works now.
      if (state.mode === 'hosting-waiting' || state.mode === 'hosting-consent') {
        endSession('new invitation code');
        launchHost();
      } else {
        broadcast('state', publicState());
      }
    }
    pushLog('new invitation code created; the old one no longer works');
    return code;
  }

  /* --------------------------- remote access --------------------------- */

  /*
   * Unattended access to THIS PC with its access code ("PA-…"), for the
   * owner reaching their own machine from elsewhere. Off unless switched on.
   * While on, a listener waits on the code's own signaling topic (separate
   * from invitations). A viewer that completes the Noise handshake WITH the
   * code is let in without a prompt: holding the code is the permission, and
   * without it a peer cannot even finish the handshake. The PC still shows
   * every session (banner, desktop notification, log) and can end it.
   */
  let remote = null;   // { code, listener, timer, fails, spent, relays, lastError, live, tokenKey, startedAt }
  let remoteSetup = { tokenKey: null, needsSetup: false, reason: null };

  const waylandPortal = () => process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY))
    && !/^(x11|synthetic)$/.test(settings.get().source || '');

  function remotePublic() {
    const s = settings.get();
    const signaling = nostrEnabled(undefined) ? (remote?.relays ?? 0) : null;   // null: no relays in use
    return {
      enabled: Boolean(remote),
      status: !remote ? 'off' : remote.live ? 'live' : remote.paused ? 'paused'
        : (signaling === null || signaling > 0) && remote.listener ? 'ready' : 'connecting',
      relays: signaling,
      live: remote?.live ? { ...remote.live } : null,
      lastError: remote?.lastError ?? null,
      keepAwake: s.remoteKeepAwake !== false,
      // null: not available (CLI). The desktop shell reports the real login item.
      startAtLogin: typeof desktop.setStartAtLogin === 'function'
        ? (typeof desktop.getStartAtLogin === 'function' ? desktop.getStartAtLogin() === true : s.startAtLogin === true) : null,
      needsSetup: remoteSetup.needsSetup,
      setupReason: remoteSetup.reason,
    };
  }

  const remoteChanged = () => {
    try { desktop.onRemoteAccess?.(remotePublic()); } catch { /* shell only */ }
    broadcast('state', publicState());
  };
  const notify = (title, body) => { try { desktop.notify?.(title, body); } catch { /* shell only */ } };

  /** Wayland only: is there a saved screen + control grant for the monitor remote access uses? */
  async function refreshRemoteSetup() {
    const { tokenKey } = await hostOptions({});
    const has = Boolean(settings.get().portalTokens?.[tokenKey]);
    remoteSetup = { tokenKey, needsSetup: waylandPortal() && !has,
      reason: waylandPortal() && !has ? 'This desktop must allow screen sharing and remote control once, while you are at the PC.' : null };
    return remoteSetup;
  }

  async function enableRemote({ startup = false } = {}) {
    if (!remote) {
      const code = settings.accessCode();
      if (!settings.get().remoteAccess) settings.update({ remoteAccess: true });
      remote = { code, listener: null, timer: null, arming: false, dirty: false, paused: false, fails: 0, spent: new Set(),
        relays: 0, lastError: null, live: null, tokenKey: null, startedAt: 0 };
      // Turned on during a live share/view: wait for it to end before listening.
      if (active && !active.remote && /^(hosting-live|viewing)$/.test(state.mode)) remote.paused = true;
      pushLog(startup ? 'remote access is on: listening for this PC\'s access code'
        : 'remote access turned on: anyone with this PC\'s access code can connect without asking');
    }
    await refreshRemoteSetup().catch(() => {});
    await armRemote();
    remoteChanged();
    return remotePublic();
  }

  function disableRemote(reason = 'remote access turned off') {
    const r = remote;
    if (r) {
      remote = null;               // first: nothing re-arms from here on
      clearTimeout(r.timer);
      const listener = r.listener;
      r.listener = null;
      try { listener?.close(reason); } catch { /* already closed */ }
      if (active?.remote) finishRemoteLive(reason, 'Remote access was switched off on the remote computer.');
      pushLog(reason);
    }
    if (settings.get().remoteAccess) settings.update({ remoteAccess: false });
    remoteChanged();
    return remotePublic();
  }

  function newAccessCode() {
    const code = settings.newAccessCode();
    const r = remote;
    if (r) {
      r.code = code;
      r.spent.clear();
      clearTimeout(r.timer);
      r.timer = null;
      const listener = r.listener;
      r.listener = null;
      try { listener?.close('new access code'); } catch { /* already closed */ }
      if (active?.remote) finishRemoteLive('access code changed', 'The access code of the remote computer was changed.');
      else void armRemote();
    }
    pushLog('new remote access code created; the old one no longer works');
    remoteChanged();
    return code;
  }

  /*
   * While this PC is in another LIVE session (a share or viewing someone),
   * remote access would be refused as busy anyway, so the listener steps
   * aside completely: no relay sockets, pings or timers next to a live stream
   * (measured: a waiting listener cost +0.01 ms on the host send stage).
   * It listens again the moment that session ends.
   */
  function pauseRemoteListener() {
    const r = remote;
    if (!r || r.paused || active?.remote) return;
    r.paused = true;
    clearTimeout(r.timer);
    r.timer = null;
    const listener = r.listener;
    r.listener = null;
    r.relays = 0;
    try { listener?.close('paused during another session'); } catch { /* closed */ }
    remoteChanged();
  }
  function resumeRemoteListener() {
    const r = remote;
    if (!r?.paused) return;
    r.paused = false;
    void armRemote();
    remoteChanged();
  }

  // Settings a remote session is built from. A waiting listener picks up a
  // change at once; a live session keeps what it started with.
  const REMOTE_SESSION_KEYS = new Set(['fps', 'bitrate', 'resolution', 'monitor', 'encoder', 'source', 'display', 'audio',
    'audioExcludeVoice', 'audioExclude', 'audioOnly', 'adaptiveBitrate', 'allowGamepad', 'forceRelay', 'noStun', 'stun',
    'rendezvous', 'relay']);
  function refreshRemoteListener() {
    const r = remote;
    if (r?.arming) { r.dirty = true; return; }
    if (!r?.listener) return;            // paused or live: the next listener reads fresh settings anyway
    const listener = r.listener;
    r.listener = null;
    try { listener.close('settings changed'); } catch { /* closed */ }
    void armRemote();
    refreshRemoteSetup().then(remoteChanged, () => {});
  }

  /** Waits for the next remote viewer (one listener at a time). */
  async function armRemote(delay = 0) {
    const r = remote;
    if (!r || r.listener || r.live || r.timer || r.arming || r.paused) return;
    if (delay > 0) {
      r.timer = setTimeout(() => { r.timer = null; void armRemote(); }, delay);
      r.timer.unref?.();
      return;
    }
    r.arming = true;             // blocks re-entry while the options load
    let built;
    try {
      // Settings changed while loading: load again, never arm with stale ones.
      do { r.dirty = false; built = await hostOptions({}); } while (r.dirty && remote === r);
    } finally { r.arming = false; }
    if (remote !== r || r.listener || r.live || r.timer || r.paused) return;
    const saved = settings.get();
    r.tokenKey = built.tokenKey;
    r.relays = 0;
    const host = new HostClass({
      ...built.hostOpts,
      audio: saved.audio === true,
      code: r.code,
      allowInput: true,                      // using your own PC remotely
      allowGamepad: saved.allowGamepad !== false,
      restoreToken: () => settings.get().portalTokens?.[built.tokenKey],
      spentPartners: r.spent,
      peerLabel: 'remote access',
      mediaStartTimeoutMs: remoteMediaStartMs,
      mediaStartTimeoutNotice: waylandPortal()
        ? 'The remote computer could not start sharing its screen: it is asking for permission and nobody is there to allow it. ' +
          'At that PC, open Penguin Stream → Remote access and click "Allow screen access" once.'
        : 'The remote computer could not start sharing its screen in time.',
    });
    r.listener = host;
    r.startedAt = Date.now();
    host.on('status', (st, detail) => {
      if (remote !== r || (r.listener !== host && active?.instance !== host)) return;
      if (st === 'nostr-relays' && Number.isInteger(detail) && detail !== r.relays) {
        const was = r.relays;
        r.relays = detail;
        if ((was === 0) !== (detail === 0)) broadcast('state', publicState());   // reachable <-> not
      }
    });
    host.start(async (request) => approveRemote(r, host, request)).catch((err) => {
      if (remote !== r) return;
      if (r.listener === host) {
        // Still listening when it failed: a handshake that went nowhere, a
        // refused (busy) attempt, a signaling hiccup. Listen again; back off
        // only if attempts fail instantly (no network), so it never spins.
        r.listener = null;
        try { host.close('listener restart'); } catch { /* closed */ }
        if (!/cancel/i.test(err.message)) r.lastError = String(err.message).slice(0, 200);
        r.fails = Date.now() - r.startedAt < 5000 ? r.fails + 1 : 0;
        void armRemote(r.fails ? Math.min(60_000, 1000 * 2 ** (r.fails - 1)) : 0);
        broadcast('state', publicState());
      } else if (active?.instance === host) {
        finishRemoteLive(err.message);
      }
    });
    broadcast('state', publicState());
  }

  /** The handshake proved the viewer holds the access code: let it in, unless the PC is busy. */
  function approveRemote(r, host, request) {
    if (remote !== r || r.listener !== host) return false;
    const waitingShare = active?.kind === 'host' && !active.remote && share && state.mode === 'hosting-waiting';
    if (active && !waitingShare) {
      pushLog(`remote access: refused device ${request.fingerprint} - this PC is in another session`);
      notify('Remote access refused', 'A device with your access code tried to connect while another session was running on this PC.');
      return { ok: false, reason: 'the remote computer is busy with another session' };
    }
    if (waitingShare) {
      // Borrow the screen; the invitation works again once this session ends.
      clearTimeout(share.timer);
      share.timer = null;
      share.paused = true;
      endSession('paused for a remote access session');
      pushLog('sharing paused while a remote access session runs; your invitation works again afterwards');
    }
    r.listener = null;
    r.live = { fingerprint: request.fingerprint, label: request.label || null, since: Date.now(),
      transport: request.transport ?? null };
    promoteRemote(r, host);
    return true;
  }

  function promoteRemote(r, host) {
    active = { kind: 'host', instance: host, remote: true };
    const scope = bindSession(host);
    state.permissions = { ...host.permissions };
    state.code = null;
    state.sas = null;
    state.transport = r.live.transport;
    setMode('hosting-live');
    scope.on('permissions', (p) => { state.permissions = { ...p }; broadcast('state', publicState()); });
    scope.on('input-status', (st) => { state.inputStatus = st; broadcast('state', publicState()); });
    scope.on('viewer-state', (v) => { state.remoteViewer = v; broadcast('state', publicState()); });
    scope.on('restore-token', (tok) => {
      try { settings.update({ portalTokens: { ...(settings.get().portalTokens || {}), [r.tokenKey]: tok } }); } catch { /* best effort */ }
    });
    scope.on('audio-warning', (w) => { pushLog(`audio warning: ${w}`); broadcast('notice', w); });
    scope.on('log', pushLog);
    scope.on('stats', (st) => { state.stats = st; broadcast('stats', st); logStats('host', st); });
    scope.on('media-config', (cfg) => {
      state.mediaConfig = cfg;
      logbook.info(`stream ${cfg.width}x${cfg.height}@${cfg.fps} from ${cfg.sourceWidth ?? cfg.width}x${cfg.sourceHeight ?? cfg.height} ` +
        `encoder=${cfg.encoder} capture=${cfg.capture}${cfg.intraRefresh ? ' intra-refresh' : ''}`);
      broadcast('state', publicState());
    });
    scope.on('secure', (t) => {
      r.fails = 0;
      r.lastError = null;
      state.transport = t;
      if (r.live) r.live.transport = t;
      onSessionChange?.(true);
      const route = t?.relayed ? 'through a relay' : 'directly';
      pushLog(`remote access: device ${r.live?.fingerprint ?? '?'} connected ${route} with this PC's access code`);
      logbook.info(`connected: ${t?.relayed ? 'relay' : 'direct'} ${t?.localType ?? ''}->${t?.remoteType ?? ''} ${t?.protocol ?? ''} (remote access)`);
      notify('Someone is using this PC remotely',
        `Connected with your access code (device ${r.live?.fingerprint ?? 'unknown'}). Open Penguin Stream to end the session.`);
      remoteChanged();
    });
    scope.on('error', (e) => pushLog(`error: ${e.message}`));
    scope.on('closed', (reason) => finishRemoteLive(reason));
    remoteChanged();
  }

  /**
   * Wayland: capture did not start for a remote session, i.e. the desktop
   * showed a permission prompt with nobody there. The saved grant is dead
   * (revoked, reset, or saved under another app identity): forget it so the
   * Remote access card asks for the one-time setup again, and tell the owner.
   */
  function forgetDeadGrant() {
    const key = remote?.tokenKey;
    const tokens = { ...(settings.get().portalTokens || {}) };
    if (key && tokens[key]) {
      delete tokens[key];
      try { settings.update({ portalTokens: tokens }); } catch { /* best effort */ }
      pushLog('remote access: the saved screen permission no longer works - open Remote access and click "Allow screen access" once');
      notify('Remote access needs your OK once',
        'Someone connected with your access code, but the desktop asked for screen-sharing permission. ' +
        'Open Penguin Stream → Remote access → Allow screen access.');
    }
    void refreshRemoteSetup().then(() => remoteChanged()).catch(() => {});
  }

  /** The live remote session is over (any reason): listen again, give a paused share its screen back. */
  function finishRemoteLive(reason, notice = null) {
    const wasLive = Boolean(active?.remote);
    if (wasLive) {
      pushLog(`remote access session ended: ${reason}`);
      endSession(reason, notice);
      state.permissions = null;
      state.inputStatus = null;
      if (/did not start in time/.test(reason) && waylandPortal()) forgetDeadGrant();
    }
    if (remote) remote.live = null;
    if (share?.paused) {
      share.paused = false;
      pushLog('sharing resumed: your invitation works again');
      launchHost();
    } else if (!active && !share && !viewerRetry) {
      state.code = null;
      setMode('idle');
    }
    if (remote) void armRemote();
    remoteChanged();
  }

  /**
   * Wayland: ask for screen + control permission once, while the owner is at
   * the PC, and keep the grant ("allow restoring") so unattended sessions
   * start without a prompt. Also a quick self-test elsewhere.
   */
  async function prepareRemote() {
    if (active || share || viewerRetry) throw new Error('stop the current session first');
    const { tokenKey, hostOpts } = await hostOptions({});
    if (!waylandPortal()) {
      await refreshRemoteSetup().catch(() => {});
      remoteChanged();
      return { ok: true, needed: false };
    }
    const before = settings.get().portalTokens?.[tokenKey];
    let saved = null;
    let lastError = '';
    const engine = new CaptureEngineClass({
      source: hostOpts.source, display: hostOpts.display, fps: 30, bitrateKbps: 2000, encoder: hostOpts.encoder,
      width: 640, height: 360, monitor: hostOpts.monitor, workspace: hostOpts.workspace,
      restoreToken: before, inputCapable: true, maxFrames: 1,
    });
    const result = await new Promise((resolve) => {
      let configured = false;
      const timer = setTimeout(() => { lastError = 'nobody answered the permission prompt'; engine.stop?.(); }, 5 * 60_000);
      timer.unref?.();
      engine.on('restore-token', (tok) => {
        saved = tok;
        try { settings.update({ portalTokens: { ...(settings.get().portalTokens || {}), [tokenKey]: tok } }); } catch { /* best effort */ }
      });
      engine.on('config', () => { configured = true; });
      engine.on('log', (m) => { if (/^capture start failed: /.test(m)) lastError = m.slice(22); });
      engine.on('error', (e) => { lastError = e.message; });
      engine.on('exit', () => { clearTimeout(timer); resolve(configured); });
      try { engine.start(); } catch (e) { lastError = e.message; clearTimeout(timer); resolve(false); }
    });
    await refreshRemoteSetup().catch(() => {});
    remoteChanged();
    if (!result) throw new Error(`screen access was not granted${lastError ? `: ${lastError}` : ''}`);
    if (!saved) throw new Error('screen access worked this time, but the desktop did not let Penguin Stream remember it - ' +
      'run this again and keep "Allow restoring" / "Remember" ticked in the prompt');
    pushLog('remote access: screen and remote-control permission saved for unattended sessions');
    return { ok: true, needed: true, reused: Boolean(before) && before !== saved };
  }

  // Deliberate endings: never reconnect after these.
  const FINAL_REASON = /consent denied|refused|declined|stopped by user|stopped sharing|viewer window closed|shutting down|cancelled|new invitation|does not look right|access code of this PC/i;

  async function startViewer(opts) {
    if (active || share) throw new Error('a session is already running');
    if (viewerRetry) { clearTimeout(viewerRetry.timer); viewerRetry = null; }
    if (!opts.code) throw new Error('a share code is required');
    // Validate up front: viewer.start() runs detached, so a bad code would
    // otherwise be reported as success and only fail asynchronously.
    let code = opts.code;
    let rendezvous = opts.rendezvous;
    let access = false;
    try {
      const parsed = parseInvitation(opts.code);
      code = parsed.code;
      access = parsed.scope === 'access';
      if (!rendezvous && parsed.rendezvousUrl) rendezvous = parsed.rendezvousUrl;
    } catch (err) {
      throw new Error(`that share code does not look right: ${err.message}`);
    }
    if (access && remote && code === remote.code) throw new Error('that is the access code of this PC - use it on another computer');

    const viewerOpts = {
      ...commonOptions({ ...opts, rendezvous }),
      code,
      sendKbm: opts.sendKbm !== false,
      sendPad: opts.sendPad !== false,
      lowLatency: opts.lowLatency !== false,
      overlay: (opts.overlay !== undefined ? opts.overlay : settings.get().overlay) === true,
      audio: opts.audio === true,
    };
    state.reconnect = null;
    // Invitations are remembered for "Reconnect" automatically; an access
    // code opens a PC without asking, so only when the user ticks Remember.
    const remember = !access || opts.remember === true;
    launchViewer(viewerOpts, String(opts.code).trim(), 0, { access, remember });
    return { ok: true };
  }

  function launchViewer(viewerOpts, invitation, attempt, how = { access: false, remember: true }) {
    const viewer = new ViewerClass({
      ...viewerOpts,
      // Reconnect attempts give up sooner and try again (the loop only ends on Cancel).
      ...(attempt ? { sessionTimeoutMs: 45_000 } : {}),
    });

    active = { kind: 'viewer', instance: viewer };
    const scope = bindSession(viewer);
    let wasLive = false;
    state.viewerAccess = how.access;
    setMode(attempt ? 'reconnecting' : 'connecting');
    scope.on('notice', (text) => { pushLog(`remote computer: ${text}`); broadcast('notice', text); });
    scope.on('viewer-state', (v) => { state.viewerState = v; broadcast('state', publicState()); });
    scope.on('host-permissions', (p) => { state.hostPermissions = p; broadcast('state', publicState()); });
    scope.on('log', pushLog);

    scope.on('sas', (sas) => { state.sas = sas.phrase; broadcast('state', publicState()); });
    scope.on('secure', (t) => {
      wasLive = true;
      state.transport = t;
      state.reconnect = null;
      onSessionChange?.(true);
      pauseRemoteListener();
      if (how.remember) { try { settings.update({ lastInvitation: invitation }); } catch { /* best effort */ } }
      logbook.info(`connected: ${t?.relayed ? 'relay' : 'direct'} ${t?.localType ?? ''}->${t?.remoteType ?? ''} ${t?.protocol ?? ''}`);
      setMode('viewing');
    });
    scope.on('media-config', (cfg) => {
      state.mediaConfig = cfg;
      logbook.info(`receiving ${cfg.width}x${cfg.height}@${cfg.fps} encoder=${cfg.encoder} capture=${cfg.capture}`);
      broadcast('state', publicState());
    });
    scope.on('stats', (s) => { state.stats = s; broadcast('stats', s); logStats('view', s); });
    scope.on('error', (e) => pushLog(`error: ${e.message}`));
    scope.on('closed', (reason) => {
      pushLog(`disconnected: ${reason}`);
      retryViewer(viewerOpts, invitation, reason, attempt, wasLive, how);
    });

    viewer.start().catch((err) => {
      if (!scope.current()) return;
      pushLog(`connect failed: ${err.message}`);
      retryViewer(viewerOpts, invitation, err.message, attempt, false, how);
    });
  }

  /**
   * After an unexpected drop the viewer comes back by itself: quickly at
   * first, then every 15 s at most, until it is connected again or the user
   * presses Cancel. A first attempt that never connected is not retried
   * (wrong code, host not sharing: the user needs to see that).
   */
  function retryViewer(viewerOpts, invitation, reason, attempt, wasLive, how) {
    const again = settings.get().autoReconnect !== false && !FINAL_REASON.test(reason) && (wasLive || attempt > 0);
    if (!again) { stopActive(reason); return; }
    endSession(reason);
    const next = wasLive ? 1 : attempt + 1;
    const delay = next === 1 ? 300 : Math.min(15_000, 1000 * 2 ** Math.min(4, next - 2));
    state.reconnect = { attempt: next, reason: String(reason).slice(0, 200), at: Date.now() + delay };
    setMode('reconnecting');
    pushLog(`reconnecting in ${(delay / 1000).toFixed(1)} s (attempt ${next})`);
    viewerRetry = {
      timer: setTimeout(() => { viewerRetry = null; if (!active) launchViewer(viewerOpts, invitation, next, how); }, delay),
    };
    viewerRetry.timer.unref?.();
  }

  /* ---------------------------- diagnostics ---------------------------- */

  // A single file a friend can send: environment, engine capabilities,
  // monitors, settings (no secrets), last network check and the recent log.
  async function writeDiagnostics() {
    const bin = findMediaBinary();
    const probe = bin ? await new Promise((resolve) => execFile(bin, ['probe'], { timeout: 8000, windowsHide: true },
      (err, out) => resolve(err ? `probe failed: ${err.message}` : String(out).trim()))) : 'media engine not found';
    const pub = settings.publicSettings();
    delete pub.builtinProfiles;
    const report = [
      `Penguin Stream diagnostics - ${new Date().toISOString()}`,
      `version ${APP_VERSION} · ${process.platform} ${os.release()} ${process.arch} · node ${process.versions.node}` +
        (process.versions.electron ? ` · electron ${process.versions.electron}` : ''),
      `cpu ${os.cpus()[0]?.model?.trim() ?? '?'} ×${os.cpus().length} · ram ${Math.round(os.totalmem() / 2 ** 30)} GB` +
        (process.env.XDG_SESSION_TYPE ? ` · ${process.env.XDG_SESSION_TYPE} ${process.env.XDG_CURRENT_DESKTOP ?? ''}` : ''),
      `mode ${state.mode}`,
      '', '--- media engine ---', probe,
      '', '--- monitors ---', JSON.stringify(await listMonitors({ fresh: true }).catch(() => []), null, 1),
      '', '--- settings (secrets removed) ---', JSON.stringify(pub, null, 1),
      '', '--- last network check ---', lastNetcheck ? JSON.stringify(lastNetcheck, null, 1) : 'not run',
      '', '--- current session stats ---', JSON.stringify(state.stats ?? {}, null, 1),
      '', '--- recent log ---', logbook.tail(600),
    ].join('\n');
    const { redact } = await import('../app/logbook.mjs');
    const file = path.join(logbook.dir, `diagnostics-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`);
    fs.mkdirSync(logbook.dir, { recursive: true });
    fs.writeFileSync(file, redact(report), { mode: 0o600 });
    pruneDiagnostics(logbook.dir);
    logbook.info(`diagnostics written: ${path.basename(file)}`);
    return file;
  }

  /* ------------------------------ server ------------------------------ */

  const server = http.createServer(async (req, res) => {
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'no-store');
    // DNS-rebinding guard: a page on evil.com resolving to 127.0.0.1 would
    // arrive with a non-loopback Host header.
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403).end('forbidden host');
      return;
    }
    const origin = req.headers.origin;
    if (origin && !isLoopbackHost(origin)) {
      res.writeHead(403).end('forbidden origin');
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith('/api/')) {
      const provided = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      const expected = Buffer.from(token);
      const got = Buffer.from(provided || '');
      if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"bad token"}');
        return;
      }

      const allowed = ['/api/state', '/api/monitors', '/api/logs'].includes(url.pathname) ? ['GET']
        : ['/api/settings', '/api/remote-access'].includes(url.pathname) ? ['GET', 'POST'] : ['POST'];
      if (!allowed.includes(req.method)) {
        req.resume(); // Drain rejected bodies so a keep-alive socket remains framed.
        res.writeHead(405, { allow: allowed.join(', ') }).end(); return;
      }
      let body = {};
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
          if (chunks.reduce((n, c) => n + c.length, 0) > 64 * 1024) {
            res.writeHead(413, { connection: 'close' }).end();
            return;
          }
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch { res.writeHead(400).end('{"error":"bad json"}'); return; }
      }

      const json = (obj, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      try {
        switch (url.pathname) {
          case '/api/state': return json(publicState());
          case '/api/settings':
            if (req.method === 'POST') {
              // Remote access is switched on/off and its code changed only
              // through /api/remote-access (it starts/stops the listener).
              const { remoteAccess, accessCode, startAtLogin, ...rest } = body ?? {};
              settings.update(rest);
              if ('remoteKeepAwake' in rest) remoteChanged();
              if (Object.keys(rest).some((k) => REMOTE_SESSION_KEYS.has(k))) refreshRemoteListener();
            }
            return json(settings.publicSettings());
          case '/api/remote-access': {
            if (req.method === 'GET') {
              return json({ ...remotePublic(), code: remote ? remote.code : null });
            }
            switch (body.action) {
              case 'enable': return json({ ...(await enableRemote()), code: remote?.code ?? null });
              case 'disable': return json(disableRemote());
              case 'new-code': return json({ ...remotePublic(), code: newAccessCode() });
              case 'end-session':
                if (!active?.remote) return json({ error: 'no remote access session is running' }, 409);
                finishRemoteLive('ended at this PC', 'The session was ended at the remote computer.');
                return json(remotePublic());
              case 'prepare': return json({ ...(await prepareRemote()), ...remotePublic() });
              case 'start-at-login': {
                if (typeof body.on !== 'boolean') return json({ error: 'on must be boolean' }, 400);
                if (typeof desktop.setStartAtLogin !== 'function') return json({ error: 'only the desktop app can start with your computer' }, 409);
                const ok = await desktop.setStartAtLogin(body.on);
                if (ok === false) return json({ error: 'could not change the login item' }, 500);
                settings.update({ startAtLogin: body.on });
                remoteChanged();
                return json(remotePublic());
              }
              default: return json({ error: 'action must be enable, disable, new-code, end-session, prepare or start-at-login' }, 400);
            }
          }
          case '/api/monitors': return json({ monitors: await listMonitors({ fresh: true }) });
          case '/api/logs': return json({ path: logbook.file, dir: logbook.dir, text: logbook.tail(500) });
          case '/api/logs/open': openPath(logbook.dir); return json({ ok: true, dir: logbook.dir });
          case '/api/diagnostics': {
            const file = await writeDiagnostics();
            openPath(logbook.dir);
            return json({ ok: true, path: file });
          }
          case '/api/profile': {
            if (body.action === 'apply') settings.applyProfile(String(body.id ?? ''));
            else if (body.action === 'save') settings.saveProfile(String(body.name ?? ''));
            else if (body.action === 'delete') settings.deleteProfile(String(body.id ?? ''));
            else return json({ error: 'action must be apply, save or delete' }, 400);
            if (body.action === 'apply') refreshRemoteListener();
            const s = settings.get();
            // A live share follows the new bitrate right away.
            if (active?.kind === 'host' && body.action === 'apply') {
              active.instance.setBitrate(s.bitrate);
              active.instance.setAdaptive(s.adaptiveBitrate);
            }
            return json(settings.publicSettings());
          }
          case '/api/stream': {
            // Live changes during a session (no restart needed).
            const kbps = Number(body.bitrate);
            if (body.bitrate !== undefined && !(Number.isInteger(kbps) && kbps >= 500 && kbps <= 200000)) {
              return json({ error: 'bitrate must be 500..200000 kbps' }, 400);
            }
            if (body.adaptive !== undefined && typeof body.adaptive !== 'boolean') return json({ error: 'adaptive must be boolean' }, 400);
            if (active?.kind === 'host') {
              if (body.bitrate !== undefined) active.instance.setBitrate(kbps);
              if (body.adaptive !== undefined) active.instance.setAdaptive(body.adaptive);
            } else if (active?.kind === 'viewer') {
              if (body.bitrate !== undefined) active.instance.requestBitrate(kbps);
            } else {
              return json({ error: 'no session' }, 409);
            }
            return json({ ok: true });
          }
          case '/api/netcheck': {
            netcheck ??= runNetcheck(settings.get().relay).then((r) => {
              lastNetcheck = r;
              logbook.info(`network check: ${r.verdict?.level} - ${r.verdict?.text ?? ''} | v4 ${r.v4?.ok ? `nat=${r.v4.natted} mapping=${r.v4.mapping}` : 'unavailable'} ` +
                `| v6 ${r.v6?.ok ? 'yes' : 'no'} | relay ${r.relay?.configured ? (r.relay.ok ? 'ok' : 'failed') : 'none'}`);
              return r;
            }).finally(() => { netcheck = null; });
            return json(await netcheck);
          }
          case '/api/host': return json(await startHost(body));
          case '/api/connect': return json(await startViewer(body));
          case '/api/new-code': return json({ ok: true, code: newShareCode() });
          case '/api/stop': stopActive('stopped by user'); return json({ ok: true });
          case '/api/permissions': {
            if (active?.kind !== 'host') return json({ error: 'not sharing' }, 409);
            if ((body.kbm !== undefined && typeof body.kbm !== 'boolean') ||
                (body.pad !== undefined && typeof body.pad !== 'boolean')) {
              return json({ error: 'kbm and pad must be booleans' }, 400);
            }
            active.instance.setPermissions({ kbm: body.kbm, pad: body.pad });
            return json({ ok: true });
          }
          case '/api/viewer-input': {
            if (active?.kind !== 'viewer') return json({ error: 'not connected' }, 409);
            const change = {};
            for (const k of ['kbm', 'pad', 'capture', 'overlay']) {
              if (body[k] === undefined) continue;
              if (typeof body[k] !== 'boolean') return json({ error: `${k} must be a boolean` }, 400);
              change[k] = body[k];
            }
            active.instance.setInput(change);
            return json({ ok: true });
          }
          case '/api/consent': {
            if (!pendingConsent?.resolve) return json({ error: 'nothing awaiting consent' }, 409);
            if (typeof body.approve !== 'boolean') return json({ error: 'approve must be boolean' }, 400);
            pendingConsent.resolve(body.approve);
            return json({ ok: true });
          }
          case '/api/revoke': {
            const peer = trust.list().find((p) => p.fingerprint === body.fingerprint);
            if (!peer) return json({ error: 'unknown device' }, 404);
            trust.revoke(peer.publicKey);
            return json({ ok: true });
          }
          default: return json({ error: 'not found' }, 404);
        }
      } catch (err) {
        return json({ error: err.message }, 400);
      }
    }

    // Static files. Decode first, then reject traversal: '%2e%2e' must not
    // survive as '..' after decoding.
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end('bad path');
      return;
    }
    rel = rel === '/' ? 'index.html' : rel.replace(/^\/+/, '');
    if (rel.split(/[\\/]/).some((seg) => seg === '..')) {
      res.writeHead(403).end('forbidden path');
      return;
    }
    const file = path.resolve(PUBLIC, rel);
    if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
      res.writeHead(403).end('forbidden path');
      return;
    }

    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        // The UI is entirely local and loads no third-party anything.
        'content-security-policy':
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:",
        'x-content-type-options': 'nosniff',
      });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024,
    verifyClient: ({ req }) => isLoopbackHost(req.headers.host)
      && (!req.headers.origin || isLoopbackHost(req.headers.origin)),
  });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.searchParams.get('token') !== token) { ws.close(4001, 'bad token'); return; }
    if (clients.size >= 8) { ws.close(4008, 'client limit'); return; }
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'state', data: publicState() }));
    ws.on('close', () => clients.delete(ws));
  });

  // A second copy (or another app) may already use the port: take any free one.
  await new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && port !== 0) {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      } else {
        reject(err);
      }
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => { server.off('error', onError); resolve(); });
  });

  const actualPort = server.address().port;
  const link = `http://127.0.0.1:${actualPort}/#token=${token}`;

  if (!quiet) {
    console.log('\n  penguin-stream is running.\n');
    console.log(`  Local UI: http://127.0.0.1:${actualPort}/ (authorized URL opened in browser; token omitted from logs)\n`);
    console.log('  (private local capability URL; do not share it)\n');
  }

  if (open) openBrowser(link);

  // Remote access survives restarts: it was on, so listen again.
  if (settings.get().remoteAccess === true) {
    enableRemote({ startup: true }).catch((err) => pushLog(`remote access could not start: ${err.message}`));
  }

  const close = async () => {
    // Stop listening without switching remote access off (it resumes next start).
    if (remote) {
      const r = remote;
      remote = null;
      clearTimeout(r.timer);
      try { r.listener?.close('shutting down'); } catch { /* closed */ }
      r.listener = null;
    }
    stopActive('shutting down');
    logbook.info('=== Penguin Stream stop ===');
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    for (const ws of clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  };
  const shutdown = () => {
    void close().then(() => cleanupTransport()).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return {
    port: actualPort, token, url: link, close,
    // For the desktop shell (tray menu): same actions as the UI.
    remoteAccess: {
      state: () => remotePublic(),
      enable: () => enableRemote(),
      disable: () => disableRemote(),
      endSession: () => { if (active?.remote) finishRemoteLive('ended at this PC', 'The session was ended at the remote computer.'); },
    },
  };
}

/** Keeps only the newest `keep` diagnostics reports (1.4.0 kept every one forever). */
export function pruneDiagnostics(dir, keep = 5) {
  try {
    const old = fs.readdirSync(dir).filter((f) => /^diagnostics-.*\.txt$/.test(f)).sort().slice(0, -keep);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* best effort */ }
}

/**
 * Starts a helper program (file manager, browser) and forgets it. A missing
 * program (no xdg-open on a minimal/immutable distro) is reported by Node as
 * an ASYNC 'error' event, not a throw - unhandled, it crashed the whole app.
 * @returns {boolean} false if it could not even be started synchronously
 */
export function spawnDetached(cmd, args, options = {}, spawnFn = spawn) {
  try {
    const child = spawnFn(cmd, args, { detached: true, stdio: 'ignore', ...options });
    child.on('error', () => { /* no such program: the UI already shows the path/link */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Opens a folder in the system file manager (log folder). */
function openPath(dir) {
  if (process.platform === 'win32') spawnDetached('explorer.exe', [dir], { windowsHide: false });
  else spawnDetached(process.platform === 'darwin' ? 'open' : 'xdg-open', [dir]);
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    // `start` needs an explicit empty title argument, and Node's argument
    // quoting would mangle it, so build the command line verbatim. The URL
    // contains only [A-Za-z0-9:/.#=_-] (base64url token), nothing cmd-special.
    spawnDetached('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], { windowsHide: true, windowsVerbatimArguments: true });
  } else {
    spawnDetached(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  }
}
