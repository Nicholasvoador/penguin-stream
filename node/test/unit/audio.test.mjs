import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AudioCapture, AudioPlayer, decodeAudio, audioFilterArgs } from '../../src/media/audio.mjs';

function packet(sequence, bytes = 16) {
  const payload = Buffer.alloc(8 + bytes, 0x5a);
  payload.write('PA01');
  payload.writeUInt32LE(sequence, 4);
  return payload;
}

function harness({ congested = false, ignoreTerm = false } = {}) {
  const calls = [];
  function spawn(binary, args, options) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new EventEmitter();
    child.stdin.writable = true;
    child.stdin.writableLength = 0;
    child.stdin.destroyed = false;
    child.writes = [];
    child.stdin.write = data => { child.writes.push(data); return !congested; };
    child.stdin.destroy = () => { child.stdin.destroyed = true; };
    child.signals = [];
    child.kill = signal => {
      child.signals.push(signal);
      if (!ignoreTerm || signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    calls.push({ binary, args, options, child });
    return child;
  }
  return { calls, spawn };
}

const opts = { enabled: true, platform: 'linux', binary: '/opt/ps/ps-media' };

function capture(h, extra = {}) {
  const result = new AudioCapture({ ...opts, spawn: h.spawn, ...extra });
  result.errors = [];
  result.on('error', error => result.errors.push(error));
  return result;
}
function player(h, extra = {}) {
  const result = new AudioPlayer({ ...opts, spawn: h.spawn, ...extra });
  result.errors = [];
  result.on('error', error => result.errors.push(error));
  return result;
}

test('construction/import is inert; explicit opt-in and Linux/Windows are required', () => {
  const h = harness();
  for (const enabled of [undefined, false, 'true', 1]) {
    const a = capture(h, { enabled });
    const b = player(h, { enabled });
    assert.throws(() => a.start(), /explicit/);
    assert.throws(() => b.write(packet(0)), /explicit/);
  }
  for (const platform of ['darwin', 'freebsd']) {
    assert.throws(() => capture(h, { platform }).start(), /unsupported/);
    assert.throws(() => player(h, { platform }).write(packet(0)), /unsupported/);
  }
  assert.equal(h.calls.length, 0);
});

test('app filters are validated before anything is spawned', () => {
  const h = harness();
  for (const bad of ['a;b', '$(x)', 'x'.repeat(65), '../x', 'x\ny']) {
    assert.throws(() => capture(h, { filter: { exclude: [bad] } }).start(), /invalid app name/);
    assert.throws(() => capture(h, { filter: { only: bad } }).start(), /invalid app name/);
  }
  assert.throws(() => capture(h, { filter: { exclude: Array.from({ length: 33 }, (_, i) => `a${i}`) } }).start(), /at most/);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(audioFilterArgs({}), []);
  assert.deepEqual(audioFilterArgs({ excludeVoice: true, exclude: 'Spotify, obs64' }), ['--exclude-voice', '--exclude', 'Spotify,obs64']);
  assert.deepEqual(audioFilterArgs({ excludeVoice: true, only: 'eldenring' }), ['--only', 'eldenring'], 'only overrides');
});

test('capture runs the engine shell-free with the app filter', async () => {
  const h = harness();
  const a = capture(h, { filter: { excludeVoice: true } }).start();
  const { binary, args, options } = h.calls[0];
  assert.equal(binary, '/opt/ps/ps-media');
  assert.equal(options.shell, false);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(args, ['audio-capture', '--exclude-voice']);
  assert.throws(() => a.start(), /already started/);
  await a.stop();
});

test('fragmented/large stdout reconstructs aligned bounded packets byte exactly', async () => {
  const h = harness();
  const a = capture(h, { maxPayload: 29 }).start(); // rounds down to 20 PCM bytes
  const out = [];
  a.on('data', data => out.push(data));
  const pcm = Buffer.from(Array.from({ length: 20003 }, (_, i) => i % 256));
  const { child } = h.calls[0];
  child.stdout.emit('data', pcm.subarray(0, 1));
  child.stdout.emit('data', pcm.subarray(1, 17));
  child.stdout.emit('data', pcm.subarray(17));
  assert.equal(out.length, 1000);
  assert.equal(a.used, 3);
  assert.equal(a.pending.length, 20);
  out.forEach((p, i) => {
    assert.equal(p.length, 28);
    assert.equal(decodeAudio(p, 29).sequence, i);
  });
  assert.deepEqual(Buffer.concat(out.map(p => decodeAudio(p, 29).pcm)), pcm.subarray(0, 20000));
  await a.stop();
  assert.equal(a.used, 0);
  child.stdout.emit('data', Buffer.alloc(100));
  assert.equal(out.length, 1000);
});

test('capture sends 10ms packets within the transport limit, including sequence wrap', async () => {
  const h = harness();
  const a = capture(h, { maxPayload: 60000 }).start();
  a.sequence = 0xffffffff;
  const out = [];
  a.on('data', p => out.push(p));
  h.calls[0].child.stdout.emit('data', Buffer.alloc(7680));
  assert.deepEqual(out.map(p => p.length), [1928, 1928, 1928, 1928]);
  assert.deepEqual(out.map(p => decodeAudio(p).sequence), [0xffffffff, 0, 1, 2]);
  await a.stop();
});

test('invalid payload bounds and shutdown timeouts are rejected', () => {
  for (const maxPayload of [0, 11, 60001, NaN, 12.5, Infinity]) {
    assert.throws(() => new AudioCapture({ maxPayload }), /maxPayload/);
    assert.throws(() => new AudioPlayer({ maxPayload }), /maxPayload/);
  }
  for (const killAfterMs of [0, 5001, NaN]) {
    assert.throws(() => new AudioPlayer({ killAfterMs }), /killAfterMs/);
  }
});

test('malformed, oversized, wrong-version and unaligned packets cannot start playback', () => {
  const h = harness();
  const p = player(h);
  for (const bad of [null, 'PA01', Buffer.alloc(7), packet(0, 0), packet(0, 5),
    packet(0, 3844), Buffer.alloc(24)]) {
    assert.equal(p.write(bad), false);
  }
  assert.equal(h.calls.length, 0);
});

test('player writes only PCM, starts lazily and rejects duplicates/stale frames across wrap', async () => {
  const h = harness();
  const p = player(h);
  assert.equal(h.calls.length, 0);
  assert.equal(p.write(packet(0xfffffffe)), true);
  assert.equal(p.write(packet(0)), true); // gap across wrap
  assert.equal(p.write(packet(0)), false);
  assert.equal(p.write(packet(0xffffffff)), false);
  assert.equal(p.write(packet(5)), true); // loss does not stall
  const { child, binary, args, options } = h.calls[0];
  assert.equal(h.calls.length, 1);
  assert.equal(binary, '/opt/ps/ps-media');
  assert.equal(options.shell, false);
  assert.deepEqual(args, ['audio-play']);
  assert.deepEqual(child.writes, Array.from({ length: 3 }, () => packet(0).subarray(8)));
  await p.stop();
});

test('playback backpressure drops without queueing; drain resumes latest audio', async () => {
  const h = harness({ congested: true });
  const p = player(h);
  assert.equal(p.write(packet(0)), true); // write(false) still accepted this packet
  for (let i = 1; i < 1000; i++) assert.equal(p.write(packet(i)), false);
  const { child } = h.calls[0];
  assert.equal(child.writes.length, 1);
  child.stdin.emit('drain');
  assert.equal(p.write(packet(1000)), true);
  child.stdin.emit('drain');
  child.stdin.writableLength = 15360;
  assert.equal(p.write(packet(1001)), false);
  assert.equal(child.writes.length, 2);
  await p.stop();
});

test('player does not retain mutable network packet storage', async () => {
  const h = harness();
  const p = player(h);
  const input = packet(0);
  p.write(input);
  input.fill(0);
  assert.deepEqual(h.calls[0].child.writes[0], Buffer.alloc(16, 0x5a));
  await p.stop();
});

test('stderr logging is capped and errors stop children without duplicate errors', async () => {
  const h = harness();
  const a = capture(h).start();
  let bytes = 0;
  a.on('log', text => { bytes += Buffer.byteLength(text); });
  const { child } = h.calls[0];
  const lines = Buffer.from(`${'A'.repeat(99)}\n`.repeat(1000));
  child.stderr.emit('data', lines);
  child.stderr.emit('data', lines);
  assert.ok(bytes > 7900 && bytes <= 8192, `log output must be capped at 8 KiB, got ${bytes}`);
  child.emit('error', new Error('spawn ENOENT'));
  child.stdout.emit('error', new Error('secondary error'));
  await a.stop();
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0].message, /audio engine.*ENOENT/);
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('player EPIPE and unexpected exit are surfaced, stopped and not restarted', async () => {
  for (const fault of ['pipe', 'close', 'spawn']) {
    const h = harness();
    const p = player(h);
    p.write(packet(0));
    const { child } = h.calls[0];
    if (fault === 'pipe') child.stdin.emit('error', new Error('EPIPE'));
    else if (fault === 'spawn') child.emit('error', new Error('ENOENT'));
    else child.emit('close', 1, null);
    await p.stop();
    assert.equal(p.errors.length, 1);
    assert.match(p.errors[0].message, /audio (engine|player)/);
    assert.throws(() => p.write(packet(1)), /stopped/);
  }
});

test('synchronous spawn failures leave instances stopped', () => {
  const spawn = () => { throw new Error('spawn failed'); };
  const a = new AudioCapture({ ...opts, spawn });
  const p = new AudioPlayer({ ...opts, spawn });
  assert.throws(() => a.start(), /spawn failed/);
  assert.throws(() => p.write(packet(0)), /spawn failed/);
  assert.throws(() => a.start(), /stopped/);
  assert.throws(() => p.write(packet(1)), /stopped/);
});

test('stop is idempotent before start and during playback', async () => {
  const h = harness();
  const a = capture(h);
  await a.stop();
  assert.throws(() => a.start(), /stopped/);
  const p = player(h);
  p.write(packet(0));
  const first = p.stop();
  assert.equal(p.stop(), first);
  await first;
  assert.deepEqual(h.calls[0].child.signals, ['SIGTERM']);
  assert.equal(p.proc, null);
});

test('uncooperative children are killed after deadline and awaited', async () => {
  const h = harness({ ignoreTerm: true });
  const p = player(h, { killAfterMs: 5 });
  p.write(packet(0));
  const stopped = p.stop();
  // Production children keep the loop alive; our fake EventEmitter does not.
  p.killTimer.ref();
  await stopped;
  assert.deepEqual(h.calls[0].child.signals, ['SIGTERM', 'SIGKILL']);
});

test('stop inside a capture data handler prevents the rest of a large chunk being sent', async () => {
  const h = harness();
  const a = capture(h).start();
  let count = 0;
  a.on('data', () => { count++; void a.stop(); });
  h.calls[0].child.stdout.emit('data', Buffer.alloc(100000));
  await a.stop();
  assert.equal(count, 1);
});

test('engine warnings are surfaced as warning events, line by line', async () => {
  const h = harness();
  const a = capture(h).start();
  const warnings = [];
  const logs = [];
  a.on('warning', w => warnings.push(w));
  a.on('log', l => logs.push(l));
  const { child } = h.calls[0];
  child.stderr.emit('data', Buffer.from('audio: leaving out "Discord" (pid 42)\r\naudio: warn'));
  child.stderr.emit('data', Buffer.from('ing: could not leave out "Discord"; streaming all apps\n'));
  assert.deepEqual(warnings, ['could not leave out "Discord"; streaming all apps']);
  assert.equal(logs.length, 2);
  await a.stop();
});
