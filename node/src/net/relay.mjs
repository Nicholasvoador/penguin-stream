/**
 * Turns the saved relay setting into ICE servers.
 *
 * Only ONE side of a session needs a relay: ICE pairs the other side's
 * ordinary candidates with this side's relayed address, and TURN permissions
 * are per IP, so even a symmetric NAT on the far side gets through. That is
 * why the relay lives in the host's settings and viewers configure nothing.
 *
 * Modes:
 *   cloudflare - Cloudflare Realtime TURN (anycast, free tier). The long-term
 *                key stays on this machine; we mint 24h credentials from it.
 *   url        - any HTTPS endpoint returning ICE servers as JSON
 *                (e.g. Metered's credentials API, or your own).
 *   manual     - a fixed TURN server + username/password (e.g. coturn on a VPS).
 */

const FETCH_TIMEOUT_MS = 8000;
const CF_TTL_S = 86400;
let cfCache = null;   // { keyId, expires, servers }

async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new Error(`relay provider answered HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
  try { return JSON.parse(text); } catch { throw new Error('relay provider did not return JSON'); }
}

/** Keeps only well-formed {urls, username?, credential?} entries. */
export function cleanIceList(list) {
  const arr = Array.isArray(list) ? list : Array.isArray(list?.iceServers) ? list.iceServers : [];
  const out = [];
  for (const s of arr.slice(0, 16)) {
    if (!s || typeof s !== 'object') continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls ?? s.url]).filter((u) => typeof u === 'string');
    if (!urls.length) continue;
    out.push({
      urls,
      ...(typeof s.username === 'string' ? { username: s.username } : {}),
      ...(typeof s.credential === 'string' ? { credential: s.credential } : {}),
    });
  }
  return out;
}

async function cloudflare(keyId, token) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(keyId || '')) throw new Error('Cloudflare TURN key ID looks wrong');
  if (!token) throw new Error('Cloudflare TURN API token is missing');
  const now = Date.now();
  if (cfCache && cfCache.keyId === keyId && cfCache.expires > now + 3600_000) return cfCache.servers;
  const body = await fetchJson(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: CF_TTL_S }),
    },
  );
  const servers = cleanIceList(body);
  if (!servers.some((s) => s.urls.some((u) => /^turns?:/i.test(u)))) {
    throw new Error('Cloudflare returned no TURN servers');
  }
  cfCache = { keyId, expires: now + CF_TTL_S * 1000, servers };
  return servers;
}

/**
 * @param {object} relay the `relay` section of the settings
 * @returns {Promise<Array<{urls:string[],username?:string,credential?:string}>>}
 */
export async function resolveRelay(relay = {}) {
  switch (relay.mode) {
    case 'cloudflare':
      return cloudflare(relay.cfKeyId, relay.cfToken);
    case 'url': {
      if (!/^https:\/\//i.test(relay.url || '')) throw new Error('relay credentials URL must start with https://');
      const servers = cleanIceList(await fetchJson(relay.url));
      if (!servers.length) throw new Error('relay credentials URL returned no ICE servers');
      return servers;
    }
    case 'manual': {
      if (!relay.turn) throw new Error('TURN server address is missing');
      const urls = relay.turn.split(',').map((u) => u.trim()).filter(Boolean)
        .map((u) => (/^turns?:/i.test(u) ? u : `turn:${u}`));
      return [{ urls, username: relay.turnUser || undefined, credential: relay.turnPassword || undefined }];
    }
    default:
      return [];
  }
}

/** One-line, secret-free description for logs and the UI. */
export function describeRelay(relay = {}) {
  switch (relay.mode) {
    case 'cloudflare': return 'Cloudflare TURN';
    case 'url': {
      try { return `relay from ${new URL(relay.url).host}`; } catch { return 'relay from URL'; }
    }
    case 'manual': return `TURN ${String(relay.turn || '').replace(/^turns?:/i, '').split(',')[0]}`;
    default: return 'no relay';
  }
}
