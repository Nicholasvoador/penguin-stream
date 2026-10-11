/**
 * Remote access codes ("PA-…"): recognised however they are typed, never
 * confused with invitations, and every derived value is domain-separated -
 * while invitations keep the exact 1.x wire values (old peers keep working).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  codeInfo, isAccessCode, normalizeAccessCode, generateAccessCode, generateShareCode, normalizeShareCode,
  roomIdFor, signalingKey, noisePrologue, sealSignal, openSignal,
} from '../../src/signal/code.mjs';
import { nostrTopicFor } from '../../src/signal/nostr.mjs';
import { HandshakeState, generateKeypair } from '../../src/crypto/noise.mjs';
import { redact } from '../../src/app/logbook.mjs';
import { SettingsStore, sanitizeSettings } from '../../src/app/settings.mjs';

const BODY = 'K7QA-3ZM2-ABCD-EFGH-JKMN-PQRS-TVWX-YZ01';
const ACCESS = `PA-${BODY}`;
const CODE_RE = /^PA(-[0-9A-HJKMNP-TV-Z]{4}){8}$/;

test('invitations keep the exact 1.x wire values (room, key, prologue, Nostr topic)', () => {
  // Golden values computed with Penguin Stream 1.4.1. If these change, every
  // invitation between 1.5 and 1.4 peers silently stops working.
  assert.equal(roomIdFor(BODY), '6cfde08f91bd7c984b3b39c7c0f155f6');
  assert.equal(signalingKey(BODY).toString('hex'), '61bef0a6397d0019646fce3302eee591d8b341e6c3498cfd6f29ce9e6b22f928');
  assert.equal(noisePrologue(BODY).toString('hex'), '626f743f53540712859a9342805dde643596d83fe6f2e99ffbcdb230e83084bd');
  assert.deepEqual(nostrTopicFor(codeInfo(BODY).bytes), { topic: 'b46153136fae4dc5943ff40424fa4611041cd55f', kind: 27139 });
  assert.deepEqual(nostrTopicFor(codeInfo(BODY).bytes, 'invite'), nostrTopicFor(codeInfo(BODY).bytes));
});

test('an access code with the same body derives different values everywhere', () => {
  const info = codeInfo(ACCESS);
  assert.equal(info.scope, 'access');
  assert.deepEqual(info.bytes, codeInfo(BODY).bytes, 'same 160-bit body');
  assert.notEqual(roomIdFor(ACCESS), roomIdFor(BODY));
  assert.notDeepEqual(signalingKey(ACCESS), signalingKey(BODY));
  assert.notDeepEqual(noisePrologue(ACCESS), noisePrologue(BODY));
  assert.notEqual(nostrTopicFor(info.bytes, 'access').topic, nostrTopicFor(info.bytes).topic);
  // A signal sealed for one cannot be opened with the other.
  assert.throws(() => openSignal(signalingKey(BODY), sealSignal(signalingKey(ACCESS), { v: 2 })));
});

test('a viewer holding only the invitation cannot complete the handshake with an access listener', () => {
  const i = new HandshakeState({ initiator: true, staticKeypair: generateKeypair(), prologue: noisePrologue(BODY) });
  const r = new HandshakeState({ initiator: false, staticKeypair: generateKeypair(), prologue: noisePrologue(ACCESS) });
  r.readMessage(i.writeMessage());
  // The responder's identity is encrypted under the transcript, prologue included.
  assert.throws(() => i.readMessage(r.writeMessage()));
});

test('access codes are recognised however they are typed', () => {
  for (const typed of [ACCESS, ACCESS.toLowerCase(), ` pa ${BODY.replaceAll('-', ' ')} `, `PA${BODY.replaceAll('-', '')}`,
    `PA-${BODY.replaceAll('0', 'O').replaceAll('1', 'l')}`, `${ACCESS}@ws://192.168.1.5:8787`]) {
    assert.equal(normalizeAccessCode(typed), ACCESS, typed);
    assert.ok(isAccessCode(typed), typed);
  }
});

test('an invitation that happens to start with PA is still an invitation', () => {
  const inv = `PA${BODY.slice(2)}`;   // 32 characters
  assert.equal(codeInfo(inv).scope, 'invite');
  assert.equal(isAccessCode(inv), false);
  assert.throws(() => normalizeAccessCode(inv), /not a remote access code/);
  assert.throws(() => normalizeShareCode(ACCESS), /32 characters/, 'an access code is never accepted as an invitation');
  assert.equal(isAccessCode('nonsense'), false);
  assert.equal(isAccessCode(undefined), false);
});

test('new access codes are 160-bit, canonical and unique', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = generateAccessCode();
    assert.match(c, CODE_RE);
    assert.equal(normalizeAccessCode(c), c);
    seen.add(c);
  }
  assert.equal(seen.size, 200);
  assert.equal(codeInfo(generateShareCode()).scope, 'invite');
});

test('the log never keeps an access code, whatever the case', () => {
  const c = generateAccessCode();
  const line = redact(`connect ${c} and ${c.toLowerCase()} via ${c}@ws://10.0.0.2:8787`);
  assert.ok(!line.includes(c.slice(3)) && !line.toLowerCase().includes(c.slice(3).toLowerCase()), line);
  assert.equal((line.match(/\[invitation\]/g) || []).length, 3);
});

test('settings keep the access code private and only accept a valid one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-access-'));
  try {
    const store = new SettingsStore(dir);
    assert.equal(store.get().remoteAccess, false, 'remote access is off by default');
    const code = store.accessCode();
    assert.match(code, CODE_RE);
    assert.equal(store.accessCode(), code, 'stable until changed');
    assert.equal(new SettingsStore(dir).get().accessCode, code, 'survives a restart');
    const next = store.newAccessCode();
    assert.notEqual(next, code);
    assert.match(next, CODE_RE);
    const pub = JSON.stringify(store.publicSettings());
    assert.ok(!pub.includes(next.slice(3)), 'never in publicSettings (UI dumps, diagnostics)');
    assert.equal(fs.statSync(path.join(dir, 'settings.json')).mode & 0o077, 0, 'owner-only file');
    assert.deepEqual(sanitizeSettings({ accessCode: BODY }), {}, 'an invitation is not an access code');
    assert.deepEqual(sanitizeSettings({ accessCode: 'PA-123' }), {});
    assert.deepEqual(sanitizeSettings({ accessCode: ACCESS.toLowerCase() }), { accessCode: ACCESS });
    assert.deepEqual(sanitizeSettings({ remoteAccess: 'yes' }), {}, 'booleans only');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
