/**
 * Minimal STUN/TURN codec (RFC 5389 + RFC 5766).
 *
 * Only the subset our ICE agent actually speaks. Written from the RFCs rather
 * than pulled in as a dependency so the relay test has no external moving
 * parts and can run offline.
 */

import crypto from 'node:crypto';

export const MAGIC_COOKIE = 0x2112a442;
const COOKIE_BUF = Buffer.from([0x21, 0x12, 0xa4, 0x42]);

export const Method = Object.freeze({
  BINDING: 0x001,
  ALLOCATE: 0x003,
  REFRESH: 0x004,
  SEND: 0x006,
  DATA: 0x007,
  CREATE_PERMISSION: 0x008,
  CHANNEL_BIND: 0x009,
});

export const Class = Object.freeze({
  REQUEST: 0x0,
  INDICATION: 0x1,
  SUCCESS: 0x2,
  ERROR: 0x3,
});

export const Attr = Object.freeze({
  MAPPED_ADDRESS: 0x0001,
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  UNKNOWN_ATTRIBUTES: 0x000a,
  CHANNEL_NUMBER: 0x000c,
  LIFETIME: 0x000d,
  XOR_PEER_ADDRESS: 0x0012,
  DATA: 0x0013,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
  DONT_FRAGMENT: 0x001a,
  XOR_MAPPED_ADDRESS: 0x0020,
  SOFTWARE: 0x8022,
  FINGERPRINT: 0x8028,
});

export function encodeType(method, cls) {
  return ((method & 0x0f80) << 2)
    | ((method & 0x0070) << 1)
    | (method & 0x000f)
    | ((cls & 0x2) << 7)
    | ((cls & 0x1) << 4);
}

export function decodeType(type) {
  const method = ((type & 0x3e00) >> 2) | ((type & 0x00e0) >> 1) | (type & 0x000f);
  const cls = ((type & 0x0100) >> 7) | ((type & 0x0010) >> 4);
  return { method, cls };
}

/** ChannelData frames start with 0b01; STUN messages start with 0b00. */
export function isChannelData(buf) {
  return buf.length >= 4 && (buf[0] & 0xc0) === 0x40;
}

export function isStun(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 20
    && (buf[0] & 0xc0) === 0x00
    && buf.readUInt32BE(4) === MAGIC_COOKIE;
}

// Peer addresses remain repeatable for CreatePermission, unlike security and
// scalar control attributes whose first/last-wins interpretation is ambiguous.
const SINGLETON_ATTRS = new Set([
  Attr.USERNAME, Attr.REALM, Attr.NONCE, Attr.MESSAGE_INTEGRITY,
  Attr.FINGERPRINT, Attr.LIFETIME, Attr.REQUESTED_TRANSPORT, Attr.CHANNEL_NUMBER,
]);
const FIXED_LENGTHS = new Map([
  [Attr.MESSAGE_INTEGRITY, 20], [Attr.FINGERPRINT, 4], [Attr.LIFETIME, 4],
  [Attr.REQUESTED_TRANSPORT, 4], [Attr.CHANNEL_NUMBER, 4],
]);

