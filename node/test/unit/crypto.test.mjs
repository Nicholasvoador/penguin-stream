import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { HandshakeState, generateKeypair, publicFromRaw } from '../../src/crypto/noise.mjs';
import { deriveSAS, sasEquals, WORDLIST } from '../../src/crypto/sas.mjs';
import { SecureSession, ReplayWindow, CHANNEL, HEADER_LEN } from '../../src/crypto/session.mjs';
import { loadOrCreateIdentity, TrustStore, fingerprint } from '../../src/crypto/identity.mjs';

/** Runs a full XX handshake between two fresh peers. */
function runHandshake(prologue = Buffer.from('test')) {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const i = new HandshakeState({ initiator: true, staticKeypair: alice, prologue });
  const r = new HandshakeState({ initiator: false, staticKeypair: bob, prologue });

  r.readMessage(i.writeMessage(Buffer.from('hello')));
  i.readMessage(r.writeMessage(Buffer.from('world')));
  r.readMessage(i.writeMessage(Buffer.from('done')));

  return { alice, bob, i, r };
}

test('noise XX completes and both sides agree on the transcript', () => {
  const { i, r } = runHandshake();
  assert.ok(i.done && r.done, 'both sides should be complete');
  assert.deepEqual(i.handshakeHash, r.handshakeHash, 'transcript hashes must match');
});

test('noise XX carries handshake payloads intact', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const i = new HandshakeState({ initiator: true, staticKeypair: alice });
  const r = new HandshakeState({ initiator: false, staticKeypair: bob });

  assert.equal(r.readMessage(i.writeMessage(Buffer.from('m1'))).toString(), 'm1');
  assert.equal(i.readMessage(r.writeMessage(Buffer.from('m2'))).toString(), 'm2');
  assert.equal(r.readMessage(i.writeMessage(Buffer.from('m3'))).toString(), 'm3');
});

test('each side learns the other\'s real long-term identity key', () => {
  const { alice, bob, i, r } = runHandshake();
  assert.deepEqual(i.remoteStatic, bob.pub, 'initiator must see bob\'s static key');
  assert.deepEqual(r.remoteStatic, alice.pub, 'responder must see alice\'s static key');
});

test('transport keys are mirrored: initiator send == responder recv', () => {
  const { i, r } = runHandshake();
  const ik = i.split();
  const rk = r.split();
  assert.deepEqual(ik.sendKey, rk.recvKey);
  assert.deepEqual(ik.recvKey, rk.sendKey);
  assert.notDeepEqual(ik.sendKey, ik.recvKey, 'directions must use distinct keys');
});

test('a differing prologue breaks the handshake', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const i = new HandshakeState({ initiator: true, staticKeypair: alice, prologue: Buffer.from('A') });
  const r = new HandshakeState({ initiator: false, staticKeypair: bob, prologue: Buffer.from('B') });

  r.readMessage(i.writeMessage());
  // Message 2 is the first authenticated one, so that is where it must fail.
  assert.throws(() => i.readMessage(r.writeMessage()), /authentication|unable|bad decrypt|failed/i);
});

test('SAS is stable, well-formed, and matches across a clean handshake', () => {
  const { i, r } = runHandshake();
  const a = deriveSAS(i.handshakeHash);
  const b = deriveSAS(r.handshakeHash);
  assert.equal(a.phrase, b.phrase, 'honest peers must see the same words');
  assert.equal(a.words.length, 4);
  assert.equal(a.bits, 32);
  for (const w of a.words) assert.ok(WORDLIST.includes(w), `${w} must come from the wordlist`);
});

/**
 * The attack the SAS exists to stop: a malicious rendezvous server runs one
 * handshake toward each victim and forwards plaintext between them.
 */
