#!/usr/bin/env node
/**
 * penguin-stream CLI.
 *
 * The onboarding target: no account, no certificate warning, no port
 * forwarding, no separate client download on the host side.
 *
 *   host:   penguin-stream host              -> prints a code, waits
 *   viewer: penguin-stream connect <INVITATION> -> compares four words, streams
 */

import readline from 'node:readline';
import process from 'node:process';

import { Host, Viewer, DEFAULT_RENDEZVOUS } from './app/session.mjs';
import { parseInvitation } from './signal/code.mjs';
import { startRendezvous } from './signal/server.mjs';
import { startTurnServer } from '../../turn/src/server.mjs';
import { loadOrCreateIdentity, TrustStore, configDir } from './crypto/identity.mjs';
import { cleanupTransport } from './transport/peer.mjs';
import { findMediaBinary } from './media/engine.mjs';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = new Proxy(C, { get: (t, k) => (useColor ? t[k] : '') });

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

function banner(text) {
  const line = '─'.repeat(text.length + 4);
  console.log(`${c.cyan}┌${line}┐${c.reset}`);
  console.log(`${c.cyan}│  ${c.bold}${text}${c.reset}${c.cyan}  │${c.reset}`);
  console.log(`${c.cyan}└${line}┘${c.reset}`);
}

/* ------------------------------- host -------------------------------- */

