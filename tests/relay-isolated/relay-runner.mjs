/**
 * Runs in the dual-homed relay container: TURN on 3478 and the rendezvous
 * server on 8787, both bound to all interfaces so each isolated network can
 * reach them.
 *
 * Periodically dumps TURN counters to /tmp/turn-stats.json so the harness can
 * read them as independent evidence of relayed traffic.
 */

import fs from 'node:fs';
import { startTurnServer } from '../../turn/src/server.mjs';
import { startRendezvous } from '../../node/src/signal/server.mjs';

process.umask(0o077);
const { user, password } = JSON.parse(fs.readFileSync('/run/credentials.json'));
if (!password) throw new Error('private credential file required');

const { server: turn } = await startTurnServer({
  port: 3478,
  users: { [user]: password },
  listenAddress: '0.0.0.0',
  relayAddress: '0.0.0.0',
  multiHomed: true,
});
console.log(`turn listening on 0.0.0.0:${turn.port} (multi-homed)`);
console.log(`local addresses: ${turn._localAddresses.join(', ')}`);

const rv = await startRendezvous({ port: 8787, host: '0.0.0.0' });
console.log(`rendezvous listening on 0.0.0.0:${rv.port}`);

turn.on('warning', (m) => console.error('[turn] WARN:', m));
turn.on('error', (e) => console.error('[turn] ERR:', e?.message));
turn.on('allocation', (a) => console.log(`allocation -> relay port ${a.relayPort}`));

const dump = () => {
  try {
    fs.writeFileSync('/tmp/turn-stats.tmp', JSON.stringify(turn.stats), { mode: 0o600 });
    fs.renameSync('/tmp/turn-stats.tmp', '/tmp/turn-stats.json');
  } catch { /* container fs hiccup; not fatal */ }
};
setInterval(dump, 1000);
dump();

process.on('SIGTERM', () => { dump(); process.exit(0); });
