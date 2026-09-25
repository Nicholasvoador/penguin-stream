/**
 * Regression for 1.1.0/1.1.1 "Error: Unknown cipher" crash.
 *
 * The desktop app runs our Node code inside Electron, whose Node is built on
 * BoringSSL. BoringSSL does not provide 'chacha20-poly1305' via
 * crypto.createCipheriv, so plain-Node tests passed while every installed app
 * crashed as soon as signaling started. These tests pin the cipher choice and,
 * when an Electron binary is available, run the real crypto under it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = path.join(ROOT, 'node', 'src');

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (p.endsWith('.mjs')) yield p;
  }
}

test('no source file uses a cipher missing from Electron (BoringSSL)', () => {
  const banned = /['"](chacha20(-poly1305)?|aes-\d+-ocb|aes-\d+-ccm|aes-\d+-siv|chacha20)['"]/i;
  const hits = [];
  for (const f of walk(SRC)) {
    const text = fs.readFileSync(f, 'utf8');
    if (banned.test(text)) hits.push(path.relative(ROOT, f));
  }
  assert.deepEqual(hits, []);
});

function electronBinary() {
  try {
    // The npm 'electron' package's main export is the path to its binary.
    const p = spawnSync(process.execPath, ['-e', "process.stdout.write(require('electron'))"], {
      cwd: ROOT, encoding: 'utf8',
    });
    const bin = p.stdout.trim();
    return bin && fs.existsSync(bin) ? bin : null;
  } catch { return null; }
}

test('signaling seal/open and a full Noise handshake work inside Electron', { timeout: 60_000 }, (t) => {
  const bin = electronBinary();
  if (!bin) { t.skip('electron binary not installed'); return; }
  const script = `
    const code = await import(${JSON.stringify(path.join(SRC, 'signal/code.mjs'))});
    const noise = await import(${JSON.stringify(path.join(SRC, 'crypto/noise.mjs'))});
    const inv = code.generateShareCode();
    const key = code.signalingKey(inv);
    const msg = { hello: 'world', n: 42 };
    const back = code.openSignal(key, code.sealSignal(key, msg));
    if (JSON.stringify(back) !== JSON.stringify(msg)) throw new Error('signal roundtrip mismatch');
    const n = noise.noiseNonce(1);
    const ct = noise.aeadEncrypt(Buffer.alloc(32, 7), n, Buffer.from('ad'), Buffer.from('media'));
    const pt = noise.aeadDecrypt(Buffer.alloc(32, 7), n, Buffer.from('ad'), ct);
    if (pt.toString() !== 'media') throw new Error('aead roundtrip mismatch');
    const pro = code.noisePrologue(inv);
    const ini = new noise.HandshakeState({ initiator: true, staticKeypair: noise.generateKeypair(), prologue: pro });
    const res = new noise.HandshakeState({ initiator: false, staticKeypair: noise.generateKeypair(), prologue: pro });
    res.readMessage(ini.writeMessage());
    ini.readMessage(res.writeMessage());
    res.readMessage(ini.writeMessage());
    if (!ini.handshakeHash.equals(res.handshakeHash)) throw new Error('handshake hash mismatch');
    console.log('ELECTRON_CRYPTO_OK', process.versions.electron);
  `;
  const r = spawnSync(bin, ['--input-type=module', '-e', script], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.equal(r.status, 0, `electron run failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /ELECTRON_CRYPTO_OK/);
});