async function cmdHost(args) {
  if (!findMediaBinary()) {
    console.error(`${c.red}The media engine is not built.${c.reset}\n` +
      '  cmake -B media/build -S media -G Ninja && cmake --build media/build');
    process.exit(1);
  }

  const host = new Host({
    rendezvousUrl: args.rendezvous || DEFAULT_RENDEZVOUS,
    source: args.source,
    fps: args.fps ? Number(args.fps) : undefined,
    bitrateKbps: args.bitrate ? Number(args.bitrate) : undefined,
    encoder: args.encoder,
    forceRelay: Boolean(args['force-relay']),
    allowInput: Boolean(args['allow-input']) && !args['no-input'],
    audio: Boolean(args.audio),
    turn: args.turn,
    turnUser: args['turn-user'],
    turnPassword: args['turn-password'],
    stun: args.stun,
    sessionTimeoutMs: args.timeout ? Number(args.timeout) * 1000 : undefined,
  });

  let lastPrinted = 0;
  host.on('code', (code) => {
    console.log();
    banner(`Share code:  ${code}`);
    console.log(`\n  On the other machine run:  ${c.bold}penguin-stream connect ${code}${c.reset}`);
    console.log(`  ${c.dim}Waiting for someone to connect...${c.reset}\n`);
  });

  host.on('log', (m) => console.log(`${c.dim}  ${m}${c.reset}`));
  host.on('error', (e) => console.error(`${c.red}error: ${e.message}${c.reset}`));

  let lastHostStats = null;
  host.on('stats', (s) => {
    lastHostStats = s;
    const fps = Number(s.fps || 0).toFixed(1);
    const kbps = Number(s.kbps || 0).toFixed(0);
    const line = `streaming: ${fps} fps, ${kbps} kbps, ${s.framesSent} frames sent`;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${c.dim}  ${line}${c.reset}   `);
    } else if (Date.now() - lastPrinted > 10_000) {
      // Redirected to a log: periodic lines instead of a rewritten one.
      lastPrinted = Date.now();
      console.log(`  ${line}`);
    }
  });

  host.on('closed', (reason) => {
    if (lastHostStats) {
      console.log(`\n  session summary: ${lastHostStats.framesSent} frames sent, ` +
        `${((lastHostStats.bytesSent || 0) / 1e6).toFixed(1)} MB encoded`);
    }
    console.log(`${c.yellow}session ended: ${reason}${c.reset}`);
    cleanupTransport();
    process.exit(0);
  });

  const autoAccept = Boolean(args.yes);

  await host.start(async (req) => {
    console.log();
    console.log(`${c.bold}A viewer wants to connect.${c.reset}`);
    console.log(`  device fingerprint : ${req.fingerprint}`);
    console.log(`  previously paired  : ${req.trusted ? `${c.green}yes${c.reset} (${req.label})` : `${c.yellow}no - first time${c.reset}`}`);
    console.log(`  connection         : ${req.transport?.relayed ? 'relayed' : 'direct'}`);
    console.log();
    console.log(`  ${c.bold}Verification words:${c.reset}  ${c.cyan}${c.bold}${req.sas}${c.reset}`);
    console.log(`  ${c.dim}The other side must show exactly these four words.${c.reset}`);
    console.log(`  ${c.dim}If they differ, someone is intercepting the connection - say no.${c.reset}`);
    console.log();

    if (autoAccept && args.source !== 'synthetic') {
      throw new Error('--yes is restricted to --source synthetic; real desktop requires explicit approval');
    }
    if (autoAccept) {
      console.log(`${c.yellow}  --yes given: accepting without asking.${c.reset}`);
      return true;
    }
    const answer = await ask('  Allow this connection? [y/N] ');
    const ok = /^y(es)?$/i.test(answer);
    console.log(ok ? `${c.green}  accepted${c.reset}` : `${c.red}  refused${c.reset}`);
    return ok;
  });
}

/* ------------------------------ connect ------------------------------ */

async function cmdConnect(args) {
  const code = args._[0] || args.code;
  if (!code) {
    console.error('usage: penguin-stream connect <share-code>');
    process.exit(2);
  }
  if (!findMediaBinary()) {
    console.error(`${c.red}The media engine is not built.${c.reset}\n` +
      '  cmake -B media/build -S media -G Ninja && cmake --build media/build');
    process.exit(1);
  }

  const viewer = new Viewer({
    code,
    rendezvousUrl: args.rendezvous || DEFAULT_RENDEZVOUS,
    forceRelay: Boolean(args['force-relay']),
    noInput: !args['allow-input'] || Boolean(args['no-input']),
    audio: Boolean(args.audio),
    turn: args.turn,
    turnUser: args['turn-user'],
    turnPassword: args['turn-password'],
    stun: args.stun,
  });

  console.log(`${c.dim}connecting...${c.reset}`);

  viewer.on('sas', (sas) => {
    console.log();
    banner(`Verification words:  ${sas.phrase}`);
    console.log(`\n  ${c.dim}Check these match what the host is showing before you trust the session.${c.reset}\n`);
  });

  viewer.on('secure', (t) => {
    console.log(`${c.green}connected${c.reset} (${t.relayed ? 'via relay' : 'direct'}, ${t.localType} -> ${t.remoteType})`);
  });
  viewer.on('media-config', (cfg) => {
    console.log(`${c.dim}  stream: ${cfg.width}x${cfg.height} ${cfg.codec}, host encoder ${cfg.encoder}${c.reset}`);
    console.log(`${c.dim}  press Ctrl+Shift+Q in the window to disconnect${c.reset}`);
  });
  let lastViewerStats = null;
  let lastViewerPrint = 0;
  viewer.on('stats', (s) => {
    lastViewerStats = s;
    const line = `${s.framesShown} frames, ${(s.bytesReceived / 1e6).toFixed(1)} MB` +
      (s.dropped ? `, ${s.dropped} dropped` : '');
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${c.dim}  ${line}${c.reset}   `);
    } else if (Date.now() - lastViewerPrint > 10_000) {
      lastViewerPrint = Date.now();
      console.log(`  ${line}`);
    }
  });
  viewer.on('error', (e) => console.error(`${c.red}error: ${e.message}${c.reset}`));
  viewer.on('closed', (reason) => {
    if (lastViewerStats) {
      console.log(`\n  session summary: ${lastViewerStats.framesShown} frames decoded, ` +
        `${(lastViewerStats.bytesReceived / 1e6).toFixed(1)} MB received` +
        (lastViewerStats.dropped ? `, ${lastViewerStats.dropped} frames dropped` : ''));
    }
    console.log(`${c.yellow}disconnected: ${reason}${c.reset}`);
    cleanupTransport();
    process.exit(0);
  });

  await viewer.start();
}

/* ------------------------- supporting services ------------------------ */

async function cmdRendezvous(args) {
  const port = Number(args.port || 8787);
  const rv = await startRendezvous({ port, host: args.host || '0.0.0.0' });
  console.log(`rendezvous listening on port ${rv.port}`);
  console.log(`  clients use: --rendezvous ws://<this-host>:${rv.port}`);
  console.log(`  health: http://127.0.0.1:${rv.port}/health`);
  console.log(`${c.dim}  it relays encrypted blobs only; it cannot read your session${c.reset}`);
}

async function cmdTurn(args) {
  const port = Number(args.port || 3478);
  const user = args.user || 'penguin';
  const password = args.password || (await import('node:crypto')).randomBytes(18).toString('base64url');
  const { server } = await startTurnServer({
    port,
    users: { [user]: password },
    listenAddress: args.bind || '0.0.0.0',
    relayAddress: args['relay-address'] || '127.0.0.1',
    multiHomed: Boolean(args['multi-homed']),
  });
  console.log(`TURN relay listening on port ${server.port} (realm ${server.realm})`);
  console.log(`  user: ${user}`);
  if (!args.password) console.log(`  generated password: ${password}`);
  console.log(`  peers use: --turn turn:<host>:${server.port} --turn-user ${user} --turn-password <password>`);
  setInterval(() => {
    const s = server.stats;
    console.log(`${c.dim}  [turn] allocations=${s.allocations} relayed=${s.bytesRelayed} bytes${c.reset}`);
  }, 30_000).unref?.();
}

