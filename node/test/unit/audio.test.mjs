import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AudioCapture, AudioPlayer, decodeAudio, selectDefaultMonitor } from '../../src/media/audio.mjs';

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

function probe(binary, args, options) {
  assert.equal(binary, 'pactl');
  assert.equal(options.shell, false);
  assert.equal(options.timeout, 2000);
  assert.equal(options.maxBuffer, 1024 * 1024);
  if (args[0] === 'get-default-sink') return 'output.test\n';
  assert.deepEqual(args, ['-f', 'json', 'list', 'sources']);
  return JSON.stringify([
    { name: 'input.mic', monitor_source: '' },
    { name: 'output.test.monitor', monitor_source: 'output.test' },
  ]);
}
const opts = { enabled: true, platform: 'linux', probe };

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

test('construction/import is inert; explicit opt-in and Linux are required', () => {
  const h = harness();
  for (const enabled of [undefined, false, 'true', 1]) {
    const a = capture(h, { enabled });
    const b = player(h, { enabled });
    assert.throws(() => a.start(), /explicit/);
    assert.throws(() => b.write(packet(0)), /explicit/);
  }
  for (const platform of ['win32', 'darwin']) {
    assert.throws(() => capture(h, { platform }).start(), /unsupported/);
    assert.throws(() => player(h, { platform }).write(packet(0)), /unsupported/);
  }
  assert.equal(h.calls.length, 0);
});

test('source whitelist rejects microphone, raw device names, and shell syntax before probes', () => {
  const h = harness();
  for (const source of ['default', 'input.mic', 'output.test.monitor', ';touch /tmp/no', null]) {
    const a = capture(h, { source, probe: () => assert.fail('must not probe') });
    assert.throws(() => a.start(), /not allowed/);
  }
  assert.equal(h.calls.length, 0);
});

test('monitor verification fails closed and supports pactl monitor metadata', () => {
  for (const sink of ['', '-bad', 'x;echo', 'x\ny', null]) {
    assert.throws(() => selectDefaultMonitor(sink, []), /default sink/);
  }
  for (const source of [{ name: 'out.monitor' }, { name: 'input.mic', monitor_of_sink: 1 },
    { name: 'out.monitor', monitor_of_sink: 0xffffffff }, { name: 'out.monitor', monitor_of_sink: -1 }]) {
    assert.throws(() => selectDefaultMonitor('out', [source]), /no microphone fallback/);
  }
  for (const metadata of [{ monitor_source: 'out' }, { monitor_of_sink: 0 },
    { properties: { 'device.class': 'monitor' } }]) {
    assert.equal(selectDefaultMonitor('out', [{ name: 'out.monitor', ...metadata }]), 'out.monitor');
  }
});

test('pactl missing, invalid JSON, and no monitor fail before capture spawn', () => {
  const h = harness();
  for (const probe of [() => { throw new Error('ENOENT'); }, () => 'not json',
    (_, args) => args[0] === 'get-default-sink' ? 'out' : '[]']) {
    assert.throws(() => capture(h, { probe }).start(), /preflight failed/);
  }
  assert.equal(h.calls.length, 0);
});

test('capture uses shell-free ffmpeg monitor input and fixed PCM output', async () => {
  const h = harness();
  const a = capture(h).start();
  const { binary, args, options } = h.calls[0];
  assert.equal(binary, 'ffmpeg');
  assert.equal(options.shell, false);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(args[args.indexOf('-i') + 1], 'output.test.monitor');
  assert.ok(args.includes('-nostdin'));
  assert.ok(args.includes('pulse'));
  assert.ok(args.includes('pcm_s16le'));
  assert.equal(args[args.indexOf('-ar') + 1], '48000');
  assert.equal(args[args.indexOf('-ac') + 1], '2');
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

test('capture stays <= transport limit and 20ms, including sequence wrap', async () => {
  const h = harness();
  const a = capture(h, { maxPayload: 60000 }).start();
  a.sequence = 0xffffffff;
  const out = [];
  a.on('data', p => out.push(p));
  h.calls[0].child.stdout.emit('data', Buffer.alloc(7680));
  assert.deepEqual(out.map(p => p.length), [3848, 3848]);
  assert.deepEqual(out.map(p => decodeAudio(p).sequence), [0xffffffff, 0]);
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
  assert.equal(binary, 'ffplay');
  assert.equal(options.shell, false);
  assert.ok(args.includes('-noinfbuf'));
  assert.ok(args.includes('s16le'));
  assert.ok(args.includes('48000'));
  assert.ok(args.includes('stereo'));
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
  child.stderr.emit('data', Buffer.alloc(100000, 65));
  child.stderr.emit('data', Buffer.alloc(100000, 65));
  assert.equal(bytes, 8192);
  child.emit('error', new Error('spawn ENOENT'));
  child.stdout.emit('error', new Error('secondary error'));
  await a.stop();
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0].message, /ffmpeg.*ENOENT/);
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('ffplay EPIPE and unexpected exit are surfaced, stopped and not restarted', async () => {
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
    assert.match(p.errors[0].message, /ffplay/);
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
