/**
 * UDP reachability probe used to verify the test topology before we trust any
 * relay result.
 *
 * ICMP would be the obvious tool, but the container image has no ping, and UDP
 * is what actually carries our media anyway - so this measures the thing we
 * care about.
 *
 *   node netcheck.mjs listen <port>
 *   node netcheck.mjs probe  <host> <port> [timeoutMs]
 *
 * probe exits 0 if a reply came back ("REACHABLE"), 1 if it timed out
 * ("UNREACHABLE").
 */

import dgram from 'node:dgram';

const [mode, a, b, c] = process.argv.slice(2);

if (mode === 'listen') {
  const port = Number(a || 9999);
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    sock.send(Buffer.concat([Buffer.from('pong:'), msg]), rinfo.port, rinfo.address);
  });
  sock.bind(port, '0.0.0.0', () => console.log(`listening udp/${port}`));
} else if (mode === 'probe') {
  const host = a;
  const port = Number(b);
  const timeout = Number(c || 4000);
  const sock = dgram.createSocket('udp4');
  let settled = false;

  const finish = (reachable, detail) => {
    if (settled) return;
    settled = true;
    console.log(reachable ? `REACHABLE ${detail}` : `UNREACHABLE ${detail}`);
    try { sock.close(); } catch { /* already closed */ }
    process.exit(reachable ? 0 : 1);
  };

  sock.on('message', (msg) => finish(true, msg.toString().slice(0, 32)));
  sock.on('error', (err) => finish(false, `socket error: ${err.message}`));

  // Retry a few times: a single lost datagram must not read as "isolated".
  let attempts = 0;
  const tick = setInterval(() => {
    if (settled) return clearInterval(tick);
    attempts++;
    sock.send(Buffer.from(`ping-${attempts}`), port, host, (err) => {
      if (err && attempts >= 3) finish(false, `send failed: ${err.message}`);
    });
  }, 500);

  setTimeout(() => { clearInterval(tick); finish(false, `no reply in ${timeout}ms after ${attempts} attempts`); }, timeout);
} else {
  console.error('usage: netcheck.mjs listen <port> | probe <host> <port> [timeoutMs]');
  process.exit(2);
}
