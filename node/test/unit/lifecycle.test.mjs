// Regressions for 1.4.1: child processes that misbehave must never crash the
// app or linger. Real child processes (tiny fake engines), no mocks of Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-life-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A fake `ps-media` (shell script) with the given body. */
function fakeEngine(name, body) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a stream window that ignores SIGTERM is killed, not left running', async () => {
  // Hung GPU driver: the window neither reads stdin nor obeys SIGTERM.
  process.env.PS_MEDIA_BIN = fakeEngine('stuck-view', "trap '' TERM; while :; do sleep 0.05; done");
  const { ViewEngine } = await import('../../src/media/engine.mjs');
  const v = new ViewEngine({ stopTimeouts: { termMs: 100, killMs: 400 } }).start();
  const pid = v.proc.pid;
  const exited = new Promise((r) => v.once('exit', r));
  await sleep(150);                       // the script has installed its trap
  v.stop();
  const how = await Promise.race([exited, sleep(3000).then(() => null)]);
  assert.ok(how, `stream window (pid ${pid}) still running after stop()`);
  assert.equal(how.signal, 'SIGKILL');
  assert.ok(!alive(pid));
});

test('a stream window that sends garbage is stopped after one error, not once per chunk', async () => {
  // 10 KB of junk, in several pipe writes: 1.4.0 emitted an error per chunk,
  // forever, and kept the broken window open.
  process.env.PS_MEDIA_BIN = fakeEngine('garbage-view',
    'i=0; while [ $i -lt 20 ]; do head -c 512 /dev/zero | tr "\\000" "\\377"; sleep 0.01; i=$((i+1)); done; sleep 5');
  const { ViewEngine } = await import('../../src/media/engine.mjs');
  const v = new ViewEngine({ stopTimeouts: { termMs: 50, killMs: 300 } });
  const errors = [];
  v.on('error', (e) => errors.push(e));
  v.start();
  const exited = new Promise((r) => v.once('exit', r));
  const how = await Promise.race([exited, sleep(4000).then(() => null)]);
  assert.ok(how, 'the out-of-sync stream window was left running');
  assert.equal(errors.length, 1, `expected one error, got ${errors.length}`);
});

test('a missing helper program (no xdg-open) does not crash the app', async () => {
  const { spawnDetached } = await import('../../src/ui/server.mjs');
  let uncaught = null;
  const onUncaught = (e) => { uncaught = e; };
  process.on('uncaughtException', onUncaught);
  try {
    // A real spawn of a program that does not exist: Node reports ENOENT as
    // an async 'error' event. Before 1.4.1 nobody listened -> app crash.
    assert.equal(spawnDetached('penguin-no-such-program-xyz', ['/tmp']), true);
    await sleep(200);
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  assert.equal(uncaught, null, `helper spawn crashed the process: ${uncaught?.message}`);
});

test('the helper listens for errors before the child can emit one', async () => {
  const { spawnDetached } = await import('../../src/ui/server.mjs');
  const events = [];
  const fakeSpawn = () => ({
    on: (ev) => events.push(`on:${ev}`),
    unref: () => events.push('unref'),
  });
  spawnDetached('x', [], {}, fakeSpawn);
  assert.deepEqual(events, ['on:error', 'unref']);
  // ...and a synchronous spawn failure is reported, not thrown.
  assert.equal(spawnDetached('x', [], {}, () => { throw new Error('EACCES'); }), false);
});

test('old diagnostics reports are pruned; logs and other files are kept', async () => {
  const { pruneDiagnostics } = await import('../../src/ui/server.mjs');
  const dir = fs.mkdtempSync(path.join(tmp, 'logs-'));
  for (let i = 0; i < 9; i++) fs.writeFileSync(path.join(dir, `diagnostics-2026-09-2${i}T10-00-00.txt`), 'x');
  fs.writeFileSync(path.join(dir, 'penguin-stream.log'), 'keep');
  pruneDiagnostics(dir, 5);
  const left = fs.readdirSync(dir).sort();
  assert.equal(left.filter((f) => f.startsWith('diagnostics-')).length, 5);
  assert.ok(left.includes('diagnostics-2026-09-28T10-00-00.txt'), 'newest kept');
  assert.ok(!left.includes('diagnostics-2026-09-20T10-00-00.txt'), 'oldest removed');
  assert.ok(left.includes('penguin-stream.log'), 'the log itself is never touched');
});
