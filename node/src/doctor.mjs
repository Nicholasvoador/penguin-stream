/**
 * `penguin-stream doctor` - tells the user what will and will not work on this
 * machine, before they try to use it in front of someone else.
 *
 * Every check reports what was actually observed. Nothing is assumed to work
 * because it is usually present.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

import { findMediaBinary, MEDIA_MISSING } from './media/engine.mjs';
import { loadOrCreateIdentity, configDir } from './crypto/identity.mjs';
import { DEFAULT_RENDEZVOUS, APP_VERSION } from './app/session.mjs';
import { relayList } from './signal/nostr.mjs';
import { nostrEnabled } from './signal/client.mjs';

const execFileAsync = promisify(execFile);

const ok = (m, d) => ({ level: 'ok', m, d });
const warn = (m, d) => ({ level: 'warn', m, d });
const bad = (m, d) => ({ level: 'bad', m, d });

async function checkMediaEngine() {
  const bin = findMediaBinary();
  if (!bin) return [bad('media engine', MEDIA_MISSING)];
  const out = [ok('media engine', bin)];
  try {
    const { stdout } = await execFileAsync(bin, ['probe'], { timeout: 15000 });
    const probe = JSON.parse(stdout);
    const relevant = process.platform === 'win32' ? /nvenc|qsv|amf|_mf/ : /vaapi|nvenc|qsv/;
    const hw = probe.encoders.filter((e) => relevant.test(e));
    out.push(hw.length
      ? ok('GPU encoders', `${hw.join(', ')} (the first one this GPU supports is used)`)
      : warn('GPU encoders', 'none built in; software x264 will be used (higher CPU)'));
    out.push(probe.encoders.some((e) => /x264|openh264/.test(e))
      ? ok('software encoder', 'available as fallback')
      : warn('software encoder', 'no software fallback'));
    out.push(probe.capture.length > 1
      ? ok('capture backends', probe.capture.join(', '))
      : warn('capture backends', `only ${probe.capture.join(', ')} - real screen capture unavailable`));
    out.push(probe.render.includes('sdl')
      ? ok('viewer window', 'SDL2')
      : bad('viewer window', 'SDL2 missing - cannot display a stream'));
    const input = probe.input || {};
    out.push(input.kbm?.length
      ? ok('keyboard/mouse', `can be controlled remotely via ${input.kbm.join(', ')}`)
      : warn('keyboard/mouse', 'this machine cannot be controlled remotely (viewing it still works)'));
    if (input.gamepad) {
      out.push(input.gamepadReady
        ? ok('controllers', `virtual Xbox 360 pads via ${input.gamepad}`)
        : warn('controllers', `unavailable as host: ${input.gamepadError || 'unknown reason'}`));
    }
  } catch (err) {
    out.push(bad('media engine probe', err.message));
  }
  return out;
}

function checkSession() {
  const out = [];
  if (process.platform === 'win32') {
    out.push(ok('display session', 'Windows desktop (DXGI capture, GDI fallback)'));
    return out;
  }
  const wayland = process.env.WAYLAND_DISPLAY;
  const x11 = process.env.DISPLAY;
  const type = process.env.XDG_SESSION_TYPE;

  if (wayland) {
    out.push(ok('display session', `Wayland (${wayland})`));
    out.push(warn('capture consent',
      'Wayland requires approving a screen-share dialog each time the host starts'));
  } else if (x11) {
    out.push(ok('display session', `X11 (${x11})`));
  } else {
    out.push(warn('display session',
      `none detected (XDG_SESSION_TYPE=${type || 'unset'}) - host mode can only use the synthetic source here`));
  }
  return out;
}

/** Pairing needs at least one public relay to answer (a few is plenty). */
async function checkNostr() {
  if (!nostrEnabled()) return warn('pairing relays', 'Nostr disabled (PENGUIN_NOSTR=0); a --rendezvous server is required');
  const { WebSocket } = await import('ws');
  const relays = relayList().slice(0, 6);
  const results = await Promise.all(relays.map((url) => new Promise((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: 5000 });
    const done = (okay) => { try { ws.terminate(); } catch { /* ignore */ } resolve(okay); };
    ws.once('open', () => done(true));
    ws.once('error', () => done(false));
    setTimeout(() => done(false), 6000).unref?.();
  })));
  const up = results.filter(Boolean).length;
  if (up >= 2) return ok('pairing relays', `${up}/${relays.length} public Nostr relays reachable`);
  if (up === 1) return warn('pairing relays', `only 1/${relays.length} Nostr relays reachable - pairing may be slow`);
  return bad('pairing relays', 'no Nostr relay reachable: check the Internet connection or firewall (outbound wss:// on port 443)');
}

async function checkRendezvous(url) {
  const http = url.replace(/^ws/, 'http');
  try {
    const res = await fetch(`${http}/health`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return warn('rendezvous', `${url} responded ${res.status}`);
    const body = await res.json();
    return ok('rendezvous', `${url} reachable (${body.rooms} active rooms)`);
  } catch (err) {
    return warn('rendezvous',
      `${url} not reachable (${err.message}). Start one with: penguin-stream rendezvous`);
  }
}

export async function runDoctor() {
  const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  };
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const col = (k) => (useColor ? C[k] : '');

  const results = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  results.push(nodeMajor >= 20
    ? ok('node', process.versions.node)
    : bad('node', `${process.versions.node} - need >= 20`));

  results.push(ok('penguin stream', APP_VERSION));
  results.push(ok('platform', `${os.platform()} ${os.arch()} ${os.release()}`));

  try {
    const id = loadOrCreateIdentity();
    results.push(ok('device identity', `${id.fingerprint} (${configDir()})`));
  } catch (err) {
    results.push(bad('device identity', err.message));
  }

  try {
    await import('node-datachannel');
    results.push(ok('transport', 'node-datachannel (ICE/DTLS/SCTP) loaded'));
  } catch (err) {
    results.push(bad('transport', `node-datachannel failed to load: ${err.message}`));
  }

  results.push(...checkSession());
  results.push(...(await checkMediaEngine()));
  results.push(await checkNostr());
  if (DEFAULT_RENDEZVOUS) results.push(await checkRendezvous(DEFAULT_RENDEZVOUS));

  console.log(`${col('bold')}penguin-stream doctor${col('reset')}\n`);
  for (const r of results) {
    const mark = r.level === 'ok' ? `${col('green')}ok  ${col('reset')}`
      : r.level === 'warn' ? `${col('yellow')}warn${col('reset')}`
        : `${col('red')}FAIL${col('reset')}`;
    console.log(`  ${mark}  ${r.m.padEnd(20)} ${col('dim')}${r.d}${col('reset')}`);
  }

  const failures = results.filter((r) => r.level === 'bad').length;
  const warnings = results.filter((r) => r.level === 'warn').length;
  console.log();
  if (failures) {
    console.log(`  ${col('red')}${failures} blocking problem(s)${col('reset')}, ${warnings} warning(s)`);
  } else {
    console.log(`  ${col('green')}no blocking problems${col('reset')}, ${warnings} warning(s)`);
  }
  return failures ? 1 : 0;
}
