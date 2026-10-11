/** High-entropy, copy/paste invitations. The rendezvous sees a hash of the
 * invitation; its confidentiality depends on the full random invitation staying
 * private. This is not a password protocol. Legacy 40-bit codes are rejected.
 * Peer verification still requires SAS comparison and explicit host consent.
 *
 * Two kinds of code share the same 160-bit body:
 *   - invitation  "XXXX-XXXX-…" (8 groups): someone may ASK to connect; the
 *     host compares words and clicks Allow.
 *   - access code "PA-XXXX-XXXX-…": unattended remote access to your own PC.
 *     Holding it IS the permission (no prompt on the PC), so it only works
 *     while the owner has switched remote access on.
 * Every value derived from a code (room id, signaling key, Noise prologue,
 * Nostr topic) is domain-separated by kind, so an invitation can never reach
 * the remote-access listener or the other way round, even with the same body.
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

/** Remote access codes start with this (then the usual eight groups). */
export const ACCESS_PREFIX = 'PA';

/** A new remote access code: "PA-" + 160 random bits. */
export function generateAccessCode() {
  return `${ACCESS_PREFIX}-${generateShareCode()}`;
}

/** Drops the transport decorations an invitation may carry (penguin://, @url, #url). */
function stripDecorations(input) {
  let text = input.trim();
  if (text.startsWith('penguin://')) text = text.slice(text.lastIndexOf('/') + 1);
  else if (text.includes('@')) text = text.slice(0, text.indexOf('@'));
  else if (text.includes('#')) text = text.slice(0, text.indexOf('#'));
  return text;
}

/**
 * Classifies and canonicalises any code.
 * @returns {{ scope: 'invite'|'access', canonical: string, bytes: Buffer }}
 *   canonical: "XXXX-…" for invitations, "PA-XXXX-…" for access codes;
 *   bytes: the 32-character body, the input to every derivation
 * @throws if it is neither
 */
export function codeInfo(input) {
  if (typeof input !== 'string') throw new Error('share code must be a string');
  const raw = stripDecorations(input).toUpperCase().replace(/[^0-9A-Z]/g, '');
  // Unambiguous by length: an invitation that happens to start with "PA" is
  // still 32 characters; an access code is the prefix plus 32.
  if (raw.length === ACCESS_PREFIX.length + CODE_CHARS && raw.startsWith(ACCESS_PREFIX)) {
    const body = normalizeShareCode(raw.slice(ACCESS_PREFIX.length));
    return { scope: 'access', canonical: `${ACCESS_PREFIX}-${body}`, bytes: Buffer.from(body.replaceAll('-', ''), 'utf8') };
  }
  const body = normalizeShareCode(input);
  return { scope: 'invite', canonical: body, bytes: Buffer.from(body.replaceAll('-', ''), 'utf8') };
}

/** True for a remote access code ("PA-…"), false for anything else. */
export function isAccessCode(input) {
  try { return codeInfo(input).scope === 'access'; } catch { return false; }
}

/** Canonical "PA-XXXX-…" form. @throws unless it is an access code. */
export function normalizeAccessCode(input) {
  const info = codeInfo(input);
  if (info.scope !== 'access') throw new Error('not a remote access code (they start with PA-)');
  return info.canonical;
}

// Invitation labels are the 1.x wire format: changing them breaks every
// existing invitation. Access labels are separate so the two never meet.
const LABELS = {
  invite: { room: 'penguin-stream room v2', salt: 'penguin-stream signaling salt v2', prologue: 'penguin-stream prologue v2' },
  access: { room: 'penguin-stream access room v1', salt: 'penguin-stream access signaling salt v1', prologue: 'penguin-stream access prologue v1' },
};

/**
 * Room identifier handed to the rendezvous server. A malicious server can attempt guesses; 160-bit random invitations make
 * exhaustive guessing infeasible. Do not replace invitations with passwords.
 */
export function roomIdFor(code) {
  const { scope, bytes } = codeInfo(code);
  return crypto.createHash('sha256')
    .update(LABELS[scope].room)
    .update(bytes)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Symmetric key protecting signaling payloads in transit through the server.
 * Derived from the code, so only someone holding the code can read them.
 */
export function signalingKey(code) {
  const { scope, bytes } = codeInfo(code);
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    bytes,
    Buffer.from(LABELS[scope].salt),
    Buffer.from('signaling'),
    32,
  ));
}

/**
 * Binds the Noise transcript to the code and to both roles, so a handshake
 * captured in one room cannot be replayed into another. For access codes this
 * is also what makes "has the code" checkable: a peer without it cannot
 * complete the handshake, so the host never gets as far as asking.
 */
export function noisePrologue(code) {
  const { scope, bytes } = codeInfo(code);
  return crypto.createHash('sha256')
    .update(LABELS[scope].prologue)
    .update(bytes)
    .digest();
}

/** AES-256-GCM: available in both OpenSSL (Node) and BoringSSL (Electron). */
const SIGNAL_AEAD = 'aes-256-gcm';

/** Encrypts a JSON-serialisable signaling message. Returns base64. */
export function sealSignal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(SIGNAL_AEAD, key, iv, { authTagLength: 16 });
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
  const d = crypto.createDecipheriv(SIGNAL_AEAD, key, iv, { authTagLength: 16 });
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
 *   - Remote access code "PA-K7QA-3ZM2-..." (scope 'access'), same suffixes
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
  const { scope, canonical } = codeInfo(raw);
  return { code: canonical, rendezvousUrl, scope };
}