export function parse(buf) {
  if (!isStun(buf)) return null;
  const type = buf.readUInt16BE(0);
  const length = buf.readUInt16BE(2);
  if (length % 4 !== 0 || 20 + length !== buf.length) return null;

  const { method, cls } = decodeType(type);
  const transactionId = Buffer.from(buf.subarray(8, 20));
  const attrs = new Map();
  const raw = [];

  let off = 20;
  const end = 20 + length;
  while (off < end) {
    if (off + 4 > end) return null;
    const atype = buf.readUInt16BE(off);
    const alen = buf.readUInt16BE(off + 2);
    const vstart = off + 4;
    const next = vstart + alen + ((4 - (alen % 4)) % 4);
    if (next > end) return null;
    if (SINGLETON_ATTRS.has(atype) && attrs.has(atype)) return null;
    if (FIXED_LENGTHS.has(atype) && alen !== FIXED_LENGTHS.get(atype)) return null;
    // Nothing after MI except a final, valid fingerprint may reach handlers.
    if (attrs.has(Attr.MESSAGE_INTEGRITY) && atype !== Attr.FINGERPRINT) return null;
    if (atype === Attr.FINGERPRINT) {
      if (next !== end) return null;
      const expected = (crc32(buf.subarray(0, off)) ^ 0x5354554e) >>> 0;
      if (buf.readUInt32BE(vstart) !== expected) return null;
    }
    const value = Buffer.from(buf.subarray(vstart, vstart + alen));
    // For repeatable/non-security attributes, the map keeps the first value.
    if (!attrs.has(atype)) attrs.set(atype, value);
    raw.push({ type: atype, offset: off, length: alen, value });
    off = next;
  }

  return { type, method, cls, length, transactionId, attrs, raw, buffer: buf };
}

/* ------------------------------ addresses ----------------------------- */

export function encodeXorAddress(family, ip, port, transactionId) {
  const isV6 = family === 6;
  const buf = Buffer.alloc(isV6 ? 20 : 8);
  buf.writeUInt8(0, 0);
  buf.writeUInt8(isV6 ? 0x02 : 0x01, 1);
  buf.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 2);

  const addr = ipToBuffer(ip, isV6);
  const mask = isV6 ? Buffer.concat([COOKIE_BUF, transactionId]) : COOKIE_BUF;
  for (let i = 0; i < addr.length; i++) buf[4 + i] = addr[i] ^ mask[i];
  return buf;
}

export function decodeXorAddress(value, transactionId) {
  if (value.length < 8) return null;
  const family = value.readUInt8(1);
  if (family !== 0x01 && family !== 0x02) return null;
  const port = value.readUInt16BE(2) ^ (MAGIC_COOKIE >>> 16);
  const isV6 = family === 0x02;
  const len = isV6 ? 16 : 4;
  if (value.length !== 4 + len) return null;

  const mask = isV6 ? Buffer.concat([COOKIE_BUF, transactionId]) : COOKIE_BUF;
  const addr = Buffer.alloc(len);
  for (let i = 0; i < len; i++) addr[i] = value[4 + i] ^ mask[i];
  return { family: isV6 ? 6 : 4, address: bufferToIp(addr, isV6), port };
}

export function ipToBuffer(ip, isV6) {
  if (!isV6) return Buffer.from(ip.split('.').map((n) => parseInt(n, 10)));
  // Expand :: and parse hextets.
  const stripped = ip.replace(/%.*$/, '');
  const [head, tail] = stripped.split('::');
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail !== undefined ? tail.split(':').filter(Boolean) : [];
  const fill = 8 - h.length - t.length;
  const parts = [...h, ...Array(Math.max(0, fill)).fill('0'), ...t];
  const buf = Buffer.alloc(16);
  parts.slice(0, 8).forEach((p, i) => buf.writeUInt16BE(parseInt(p || '0', 16), i * 2));
  return buf;
}

export function bufferToIp(buf, isV6) {
  if (!isV6) return [...buf].join('.');
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(i).toString(16));
  return parts.join(':');
}

/* ------------------------------ building ------------------------------ */

export class MessageBuilder {
  constructor(method, cls, transactionId = crypto.randomBytes(12)) {
    this.method = method;
    this.cls = cls;
    this.transactionId = transactionId;
    this.attrs = [];
  }

  add(type, value) {
    this.attrs.push({ type, value: Buffer.isBuffer(value) ? value : Buffer.from(value) });
    return this;
  }

