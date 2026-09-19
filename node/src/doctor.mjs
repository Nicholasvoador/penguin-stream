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
import process from 'node:process';

import { findMediaBinary } from './media/engine.mjs';
import { loadOrCreateIdentity, configDir } from './crypto/identity.mjs';
import { DEFAULT_RENDEZVOUS } from './app/session.mjs';

const execFileAsync = promisify(execFile);

const ok = (m, d) => ({ level: 'ok', m, d });
const warn = (m, d) => ({ level: 'warn', m, d });
const bad = (m, d) => ({ level: 'bad', m, d });

async function checkMediaEngine() {
  const bin = findMediaBinary();
  if (!bin) {
    return [bad('media engine', 'not built - run: cmake -B media/build -S media -G Ninja && cmake --build media/build')];
  }
  const out = [ok('media engine', bin)];
  try {
    const { stdout } = await execFileAsync(bin, ['probe'], { timeout: 15000 });
    const probe = JSON.parse(stdout);
    const hw = probe.encoders.filter((e) => /vaapi|nvenc|qsv|amf/.test(e));
    out.push(hw.length
      ? ok('hardware encoder', hw.join(', '))
      : warn('hardware encoder', 'none found; software x264 will be used (higher CPU)'));
    out.push(probe.encoders.some((e) => /x264|openh264/.test(e))
      ? ok('software encoder', 'available as fallback')
      : warn('software encoder', 'no software fallback'));
    out.push(probe.capture.length > 1
      ? ok('capture backends', probe.capture.join(', '))
      : warn('capture backends', `only ${probe.capture.join(', ')} - real screen capture unavailable`));
    out.push(probe.render.includes('sdl')
      ? ok('viewer window', 'SDL2')
      : bad('viewer window', 'SDL2 missing - cannot display a stream'));
  } catch (err) {
    out.push(bad('media engine probe', err.message));
  }
  return out;
}

function checkSession() {
  const out = [];
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
  results.push(await checkRendezvous(DEFAULT_RENDEZVOUS));

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