test('SAS diverges under an active machine-in-the-middle', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const mallory = generateKeypair();

  // Leg 1: alice <-> mallory(as responder)
  const aI = new HandshakeState({ initiator: true, staticKeypair: alice });
  const mR = new HandshakeState({ initiator: false, staticKeypair: mallory });
  mR.readMessage(aI.writeMessage());
  aI.readMessage(mR.writeMessage());
  mR.readMessage(aI.writeMessage());

  // Leg 2: mallory(as initiator) <-> bob
  const mI = new HandshakeState({ initiator: true, staticKeypair: mallory });
  const bR = new HandshakeState({ initiator: false, staticKeypair: bob });
  bR.readMessage(mI.writeMessage());
  mI.readMessage(bR.writeMessage());
  bR.readMessage(mI.writeMessage());

  const aliceSAS = deriveSAS(aI.handshakeHash).phrase;
  const bobSAS = deriveSAS(bR.handshakeHash).phrase;

  assert.notEqual(aliceSAS, bobSAS, 'MITM must produce mismatched SAS for the humans to catch');
  // And each victim sees Mallory's key, not their intended peer's.
  assert.deepEqual(aI.remoteStatic, mallory.pub);
  assert.deepEqual(bR.remoteStatic, mallory.pub);
  assert.notDeepEqual(aI.remoteStatic, bob.pub);
});

test('sasEquals is whitespace/case tolerant but value-strict', () => {
  assert.ok(sasEquals('acid actor add adult', '  ACID actor add ADULT '));
  assert.ok(!sasEquals('acid actor add adult', 'acid actor add alien'));
  assert.ok(!sasEquals('acid actor', 'acid actor add'));
});

test('small-order public keys are rejected', () => {
  const alice = generateKeypair();
  const i = new HandshakeState({ initiator: true, staticKeypair: alice });
  i.writeMessage();
  // All-zero u-coordinate is the canonical small-order point; X25519 outputs
  // all zeros for it, which would make the shared secret attacker-known.
  const evil = Buffer.concat([Buffer.alloc(32, 0), Buffer.alloc(32 + 16)]);
  assert.throws(() => i.readMessage(evil), /small-order|authentication|failed/i);
});

/* ---------------------------- record layer ---------------------------- */

function sessionPair() {
  const { i, r } = runHandshake();
  return [new SecureSession(i.split()), new SecureSession(r.split())];
}

test('records round-trip with channel and payload preserved', () => {
  const [a, b] = sessionPair();
  const rec = a.seal(CHANNEL.VIDEO, Buffer.from('frame-data'));
  const out = b.open(rec);
  assert.equal(out.channel, CHANNEL.VIDEO);
  assert.equal(out.plaintext.toString(), 'frame-data');
});

test('records decrypt out of order (required for unreliable media)', () => {
  const [a, b] = sessionPair();
  const recs = [1, 2, 3, 4, 5].map((n) => a.seal(CHANNEL.VIDEO, Buffer.from(`f${n}`)));
  const order = [4, 0, 3, 1, 2];
  const got = order.map((idx) => b.open(recs[idx]).plaintext.toString());
  assert.deepEqual(got, ['f5', 'f1', 'f4', 'f2', 'f3']);
});

test('replaying a record is rejected', () => {
  const [a, b] = sessionPair();
  const rec = a.seal(CHANNEL.CONTROL, Buffer.from('pay me twice'));
  b.open(rec);
  assert.throws(() => b.open(rec), /replay/i);
  assert.equal(b.stats.replayed, 1);
});

test('tampering with the header fails authentication', () => {
  const [a, b] = sessionPair();
  const rec = a.seal(CHANNEL.VIDEO, Buffer.from('x'));
  const forged = Buffer.from(rec);
  forged.writeUInt8(CHANNEL.INPUT, 0); // retarget video -> input
  assert.throws(() => b.open(forged), /authentication failed/i);
});

test('tampering with the ciphertext fails authentication', () => {
  const [a, b] = sessionPair();
  const rec = a.seal(CHANNEL.INPUT, Buffer.from('click 100 200'));
  const forged = Buffer.from(rec);
  forged[HEADER_LEN + 1] ^= 0x01;
  assert.throws(() => b.open(forged), /authentication failed/i);
});

