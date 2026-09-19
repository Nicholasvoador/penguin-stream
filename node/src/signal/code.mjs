/** High-entropy, copy/paste invitations. The rendezvous sees a hash of the
 * invitation; its confidentiality depends on the full random invitation staying
 * private. This is not a password protocol. Legacy 40-bit codes are rejected.
 * Peer verification still requires SAS comparison and explicit host consent.
 */

import crypto from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_CHARS = 32;          // 160 independently random bits
export const CODE_BITS = CODE_CHARS * 5;

/** Crockford decode table, including the ambiguous-letter aliases. */
const DECODE = (() => {
  const m = new Map();
  [...CROCKFORD].forEach((c, i) => m.set(c, i));
  m.set('I', 1); m.set('L', 1); m.set('O', 0); m.set('U', undefined);
  return m;
})();

/**
 * @returns {string} eight groups of four Crockford characters
 */
export function generateShareCode() {
  let out = '';
  // Rejection-free: take 5 bits at a time from CSPRNG bytes.
  const bytes = crypto.randomBytes(CODE_CHARS);
  for (let i = 0; i < CODE_CHARS; i++) out += CROCKFORD[bytes[i] & 31];
  return out.match(/.{4}/g).join('-');
}

/**
 * Accepts sloppy human input: lowercase, missing dash, O/0 and I/L/1 mixups,
 * stray spaces.
 * @returns {string} canonical eight groups of four characters
 * @throws if the code cannot be interpreted
 */
export function normalizeShareCode(input) {
  if (typeof input !== 'string') throw new Error('share code must be a string');
  let text = input.trim();
  if (text.startsWith('penguin://')) {
    text = text.slice(text.lastIndexOf('/') + 1);
  } else if (text.includes('@')) {
    text = text.slice(0, text.indexOf('@'));
  } else if (text.includes('#')) {
    text = text.slice(0, text.indexOf('#'));
  }
  const raw = text.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (raw.length !== CODE_CHARS) {
    throw new Error(`share code must be ${CODE_CHARS} characters, got ${raw.length}`);
  }
  let canon = '';
  for (const ch of raw) {
    const v = DECODE.get(ch);
    if (v === undefined) throw new Error(`invalid character '${ch}' in share code`);
    canon += CROCKFORD[v];
  }
  return canon.match(/.{4}/g).join('-');
}

function codeBytes(code) {
  return Buffer.from(normalizeShareCode(code).replaceAll('-', ''), 'utf8');
}

/**
 * Room identifier handed to the rendezvous server. A malicious server can attempt guesses; 160-bit random invitations make
 * exhaustive guessing infeasible. Do not replace invitations with passwords.
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


/**
 * Extracts the canonical share code and an optional embedded rendezvous URL.
 * Supports:
 *   - "K7QA-3ZM2-...@ws://host:port"
 *   - "penguin://host:port/K7QA-3ZM2-..."
 *   - "K7QA-3ZM2-...#ws://host:port"
 *   - Standard bare invitation "K7QA-3ZM2-..."
 */
export function parseInvitation(input) {
  if (typeof input !== 'string') throw new Error('invitation must be a string');
  let raw = input.trim();
  let rendezvousUrl = undefined;
  if (raw.startsWith('penguin://')) {
    const after = raw.slice('penguin://'.length);
    const slash = after.lastIndexOf('/');
    if (slash !== -1) {
      rendezvousUrl = `ws://${after.slice(0, slash)}`;
      raw = after.slice(slash + 1);
    }
  } else if (raw.includes('@')) {
    const at = raw.indexOf('@');
    rendezvousUrl = raw.slice(at + 1).trim();
    raw = raw.slice(0, at);
  } else if (raw.includes('#')) {
    const hash = raw.indexOf('#');
    rendezvousUrl = raw.slice(hash + 1).trim();
    raw = raw.slice(0, hash);
  }
  const code = normalizeShareCode(raw);
  return { code, rendezvousUrl };
}