  addUInt32(type, n) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0, 0);
    return this.add(type, b);
  }

  addString(type, s) {
    return this.add(type, Buffer.from(s, 'utf8'));
  }

  addXorAddress(type, family, ip, port) {
    return this.add(type, encodeXorAddress(family, ip, port, this.transactionId));
  }

  addErrorCode(code, reason) {
    const b = Buffer.alloc(4 + Buffer.byteLength(reason, 'utf8'));
    b.writeUInt8(Math.floor(code / 100), 2);
    b.writeUInt8(code % 100, 3);
    b.write(reason, 4, 'utf8');
    return this.add(Attr.ERROR_CODE, b);
  }

  #serialize(extraBytes = 0) {
    let bodyLen = 0;
    for (const a of this.attrs) bodyLen += 4 + a.value.length + ((4 - (a.value.length % 4)) % 4);

    const buf = Buffer.alloc(20 + bodyLen);
    buf.writeUInt16BE(encodeType(this.method, this.cls), 0);
    buf.writeUInt16BE(bodyLen + extraBytes, 2);
    buf.writeUInt32BE(MAGIC_COOKIE, 4);
    this.transactionId.copy(buf, 8);

    let off = 20;
    for (const a of this.attrs) {
      buf.writeUInt16BE(a.type, off);
      buf.writeUInt16BE(a.value.length, off + 2);
      a.value.copy(buf, off + 4);
      off += 4 + a.value.length + ((4 - (a.value.length % 4)) % 4);
    }
    return buf;
  }

  /**
   * @param {Buffer|null} integrityKey long-term key = MD5(user:realm:pass)
   * @param {boolean} fingerprint append FINGERPRINT
   */
  build({ integrityKey = null, fingerprint = false } = {}) {
    let buf = this.#serialize(integrityKey ? 24 : 0);

    if (integrityKey) {
      // HMAC covers the message with Length already counting the MI attribute.
      const hmac = crypto.createHmac('sha1', integrityKey).update(buf).digest();
      buf = Buffer.concat([buf, Buffer.alloc(24)]);
      const off = buf.length - 24;
      buf.writeUInt16BE(Attr.MESSAGE_INTEGRITY, off);
      buf.writeUInt16BE(20, off + 2);
      hmac.copy(buf, off + 4);
    }

    if (fingerprint) {
      const withFp = Buffer.concat([buf, Buffer.alloc(8)]);
      withFp.writeUInt16BE(withFp.length - 20, 2);
      const crc = crc32(withFp.subarray(0, withFp.length - 8)) ^ 0x5354554e;
      const off = withFp.length - 8;
      withFp.writeUInt16BE(Attr.FINGERPRINT, off);
      withFp.writeUInt16BE(4, off + 2);
      withFp.writeUInt32BE(crc >>> 0, off + 4);
      buf = withFp;
    }

    return buf;
  }
}

/* ------------------------------ integrity ----------------------------- */

/** Long-term credential key: MD5(username ":" realm ":" password) (RFC 5389 §15.4). */
export function longTermKey(username, realm, password) {
  return crypto.createHash('md5').update(`${username}:${realm}:${password}`, 'utf8').digest();
}

/**
 * Verifies MESSAGE-INTEGRITY on a received message.
 * The HMAC input is everything before the MI attribute, with the length field
 * rewritten to include it.
 */
export function verifyMessageIntegrity(msg, key) {
  // Revalidate wire bytes rather than trusting caller-provided raw/attrs.
  msg = parse(msg?.buffer);
  if (!msg) return false;
  const mi = msg.raw.find((a) => a.type === Attr.MESSAGE_INTEGRITY);
  if (!mi || mi.length !== 20) return false;

  const upto = Buffer.from(msg.buffer.subarray(0, mi.offset));
  const claimedLen = (mi.offset + 24) - 20;
  upto.writeUInt16BE(claimedLen, 2);

  const expected = crypto.createHmac('sha1', key).update(upto).digest();
  return expected.length === mi.value.length && crypto.timingSafeEqual(expected, mi.value);
}

/* -------------------------------- crc32 ------------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
