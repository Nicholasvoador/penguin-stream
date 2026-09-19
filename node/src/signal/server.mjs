/**
 * Rendezvous server.
 *
 * Deliberately dumb: it matches two WebSocket clients that present the same
 * room id and forwards opaque base64 blobs between them. It cannot decrypt
 * signaling (the key comes from the share code, which it never receives), it
 * cannot read media (that is peer-to-peer and Noise-encrypted), and it holds
 * no persistent state.
 *
 * It does see: both peers' public IPs, and the timing/size of their signaling.
 * That is unavoidable for any rendezvous design and is documented in
 * SECURITY.md as a known metadata exposure.
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';

const MAX_MESSAGE_BYTES = 64 * 1024;
const ROOM_TTL_MS = 5 * 60 * 1000;
const MAX_ROOMS = 5000;
const JOIN_FAIL_LIMIT = 20;         // per IP, per window
const RATE_WINDOW_MS = 60 * 1000;

export class RendezvousServer {
  constructor({ logger = console } = {}) {
    this.rooms = new Map();          // roomId -> { host, client, createdAt }
    this.failures = new Map();       // ip -> { count, resetAt }
    this.log = logger;
    this.stats = { roomsCreated: 0, pairsMatched: 0, signalsRelayed: 0, rejected: 0 };
    this._sweep = setInterval(() => this.sweep(), 30_000);
    this._sweep.unref?.();
  }

  sweep() {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      if (now - room.createdAt > ROOM_TTL_MS && !room.client) {
        this.closeRoom(id, 'expired');
      }
    }
    for (const [ip, rec] of this.failures) {
      if (now > rec.resetAt) this.failures.delete(ip);
    }
  }

  closeRoom(id, reason) {
    const room = this.rooms.get(id);
    if (!room) return;
    this.rooms.delete(id);
    for (const sock of [room.host, room.client]) {
      if (sock && sock.readyState === sock.OPEN) {
        try {
          sock.send(JSON.stringify({ t: 'closed', reason }));
          sock.close();
        } catch { /* peer already gone */ }
      }
    }
  }

  rateLimited(ip) {
    const now = Date.now();
    let rec = this.failures.get(ip);
    if (!rec || now > rec.resetAt) {
      rec = { count: 0, resetAt: now + RATE_WINDOW_MS };
      this.failures.set(ip, rec);
    }
    return rec.count >= JOIN_FAIL_LIMIT;
  }

  noteFailure(ip) {
    const rec = this.failures.get(ip);
    if (rec) rec.count++;
    this.stats.rejected++;
  }

  /** Validates a room id: 32 lowercase hex chars, exactly as roomIdFor emits. */
  static validRoom(id) {
    return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);
  }

  handleConnection(ws, ip) {
    let roomId = null;
    let role = null;

    const fail = (msg, close = true) => {
      this.noteFailure(ip);
      try {
        ws.send(JSON.stringify({ t: 'error', message: msg }));
        if (close) ws.close();
      } catch { /* socket already closing */ }
    };

    ws.on('message', (raw, isBinary) => {
      if (isBinary || raw.length > MAX_MESSAGE_BYTES) return fail('message too large');

      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return fail('malformed json');
      }
      if (!msg || typeof msg.t !== 'string') return fail('malformed message');

      switch (msg.t) {
        case 'host': {
          if (roomId) return fail('already in a room');
          if (!RendezvousServer.validRoom(msg.room)) return fail('invalid room');
          if (this.rooms.size >= MAX_ROOMS) return fail('server at capacity');
          if (this.rooms.has(msg.room)) return fail('room already hosted');
          roomId = msg.room;
          role = 'host';
          this.rooms.set(roomId, { host: ws, client: null, createdAt: Date.now() });
          this.stats.roomsCreated++;
          ws.send(JSON.stringify({ t: 'ready', role }));
          break;
        }

        case 'join': {
          if (roomId) return fail('already in a room');
          if (this.rateLimited(ip)) return fail('too many attempts, slow down');
          if (!RendezvousServer.validRoom(msg.room)) return fail('invalid room');
          const room = this.rooms.get(msg.room);
          // Same message whether the room is absent or taken: do not leak
          // which share codes are live.
          if (!room || room.client) return fail('no such session');
          roomId = msg.room;
          role = 'client';
          room.client = ws;
          this.stats.pairsMatched++;
          ws.send(JSON.stringify({ t: 'ready', role }));
          room.host.send(JSON.stringify({ t: 'peer-joined' }));
          break;
        }

        case 'sig': {
          if (!roomId) return fail('not in a room');
          if (typeof msg.payload !== 'string') return fail('invalid payload');
          const room = this.rooms.get(roomId);
          if (!room) return fail('room gone');
          const target = role === 'host' ? room.client : room.host;
          if (!target || target.readyState !== target.OPEN) return; // peer not here yet
          this.stats.signalsRelayed++;
          target.send(JSON.stringify({ t: 'sig', payload: msg.payload }));
          break;
        }

        case 'bye': {
          if (roomId) this.closeRoom(roomId, 'peer left');
          break;
        }

        default:
          return fail(`unknown message type`);
      }
    });

    ws.on('close', () => {
      if (roomId) this.closeRoom(roomId, 'peer disconnected');
    });
    ws.on('error', () => {
      if (roomId) this.closeRoom(roomId, 'peer error');
    });
  }

  stop() {
    clearInterval(this._sweep);
    for (const id of [...this.rooms.keys()]) this.closeRoom(id, 'server shutting down');
  }
}

/**
 * @returns {Promise<{port: number, url: string, close: () => Promise<void>, server: RendezvousServer}>}
 */
export async function startRendezvous({ port = 8787, host = '0.0.0.0', logger = console } = {}) {
  const rv = new RendezvousServer({ logger });

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rv.rooms.size, stats: rv.stats }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });
  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'unknown';
    rv.handleConnection(ws, ip);
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, resolve);
  });

  const actualPort = httpServer.address().port;
  return {
    port: actualPort,
    url: `ws://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`,
    server: rv,
    close: () => new Promise((resolve) => {
      rv.stop();
      wss.close(() => httpServer.close(() => resolve()));
    }),
  };
}