test('a record from an unrelated session does not verify', () => {
  const [a] = sessionPair();
  const [, other] = sessionPair();
  assert.throws(() => other.open(a.seal(CHANNEL.CONTROL, Buffer.from('hi'))), /authentication failed/i);
});

test('truncated records are rejected without throwing on internals', () => {
  const [a, b] = sessionPair();
  const rec = a.seal(CHANNEL.CONTROL, Buffer.from('hello'));
  assert.throws(() => b.open(rec.subarray(0, 5)), /too short/i);
  assert.throws(() => b.open(Buffer.alloc(0)), /too short/i);
});

test('replay window accepts fresh, rejects duplicates and ancient records', () => {
  const w = new ReplayWindow(64);
  assert.ok(w.accept(0));
  assert.ok(w.accept(5));
  assert.ok(!w.accept(5), 'duplicate');
  assert.ok(w.accept(3), 'late but inside window');
  assert.ok(w.accept(1000));
  assert.ok(!w.accept(10), 'fell off the left edge');
  assert.ok(w.accept(999), 'inside window relative to 1000');
});

test('replay window memory stays bounded under a long run', () => {
  const w = new ReplayWindow(128);
  for (let i = 0; i < 20000; i++) assert.ok(w.accept(i));
  assert.ok(w.seen.size <= 256, `window grew to ${w.seen.size}`);
});

/* ---------------------------- identity -------------------------------- */

test('identity persists across loads and the key file is 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-id-'));
  const a = loadOrCreateIdentity(dir);
  const b = loadOrCreateIdentity(dir);
  assert.deepEqual(a.pub, b.pub, 'identity must be stable across restarts');
  assert.equal(a.fingerprint, b.fingerprint);

  const mode = fs.statSync(path.join(dir, 'identity.json')).mode & 0o777;
  assert.equal(mode, 0o600, `identity.json mode was ${mode.toString(8)}`);

  // The loaded identity must actually work in a handshake.
  const peer = generateKeypair();
  const i = new HandshakeState({ initiator: true, staticKeypair: b.keypair });
  const r = new HandshakeState({ initiator: false, staticKeypair: peer });
  r.readMessage(i.writeMessage());
  i.readMessage(r.writeMessage());
  r.readMessage(i.writeMessage());
  assert.deepEqual(r.remoteStatic, a.pub, 'persisted key must authenticate as the same device');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('public identity JSON carries no secret material', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-id-'));
  const id = loadOrCreateIdentity(dir);
  const json = JSON.stringify(id.toPublicJSON());
  const secret = JSON.parse(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8')).privateKey;
  assert.ok(!json.includes(secret), 'private key must never appear in public JSON');
  assert.ok(!json.includes('privateKey'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fingerprints are stable, formatted, and key-dependent', () => {
  const k1 = generateKeypair();
  const k2 = generateKeypair();
  assert.equal(fingerprint(k1.pub), fingerprint(k1.pub));
  assert.notEqual(fingerprint(k1.pub), fingerprint(k2.pub));
  assert.match(fingerprint(k1.pub), /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4})+$/);
});

test('trust store pairs, persists, and revokes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ts-'));
  const peer = generateKeypair();
  const ts = new TrustStore(dir);

  assert.ok(!ts.isTrusted(peer.pub), 'unknown peers start untrusted');
  ts.trust(peer.pub, { label: 'nic-windows', role: 'client' });
  assert.ok(ts.isTrusted(peer.pub));

  const reloaded = new TrustStore(dir);
  assert.ok(reloaded.isTrusted(peer.pub), 'trust must survive restart');
  assert.equal(reloaded.get(peer.pub).label, 'nic-windows');

  assert.ok(reloaded.revoke(peer.pub));
  assert.ok(!new TrustStore(dir).isTrusted(peer.pub), 'revocation must persist');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('trust store fails closed on a corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ts-'));
  fs.writeFileSync(path.join(dir, 'peers.json'), 'not json at all');
  const ts = new TrustStore(dir);
  assert.equal(ts.list().length, 0, 'corrupt store must trust nobody');
  fs.rmSync(dir, { recursive: true, force: true });
});