/* ------------------------------ utility ------------------------------ */

function cmdId() {
  const id = loadOrCreateIdentity();
  const trust = new TrustStore();
  console.log(`${c.bold}This device${c.reset}`);
  console.log(`  label       : ${id.label}`);
  console.log(`  fingerprint : ${id.fingerprint}`);
  console.log(`  config      : ${configDir()}`);
  const peers = trust.list();
  console.log(`\n${c.bold}Paired devices (${peers.length})${c.reset}`);
  for (const p of peers) {
    console.log(`  ${p.fingerprint}  ${p.role.padEnd(6)}  ${p.label}  ${c.dim}last seen ${p.lastSeen}${c.reset}`);
  }
  if (peers.length === 0) console.log(`  ${c.dim}none yet${c.reset}`);
}

function cmdRevoke(args) {
  const target = args._[0];
  if (!target) {
    console.error('usage: penguin-stream revoke <fingerprint|all>');
    process.exit(2);
  }
  const trust = new TrustStore();
  if (target === 'all') {
    const n = trust.list().length;
    for (const p of trust.list()) trust.revoke(p.publicKey);
    console.log(`revoked ${n} device(s)`);
    return;
  }
  const match = trust.list().find((p) => p.fingerprint.replace(/-/g, '').toUpperCase() ===
                                         target.replace(/-/g, '').toUpperCase());
  if (!match) {
    console.error(`no paired device with fingerprint ${target}`);
    process.exit(1);
  }
  trust.revoke(match.publicKey);
  console.log(`revoked ${match.fingerprint} (${match.label})`);
}

function usage() {
  console.log(`${c.bold}penguin-stream${c.reset} - peer-to-peer remote desktop

${c.bold}Usage${c.reset}
  penguin-stream host [options]              share this screen
  penguin-stream connect <code> [options]    view a shared screen
  penguin-stream ui [--port N]               open the local web interface
  penguin-stream rendezvous [--port 8787]    run a rendezvous server
  penguin-stream turn [--port 3478]          run a TURN relay for CGNAT peers
  penguin-stream id                          show this device and paired peers
  penguin-stream revoke <fingerprint|all>    forget a paired device
  penguin-stream doctor                      check what works on this machine

${c.bold}Common options${c.reset}
  --rendezvous <ws://host:port>   rendezvous server (default ${DEFAULT_RENDEZVOUS})
  --turn <turn:host:port>         TURN relay for CGNAT / strict NAT
  --turn-user, --turn-password    TURN credentials
  --stun <stun:host:port>         STUN server for NAT discovery
  --force-relay                   request relay-only ICE (verify actual path; no privacy guarantee)

${c.bold}Host options${c.reset}
  --source <portal|x11|synthetic> capture backend (default: auto)
  --fps <n>                       target frame rate (default 60)
  --bitrate <kbps>                target bitrate (default 15000)
  --encoder <auto|vaapi|nvenc|x264>
  --allow-input                   opt in to remote control (portal permission required)
  --no-input                      view-only (default); ignore remote keyboard/mouse
  --audio                         opt in to Linux desktop audio capture/playback
  --yes                           synthetic-source tests only: skip human approval
`);
}

/* -------------------------------- main -------------------------------- */

const argv = process.argv.slice(2);
const command = argv[0];
const args = parseArgs(argv.slice(1));

const commands = {
  host: cmdHost,
  connect: cmdConnect,
  rendezvous: cmdRendezvous,
  turn: cmdTurn,
  id: cmdId,
  revoke: cmdRevoke,
};

try {
  if (!command || command === 'help' || args.help) {
    usage();
  } else if (command === 'ui') {
    const { startUi } = await import('./ui/server.mjs');
    await startUi({ port: Number(args.port || 47800), open: !args['no-open'] });
  } else if (command === 'doctor') {
    const { runDoctor } = await import('./doctor.mjs');
    process.exitCode = await runDoctor();
  } else if (commands[command]) {
    await commands[command](args);
  } else {
    console.error(`unknown command: ${command}\n`);
    usage();
    process.exit(2);
  }
} catch (err) {
  console.error(`${c.red}${err.message}${c.reset}`);
  if (process.env.PENGUIN_DEBUG) console.error(err.stack);
  cleanupTransport();
  process.exit(1);
}
