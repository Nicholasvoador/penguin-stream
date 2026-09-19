/**
 * Share codes.
 *
 * The whole onboarding story is "host reads out eight characters, client types
 * them". That code does three jobs:
 *
 *   1. It names the rendezvous room — but the server only ever sees
 *      SHA-256(code), never the code itself.
 *   2. It keys the encryption of the signaling payloads, so the rendezvous
 *      server cannot read SDP or ICE candidates and therefore cannot learn
 *      either peer's local network topology.
 *   3. It gates who may even attempt a Noise handshake with the host.
 *
 * It is explicitly *not* the thing that authenticates the peer. Codes are
 * short, typed by humans, and sometimes read aloud in a room with other
 * people. Authentication is Noise + SAS + an explicit consent prompt.
 */

import crypto from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_CHARS = 8;           // 8 * 5 = 40 bits of entropy
export const CODE_BITS = CODE_CHARS * 5;

/** Crockford decode table, including the ambiguous-letter aliases. */
const DECODE = (() => {
  const m = new Map();
  [...CROCKFORD].forEach((c, i) => m.set(c, i));
  m.set('I', 1); m.set('L', 1); m.set('O', 0); m.set('U', undefined);
  return m;
})();

/**
 * @returns {string} e.g. "K7QA-3ZM2"
 */
export function generateShareCode() {
  let out = '';
  // Rejection-free: take 5 bits at a time from CSPRNG bytes.
  const bytes = crypto.randomBytes(CODE_CHARS);
  for (let i = 0; i < CODE_CHARS; i++) out += CROCKFORD[bytes[i] & 31];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * Accepts sloppy human input: lowercase, missing dash, O/0 and I/L/1 mixups,
 * stray spaces.
 * @returns {string} canonical "XXXX-XXXX"
 * @throws if the code cannot be interpreted
 */
export function normalizeShareCode(input) {
  if (typeof input !== 'string') throw new Error('share code must be a string');
  const raw = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (raw.length !== CODE_CHARS) {
    throw new Error(`share code must be ${CODE_CHARS} characters, got ${raw.length}`);
  }
  let canon = '';
  for (const ch of raw) {
    const v = DECODE.get(ch);
    if (v === undefined) throw new Error(`invalid character '${ch}' in share code`);
    canon += CROCKFORD[v];
  }
  return `${canon.slice(0, 4)}-${canon.slice(4)}`;
}

function codeBytes(code) {
  return Buffer.from(normalizeShareCode(code).replace('-', ''), 'utf8');
}

/**
 * Room identifier handed to the rendezvous server. One-way: the server cannot
 * recover the code, so it cannot derive the signaling key.
 */
export function roomIdFor(code) {
  return crypto.createHash('sha256')
    .update('penguin-stream room v1')
    .update(codeBytes(code))
    .digest('hex')
    .slice(0, 32);
}

/**
 * Symmetric key protecting signaling payloads in transit through the server.
 * Derived from the code, so only someone holding the code can read them.
 */
export function signalingKey(code) {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    codeBytes(code),
    Buffer.from('penguin-stream signaling salt v1'),
    Buffer.from('signaling'),
    32,
  ));
}

/**
 * Binds the Noise transcript to the code and to both roles, so a handshake
 * captured in one room cannot be replayed into another.
 */
export function noisePrologue(code) {
  return crypto.createHash('sha256')
    .update('penguin-stream prologue v1')
    .update(codeBytes(code))
    .digest();
}

/** Encrypts a JSON-serialisable signaling message. Returns base64. */
export function sealSignal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 });
  const pt = Buffer.from(JSON.stringify(obj), 'utf8');
  const ct = Buffer.concat([c.update(pt), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

/** Decrypts a base64 signaling message. Throws if forged or key-mismatched. */
export function openSignal(key, b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 12 + 16) throw new Error('signal payload too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const d = crypto.createDecipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 });
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}
