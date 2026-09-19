/**
 * Runs inside a container on one of the two isolated networks.
 *
 * Usage:
 *   node peer-runner.mjs host   <rendezvousUrl> <turnHost> <turnPort> <user> <pass> <code>
 *   node peer-runner.mjs client <rendezvousUrl> <turnHost> <turnPort> <user> <pass> <code>
 *
 * Emits a single JSON line on stdout prefixed with RESULT: so the harness can
 * parse it without worrying about log interleaving.
 */

import os from 'node:os';
import fs from 'node:fs';
import { hostSession, joinSession } from '../../node/src/signal/client.mjs';
import { loadOrCreateIdentity } from '../../node/src/crypto/identity.mjs';
import { cleanupTransport } from '../../node/src/transport/peer.mjs';
import { CHANNEL } from '../../node/src/crypto/session.mjs';

const [role, rendezvousUrl, turnHost, turnPort, turnUser, turnPass, code] = process.argv.slice(2);
const policy = process.env.ICE_POLICY || 'all';
const FRAME_COUNT = Number(process.env.FRAME_COUNT || 40);
const FRAME_SIZE = Number(process.env.FRAME_SIZE || 8000);

const idDir = fs.mkdtempSync(`${os.tmpdir()}/ps-${role}-`);
const identity = loadOrCreateIdentity(idDir);

const iceServers = [{
  hostname: turnHost,
  port: Number(turnPort),
  username: turnUser,
  password: turnPass,
  relayType: 'TurnUdp',
}];

const emit = (obj) => console.log(`RESULT:${JSON.stringify(obj)}`);
const trace = (...a) => { if (process.env.PS_TRACE) console.error(`[${role}]`, ...a); };

function localAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

try {
  const common = {
    code,
    rendezvousUrl,
    identity: identity.keypair,
    iceServers,
    iceTransportPolicy: policy,
    sessionTimeoutMs: 60_000,
    onStatus: (s, d) => trace('status', s, d ? JSON.stringify(d).slice(0, 200) : ''),
  };

  if (role === 'host') {
    const session = await hostSession({
      ...common,
      onConsentRequest: async () => true,
    });

    const transport = session.peer.transportInfo();
    // Send real payload, paced so SCTP does not simply drop it all.
    let sent = 0;
    for (let i = 0; i < FRAME_COUNT; i++) {
      const frame = Buffer.alloc(FRAME_SIZE, i % 251);
      frame.writeUInt32BE(i, 0);
      try {
        if (session.peer.sendMedia(CHANNEL.VIDEO, frame)) sent++;
      } catch { /* channel closed early */ }
      await new Promise((r) => setTimeout(r, 15));
    }

    // Stay alive briefly so the client can drain.
    await new Promise((r) => setTimeout(r, 3000));
    emit({
      role, ok: true, sent, transport,
      sas: session.peer.sas.phrase,
      addresses: localAddresses(),
    });
    session.close();
  } else {
    const received = [];
    let session;
    const gotAll = new Promise((resolve) => {
      const check = () => { if (received.length >= FRAME_COUNT) resolve(); };
      setTimeout(resolve, 45_000); // resolve with whatever we have
      globalThis.__check = check;
    });

    session = await joinSession(common);
    session.peer.on('video', (payload) => {
      received.push(payload.length);
      globalThis.__check?.();
    });

    await gotAll;
    const transport = session.peer.transportInfo();
    emit({
      role, ok: true,
      received: received.length,
      bytes: received.reduce((a, b) => a + b, 0),
      transport,
      sas: session.peer.sas.phrase,
      rejected: session.peer.session.stats.rejected,
      addresses: localAddresses(),
    });
    session.close();
  }
} catch (err) {
  emit({ role, ok: false, error: err.message, addresses: localAddresses() });
} finally {
  cleanupTransport();
  fs.rmSync(idDir, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 200);
}
