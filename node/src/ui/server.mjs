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

import { Host, Viewer, DEFAULT_RENDEZVOUS } from '../app/session.mjs';
import { normalizeShareCode } from '../signal/code.mjs';
import { loadOrCreateIdentity, TrustStore } from '../crypto/identity.mjs';
import { cleanupTransport } from '../transport/peer.mjs';

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

export async function startUi({ port = 47800, open = true } = {}) {
  const token = crypto.randomBytes(24).toString('base64url');
  const identity = loadOrCreateIdentity();
  const trust = new TrustStore();

  /** @type {{kind:'host'|'viewer', instance:any}|null} */
  let active = null;
  let pendingConsent = null;   // { request, resolve }
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
  };

  const pushLog = (line) => {
    state.log.push(`${new Date().toISOString().slice(11, 19)}  ${line}`);
    if (state.log.length > 200) state.log.shift();
    broadcast('log', line);
  };

  const setMode = (mode) => {
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
    rendezvous: DEFAULT_RENDEZVOUS,
  });

  const stopActive = (reason = 'stopped by user') => {
    if (!active) return;
    try { active.instance.close(reason); } catch { /* already closing */ }
    active = null;
    state.code = null;
    state.sas = null;
    state.transport = null;
    state.mediaConfig = null;
    state.stats = {};
    pendingConsent?.resolve?.(false);
    pendingConsent = null;
    setMode('idle');
  };

  /* ----------------------------- actions ----------------------------- */

  async function startHost(opts) {
    if (active) throw new Error('a session is already running');

    const host = new Host({
      rendezvousUrl: opts.rendezvous || DEFAULT_RENDEZVOUS,
      source: opts.source || undefined,
      fps: opts.fps ? Number(opts.fps) : undefined,
      bitrateKbps: opts.bitrate ? Number(opts.bitrate) : undefined,
      allowInput: opts.allowInput === true,
      forceRelay: Boolean(opts.forceRelay),
      turn: opts.turn || undefined,
      turnUser: opts.turnUser || undefined,
      turnPassword: opts.turnPassword || undefined,
      sessionTimeoutMs: 15 * 60 * 1000,
    });

    active = { kind: 'host', instance: host };
    setMode('hosting-waiting');

    host.on('code', (code) => { state.code = code; broadcast('state', publicState()); });
    host.on('log', pushLog);
    host.on('stats', (s) => { state.stats = s; broadcast('stats', s); });
    host.on('media-config', (cfg) => { state.mediaConfig = cfg; broadcast('state', publicState()); });
    host.on('error', (e) => pushLog(`error: ${e.message}`));
    host.on('closed', (reason) => { pushLog(`session ended: ${reason}`); stopActive(reason); });

    // Resolved by the /api/consent endpoint when the user clicks.
    host.start(async (request) => {
      pendingConsent = { request, resolve: null };
      broadcast('consent', request);
      setMode('hosting-consent');

      const decision = await new Promise((resolve) => {
        pendingConsent.resolve = resolve;
        // Never hang forever waiting for a human: refuse after two minutes.
        setTimeout(() => resolve(false), 120_000);
      });

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
    let code;
    try {
      code = normalizeShareCode(opts.code);
    } catch (err) {
      throw new Error(`that share code does not look right: ${err.message}`);
    }

    const viewer = new Viewer({
      code,
      rendezvousUrl: opts.rendezvous || DEFAULT_RENDEZVOUS,
      forceRelay: Boolean(opts.forceRelay),
      noInput: opts.allowInput !== true,
      turn: opts.turn || undefined,
      turnUser: opts.turnUser || undefined,
      turnPassword: opts.turnPassword || undefined,
    });

    active = { kind: 'viewer', instance: viewer };
    setMode('connecting');

    viewer.on('sas', (sas) => { state.sas = sas.phrase; broadcast('state', publicState()); });
    viewer.on('secure', (t) => { state.transport = t; setMode('viewing'); });
    viewer.on('media-config', (cfg) => { state.mediaConfig = cfg; broadcast('state', publicState()); });
    viewer.on('stats', (s) => { state.stats = s; broadcast('stats', s); });
    viewer.on('error', (e) => pushLog(`error: ${e.message}`));
    viewer.on('closed', (reason) => { pushLog(`disconnected: ${reason}`); stopActive(reason); });

    viewer.start().catch((err) => {
      pushLog(`connect failed: ${err.message}`);
      stopActive(err.message);
    });

    return { ok: true };
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
      const provided = req.headers.authorization?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
      const expected = Buffer.from(token);
      const got = Buffer.from(provided || '');
      if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"bad token"}');
        return;
      }

      if (url.pathname !== '/api/state' && req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' }).end(); return;
      }
      let body = {};
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
          if (chunks.reduce((n, c) => n + c.length, 0) > 64 * 1024) {
            res.writeHead(413).end();
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
          case '/api/host': return json(await startHost(body));
          case '/api/connect': return json(await startViewer(body));
          case '/api/stop': stopActive('stopped by user'); return json({ ok: true });
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

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const actualPort = server.address().port;
  const link = `http://127.0.0.1:${actualPort}/?token=${token}`;

  console.log('\n  penguin-stream is running.\n');
  console.log(`  Open:  ${link}\n`);
  console.log('  (private local capability URL; do not share it)\n');

  if (open) openBrowser(link);

  const shutdown = () => {
    stopActive('shutting down');
    cleanupTransport();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { port: actualPort, token, url: link, close: shutdown };
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Headless or no browser: the printed link is the fallback.
  }
}
