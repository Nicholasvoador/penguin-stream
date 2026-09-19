/** UDP echo probes with nonce/source validation; timeout=1, infrastructure error=2.
 * routes asserts no IPv4/IPv6 default route, without sending external traffic.
 */
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const [mode, host, portArg, timeoutArg] = process.argv.slice(2);
if (mode === 'routes') {
  const ipv4 = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1).map((s) => s.trim().split(/\s+/));
  const ipv6 = fs.readFileSync('/proc/net/ipv6_route', 'utf8').trim().split('\n').filter(Boolean).map((s) => s.trim().split(/\s+/));
  const noDefaultRoute = !ipv4.some((r) => r[1] === '00000000' && r[7] === '00000000');
  // Ignore kernel's unreachable IPv6 reject-route sentinel (RTF_REJECT=0x200).
  const ipv6DefaultAbsent = !ipv6.some((r) => r[0] === '0'.repeat(32) && r[1] === '00' && !(parseInt(r[8], 16) & 0x200));
  console.log(JSON.stringify({ noDefaultRoute, ipv6DefaultAbsent, ipv4, ipv6 }));
  assert(noDefaultRoute && ipv6DefaultAbsent, 'external default route present');
} else if (mode === 'listen') {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, remote) => sock.send(msg, remote.port, remote.address));
  sock.bind(Number(host), '0.0.0.0', () => fs.writeFileSync(`/tmp/udp-${host}.ready`, 'ready'));
} else if (mode === 'probe') {
  const sock = dgram.createSocket('udp4');
  const port = Number(portArg), timeout = Number(timeoutArg || 2000);
  const nonce = crypto.randomBytes(24);
  let sent = 0, errors = 0, noRoute = 0;
  const finish = (code) => { console.log(JSON.stringify({ status: code === 1 && noRoute ? 'no-route' : ['reachable', 'timeout', 'error'][code], sent, errors, noRoute })); sock.close(); process.exit(code); };
  sock.on('message', (msg, r) => {
    if (r.address === host && r.port === port && msg.equals(nonce)) finish(0);
  });
  sock.on('error', () => finish(2));
  const send = () => sock.send(nonce, port, host, (err) => {
    if (err?.code === 'ENETUNREACH' || err?.code === 'EHOSTUNREACH') noRoute++;
    else if (err) errors++;
    else sent++;
  });
  send();
  setInterval(send, 200);
  setTimeout(() => finish(sent + noRoute >= 3 && errors === 0 ? 1 : 2), timeout);
} else {
  console.error('usage: routes | listen port | probe host port [timeoutMs]');
  process.exit(2);
}
