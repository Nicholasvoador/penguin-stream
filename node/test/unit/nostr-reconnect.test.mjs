/**
 * The Nostr signaling channel must stay usable for days: a host listens for
 * as long as a share or remote access is on. Relays restart, Wi-Fi drops and
 * sockets die silently - the channel has to notice and keep coming back.
 * (1.4.x gave up on a relay after 4 failed attempts, ~15 s.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { NostrChannel } from '../../src/signal/nostr.mjs';

const TOPIC = 'a'.repeat(40);

/** Scriptable stand-in for the `ws` client. */
function fakeSockets(behaviour) {
  const created = [];
  class FakeWs extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.sent = [];
      this.pings = 0;
      this.terminated = false;
      created.push(this);
      setImmediate(() => behaviour(this, created.filter((w) => w.url === url).length));
    }
    send(data) { this.sent.push(data); }
    ping() { this.pings++; if (this.pongs) setImmediate(() => this.emit('pong')); }
    close() { if (!this.closedOnce) { this.closedOnce = true; setImmediate(() => this.emit('close')); } }
    terminate() { this.terminated = true; this.close(); }
  }
  return { FakeWs, created };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a relay that keeps failing is retried for as long as the channel lives', async () => {
  const { FakeWs, created } = fakeSockets((ws) => { ws.emit('error', new Error('ECONNREFUSED')); ws.close(); });
  const ch = new NostrChannel({ topic: TOPIC, kind: 20001, relays: ['wss://down.example'], WebSocketImpl: FakeWs,
    reconnectBaseMs: 5, reconnectMaxMs: 20 });
  ch.on('relay-error', () => {});
  ch.start();
  await wait(400);
  const attempts = created.length;
  ch.close();
  assert.ok(attempts > 8, `kept retrying past the old limit of 4 (attempts: ${attempts})`);
  await wait(80);
  assert.equal(created.length, attempts, 'no reconnect after close()');
});

test('a relay that comes back after an outage is subscribed again', async () => {
  // Down for the first 6 attempts (an outage), then healthy.
  const { FakeWs } = fakeSockets((ws, n) => {
    if (n <= 6) { ws.close(); return; }
    ws.emit('open');
  });
  const ch = new NostrChannel({ topic: TOPIC, kind: 20001, relays: ['wss://flaky.example'], WebSocketImpl: FakeWs,
    reconnectBaseMs: 5, reconnectMaxMs: 20 });
  const counts = [];
  ch.on('relays', (n) => counts.push(n));
  const opened = new Promise((r) => ch.once('open', r));
  ch.start();
  await Promise.race([opened, wait(2000)]);
  assert.equal(ch.connectedRelays, 1);
  assert.deepEqual(counts, [1]);
  ch.close();
});

test('a socket that dies silently (no pong) is replaced, and the relay count follows', async () => {
  // First socket opens but never answers pings; later ones are healthy.
  const { FakeWs, created } = fakeSockets((ws, n) => {
    ws.pongs = n > 1;
    ws.emit('open');
  });
  const ch = new NostrChannel({ topic: TOPIC, kind: 20001, relays: ['wss://quiet.example'], WebSocketImpl: FakeWs,
    reconnectBaseMs: 5, reconnectMaxMs: 20, pingIntervalMs: 30 });
  const counts = [];
  ch.on('relays', (n) => counts.push(n));
  ch.start();
  await wait(400);
  assert.ok(created[0].terminated, 'the silent socket was terminated');
  assert.ok(created.length >= 2, 'and replaced');
  assert.ok(created[1].pings > 1 && !created[1].terminated, 'a socket that answers pings is kept');
  assert.equal(ch.connectedRelays, 1);
  assert.deepEqual(counts.slice(0, 3), [1, 0, 1], 'subscribed -> lost -> subscribed again');
  // Every (re)subscription asks the relay for this topic again.
  assert.ok(created.every((w) => w.sent.some((m) => m.startsWith('["REQ"'))));
  ch.close();
});

test('close() stops pings and pending reconnects', async () => {
  const { FakeWs, created } = fakeSockets((ws) => { ws.pongs = true; ws.emit('open'); });
  const ch = new NostrChannel({ topic: TOPIC, kind: 20001, relays: ['wss://a.example', 'wss://b.example'],
    WebSocketImpl: FakeWs, reconnectBaseMs: 5, pingIntervalMs: 10 });
  ch.start();
  await wait(60);
  ch.close();
  const pings = created.map((w) => w.pings);
  await wait(80);
  assert.deepEqual(created.map((w) => w.pings), pings, 'no pings after close');
  assert.equal(created.length, 2, 'no reconnects after close');
});
