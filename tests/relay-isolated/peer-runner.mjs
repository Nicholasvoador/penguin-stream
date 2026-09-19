/** Real H264 through the existing signaling, Noise media, Chunker and Reassembler APIs.
 * Credentials are read from a private file, never argv, results or trace output.
 */
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { hostSession, joinSession } from '../../node/src/signal/client.mjs';
import { loadOrCreateIdentity } from '../../node/src/crypto/identity.mjs';
import { cleanupTransport } from '../../node/src/transport/peer.mjs';
import { CHANNEL } from '../../node/src/crypto/session.mjs';
import { Chunker, Reassembler } from '../../node/src/media/chunker.mjs';

process.umask(0o077);
delete process.env.PS_TRACE;
const [role, rendezvousUrl, turnHost] = process.argv.slice(2);
const { user, password, code } = JSON.parse(fs.readFileSync('/run/credentials.json'));
const manifest = JSON.parse(fs.readFileSync('/run/manifest.json'));
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idDir = fs.mkdtempSync(`${os.tmpdir()}/ps-${role}-`);
const identity = loadOrCreateIdentity(idDir);
const common = {
  code, rendezvousUrl, identity: identity.keypair,
  iceServers: [{ hostname: turnHost, port: 3478, username: user, password, relayType: 'TurnUdp' }],
  iceTransportPolicy: 'all', sessionTimeoutMs: 60000,
};
let session;
let status = 1;
const deadline = setTimeout(() => { console.error('Peer deadline exceeded'); process.exit(1); }, 100000);
function controlWait(peer, predicate, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { peer.off('control', handler); reject(new Error('control deadline')); }, timeout);
    const handler = (msg) => {
      if (predicate(msg)) { clearTimeout(timer); peer.off('control', handler); resolve(msg); }
    };
    peer.on('control', handler);
  });
}
try {
  assert(['host', 'client'].includes(role));
  let chunks = 0, units = 0, bytes = 0;
  const streamHash = crypto.createHash('sha256');
  let reassembly, transport;
  if (role === 'host') {
    const source = fs.readFileSync('/fixture/source.h264');
    assert.equal(source.length, manifest.sourceBytes);
    assert.equal(hash(source), manifest.sourceSha256);
    session = await hostSession({ ...common, onConsentRequest: async () => true });
    await controlWait(session.peer, (m) => m.t === 'proof-ready');
    while (!session.peer.media?.isOpen()) await sleep(10);
    const chunker = new Chunker({ maxPayload: manifest.maxPayload });
    for (let repeat = 0; repeat < manifest.repeat; repeat++) {
      for (const unit of manifest.units) {
        const frame = source.subarray(unit.offset, unit.offset + unit.bytes);
        const ack = controlWait(session.peer, (m) => m.t === 'proof-unit' && m.unit === units, 15000);
        // Attach rejection immediately while the sender paces this access unit.
        ack.catch(() => {});
        const parts = chunker.split(frame, { ptsUs: BigInt(units) * 33333n, keyframe: unit.keyframe });
        for (const part of parts) {
          while (session.peer.bufferedAmount > 48000) await sleep(5);
          assert(session.peer.sendMedia(CHANNEL.VIDEO, part), 'media not writable');
          chunks++;
          await sleep(manifest.chunkDelayMs);
        }
        await ack; // Test pacing only; there are no media retransmissions.
        streamHash.update(frame);
        bytes += frame.length;
        units++;
      }
    }
    const finished = controlWait(session.peer, (m) => m.t === 'proof-finished');
    session.peer.sendControl({ t: 'proof-end' });
    await finished;
    transport = session.peer.transportInfo();
  } else {
    session = await joinSession(common);
    const assembler = new Reassembler();
    const fd = fs.openSync('/output/received.h264', 'wx', 0o600);
    const ended = controlWait(session.peer, (m) => m.t === 'proof-end');
    ended.catch(() => {});
    let receiveError;
    session.peer.on('video', (payload) => {
      try {
        chunks++;
        const complete = assembler.push(payload);
        if (!complete) return;
        assert.equal(complete.ptsUs, BigInt(units) * 33333n);
        const expected = manifest.units[units % manifest.units.length];
        assert.equal(complete.keyframe, expected.keyframe);
        assert.equal(complete.frame.length, expected.bytes);
        fs.writeFileSync(fd, complete.frame);
        streamHash.update(complete.frame);
        bytes += complete.frame.length;
        session.peer.sendControl({ t: 'proof-unit', unit: units++ });
      } catch (e) { receiveError = e; }
    });
    // Retry readiness only, not media; avoids the secure-resolution listener race.
    const ready = setInterval(() => session.peer.sendControl({ t: 'proof-ready' }), 200);
    try {
      await ended;
      if (receiveError) throw receiveError;
      fs.fsyncSync(fd);
    } finally { clearInterval(ready); fs.closeSync(fd); }
    assert.equal(units, manifest.transportUnits);
    reassembly = assembler.stats;
    // Snapshot the selected pair before acknowledging completion lets host close.
    transport = session.peer.transportInfo();
    session.peer.sendControl({ t: 'proof-finished' });
    await sleep(300);
  }
  const sha256 = streamHash.digest('hex');
  assert.equal(bytes, manifest.expectedBytes);
  assert.equal(sha256, manifest.expectedSha256);
  console.log(`RESULT:${JSON.stringify({ role, ok: true, chunks, units, bytes, sha256,
    transport, sasHash: hash(session.peer.sas.phrase),
    rejected: session.peer.session.stats.rejected, ...(reassembly ? { reassembly } : {}) })}`);
  status = 0;
} catch (err) {
  // Do not forward library error strings that could contain signaling credentials.
  console.log(`RESULT:${JSON.stringify({ role, ok: false, error: err.name })}`);
} finally {
  session?.close();
  clearTimeout(deadline);
  cleanupTransport();
  fs.rmSync(idDir, { recursive: true, force: true });
  setTimeout(() => process.exit(status), 200);
}
