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
import { loadOrCreateIdentity, TrustStore } from '../crypto/identity.mjs';
import { cleanupTransport } from '../transport/peer.mjs';
import { SettingsStore, resolutionBox, sanitizeResolution } from '../app/settings.mjs';
import { listMonitors, resolveMonitor, workspaceOf } from '../app/monitors.mjs';
import { runNetcheck } from '../net/netcheck.mjs';
import { Logbook, statLine } from '../app/logbook.mjs';
import { findMediaBinary } from '../media/engine.mjs';
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

export async function startUi({ port = 47800, open = true, quiet = false, HostClass = Host, ViewerClass = Viewer,
  consentTimeoutMs = 120_000 } = {}) {
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
    platform: process.platform,
    version: APP_VERSION,
  });

  const stopActive = (reason = 'stopped by user') => {
    const previous = active;
    active = null;
    ++generation;
    clearTimeout(pendingConsent?.timer);
    pendingConsent?.resolve?.(false);
    pendingConsent = null;
    try { previous?.instance.close(reason); } catch { /* already closing */ }
    state.code = null;
    state.sas = null;
    state.transport = null;
    state.mediaConfig = null;
    state.stats = {};
    state.permissions = null;
    state.inputStatus = null;
    state.remoteViewer = null;
    state.viewerState = null;
    state.hostPermissions = null;
    setMode('idle');
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

  async function startHost(opts) {
    if (active) throw new Error('a session is already running');

    // Stream settings: the request may override the saved ones for this share.
    const saved = settings.get();
    const pick = (k) => (opts[k] !== undefined ? opts[k] : saved[k]);
    const box = resolutionBox(sanitizeResolution(pick('resolution')) ?? saved.resolution);
    const monitors = await listMonitors({ fresh: true }).catch(() => []);
    const monitorChoice = typeof pick('monitor') === 'string' ? pick('monitor') : 'primary';
    const monitor = resolveMonitor(monitors, monitorChoice);
    // Remote-desktop and screen-cast grants are different kinds of token.
    const tokenKey = `${process.platform}:rd:${monitor ? monitor.id : 'all'}`;
    const restoreToken = saved.portalTokens?.[tokenKey];
    const num = (v) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

    const host = new HostClass({
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
      restoreToken,
      encoder: typeof pick('encoder') === 'string' && /^(auto|nvenc|amf|qsv|mf|vaapi|x264|software)$/.test(pick('encoder'))
        ? pick('encoder') : undefined,
      allowInput: opts.allowInput === true,
      allowGamepad: opts.allowGamepad === true,
      // Ask Wayland for remote-control permission up front, so control can be
      // switched on later in the session without restarting the share.
      inputCapable: true,
      audio: opts.audio === true,
      audioFilter: (() => {
        const saved = settings.get();
        return { excludeVoice: saved.audioExcludeVoice, exclude: saved.audioExclude, only: saved.audioOnly };
      })(),
    });

    active = { kind: 'host', instance: host };
    const scope = bindSession(host);
    state.permissions = { ...host.permissions };
    setMode('hosting-waiting');
    scope.on('permissions', (p) => { state.permissions = { ...p }; broadcast('state', publicState()); });
    scope.on('input-status', (st) => { state.inputStatus = st; broadcast('state', publicState()); });
    scope.on('viewer-state', (v) => { state.remoteViewer = v; broadcast('state', publicState()); });

    scope.on('code', (code) => { state.code = code; broadcast('state', publicState()); });
    // Wayland remembered the screen choice: reuse it next time (no picker).
    scope.on('restore-token', (tok) => {
      try { settings.update({ portalTokens: { ...(settings.get().portalTokens || {}), [tokenKey]: tok } }); } catch { /* best effort */ }
    });
    if (monitor) pushLog(`sharing monitor ${monitor.label || monitor.id}`);
    scope.on('audio-warning', (w) => { pushLog(`audio warning: ${w}`); broadcast('notice', w); });
    scope.on('log', pushLog);
    scope.on('stats', (s) => { state.stats = s; broadcast('stats', s); logStats('host', s); });
    scope.on('media-config', (cfg) => {
      state.mediaConfig = cfg;
      logbook.info(`stream ${cfg.width}x${cfg.height}@${cfg.fps} from ${cfg.sourceWidth ?? cfg.width}x${cfg.sourceHeight ?? cfg.height} ` +
        `encoder=${cfg.encoder} capture=${cfg.capture}${cfg.intraRefresh ? ' intra-refresh' : ''}`);
      broadcast('state', publicState());
    });
    scope.on('secure', (t) => logbook.info(`connected: ${t?.relayed ? 'relay' : 'direct'} ${t?.localType ?? ''}->${t?.remoteType ?? ''} ${t?.protocol ?? ''}`));
    scope.on('error', (e) => pushLog(`error: ${e.message}`));
    scope.on('closed', (reason) => { pushLog(`session ended: ${reason}`); stopActive(reason); });
    logbook.info(`share: fps=${num(pick('fps')) ?? 60} bitrate=${num(pick('bitrate')) ?? 15000} resolution=${pick('resolution')} ` +
      `adaptive=${pick('adaptiveBitrate') !== false} monitor=${monitor ? monitor.label : 'system picker'} ` +
      `monitors=${monitors.map((m) => `${m.name}:${m.id}${m.primary ? '*' : ''}`).join(' ') || 'unknown'}`);

    // Resolved by the /api/consent endpoint when the user clicks.
    host.start(async (request) => {
      if (!scope.current() || pendingConsent) return false;
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
        state.sas = request.sas;
        setMode('hosting-live');
      } else {
        pushLog('connection refused');
        setMode('hosting-waiting');
      }
      return decision;
    }).catch((err) => {
      if (!scope.current()) return;
      pushLog(`host failed: ${err.message}`);
      stopActive(err.message);
    });

    return { ok: true };
  }

  async function startViewer(opts) {
    if (active) throw new Error('a session is already running');
    if (!opts.code) throw new Error('a share code is required');
    // Validate up front: viewer.start() runs detached, so a bad code would
    // otherwise be reported as success and only fail asynchronously.
    let code = opts.code;
    let rendezvous = opts.rendezvous;
    try {
      const parsed = parseInvitation(opts.code);
      code = parsed.code;
      if (!rendezvous && parsed.rendezvousUrl) rendezvous = parsed.rendezvousUrl;
    } catch (err) {
      throw new Error(`that share code does not look right: ${err.message}`);
    }

    const viewer = new ViewerClass({
      ...commonOptions({ ...opts, rendezvous }),
      code,
      sendKbm: opts.sendKbm !== false,
      sendPad: opts.sendPad !== false,
      lowLatency: opts.lowLatency !== false,
      overlay: (opts.overlay !== undefined ? opts.overlay : settings.get().overlay) === true,
      audio: opts.audio === true,
    });

    active = { kind: 'viewer', instance: viewer };
    const scope = bindSession(viewer);
    setMode('connecting');
    scope.on('viewer-state', (v) => { state.viewerState = v; broadcast('state', publicState()); });
    scope.on('host-permissions', (p) => { state.hostPermissions = p; broadcast('state', publicState()); });
    scope.on('log', pushLog);

    scope.on('sas', (sas) => { state.sas = sas.phrase; broadcast('state', publicState()); });
    scope.on('secure', (t) => {
      state.transport = t;
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
    scope.on('closed', (reason) => { pushLog(`disconnected: ${reason}`); stopActive(reason); });

    viewer.start().catch((err) => {
      if (!scope.current()) return;
      pushLog(`connect failed: ${err.message}`);
      stopActive(err.message);
    });

    return { ok: true };
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
        : url.pathname === '/api/settings' ? ['GET', 'POST'] : ['POST'];
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
            if (req.method === 'POST') settings.update(body);
            return json(settings.publicSettings());
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

  const close = async () => {
    stopActive('shutting down');
    logbook.info('=== Penguin Stream stop ===');
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    for (const ws of clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  };
  const shutdown = () => {
    void close().then(() => { cleanupTransport(); process.exit(0); });
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { port: actualPort, token, url: link, close };
}

/** Opens a folder in the system file manager (log folder). */
function openPath(dir) {
  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } else {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* no file manager: the path is shown in the UI */ }
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      // `start` needs an explicit empty title argument, and Node's argument
      // quoting would mangle it, so build the command line verbatim. The URL
      // contains only [A-Za-z0-9:/.#=_-] (base64url token), nothing cmd-special.
      spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], {
        detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
      }).unref();
    } else {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Headless or no browser: the printed link is the fallback.
  }
}
