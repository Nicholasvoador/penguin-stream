# Opt-in desktop audio (Linux)

`node/src/media/audio.mjs` provides independent `AudioCapture` and `AudioPlayer`
EventEmitters. The app/CLI integration now enables them only with `--audio` on
each endpoint after secure session consent. Host capture and viewer playback are
separate opt-ins. Merely importing or constructing the classes starts nothing.
Live capture/playback has not been verified; the integration sketch below explains
the module contract rather than implying an unimplemented CLI.

## Prerequisites and privacy

- Host: installed `ffmpeg` with PulseAudio input support, `pactl` with JSON output,
  and an accessible PulseAudio server (including PipeWire's PulseAudio service).
- Viewer: installed `ffplay` supporting raw `s16le`, `sample_rate`, and `ch_layout`.
  Playback uses the viewer's default audio output via FFplay/SDL.
- Linux only. Windows and macOS explicitly throw `unsupported`; there is no
  microphone, DirectShow, WASAPI, or other fallback in this implementation.
- The only accepted capture source option is `default-monitor`. At `start()`, two
  bounded, read-only `pactl` probes resolve the default sink and verify its exact
  `<sink>.monitor` source against monitor metadata. Generic `default`, microphone
  names, arbitrary device names, and command strings are rejected. If the default
  monitor cannot be verified, capture fails closed. It remains pinned to the
  resolved source; changes to the default output require a fresh instance.
- Monitor capture means **all sound mixed into that output**, possibly including
  notifications, calls, and microphone loopbacks configured elsewhere. It never
  intentionally opens a microphone input. Avoid simultaneous bidirectional audio
  or playing the stream into its own captured sink: feedback is possible.
- Nothing installs software or changes PulseAudio/configuration. Executables are
  resolved using trusted local PATH, with fixed argument arrays and `shell:false`.
  No device/binary/source selection should be accepted from a remote peer.

Read-only checks performed on the development host: `/usr/bin/ffmpeg` and
`/usr/bin/ffplay` are installed (FFplay 8.1.2), FFmpeg lists PulseAudio input,
and `pactl` reports a default output monitor separate from microphone sources.
No real capture or audible playback was started. Real end-to-end latency, audio
quality, and operation on other installations remain unverified.

## API

```js
new AudioCapture({ enabled: true, source: 'default-monitor', maxPayload });
new AudioPlayer({ enabled: true, maxPayload });
```

- `enabled` must be boolean `true`; omitted/false is disabled. Platform/opt-in
  checks run before any process creation or device probe.
- `maxPayload`: integer 12–60000, default 3848. Parent should pass the transport's
  `MAX_PAYLOAD` to both classes. The standalone module avoids importing Peer and
  loading the native transport binding; 60000 mirrors the current transport cap.
- `capture.start()` returns the capture instance. Attach `data`, `error`, and
  optionally `log` listeners first. `data` contains one fully framed Buffer ready
  for `peer.sendMedia(CHANNEL.AUDIO, payload)`.
- `player.write(payload)` starts FFplay lazily on the first valid packet. Returns
  `true` if PCM was submitted, `false` if malformed, stale, or backpressured.
  `true` does **not** guarantee audible playback. Never retry dropped packets.
- Attach `error` listeners to **both** instances (normal EventEmitter semantics).
  Opt-in/platform/source/probe validation and synchronous spawn failures throw;
  asynchronous child/pipe failures and unexpected exits emit `error` and stop.
  There is no automatic restart or backend fallback. `log` receives stderr text,
  capped to the first 8192 input bytes per instance (not necessarily whole lines).
- `await stop()` is idempotent, destroys audio pipes, sends SIGTERM, and escalates
  to SIGKILL after 500ms (configurable `killAfterMs`, 1–5000). It waits for child
  `close` to confirm reaping; the deadline is an escalation, not a guarantee that
  an OS-stuck process can be reaped on time. Incomplete capture samples are
  discarded. A stopped instance cannot restart. Create a fresh pair for a new
  stream, since the audio sequence starts at zero again.
- Test-only dependency seams: `spawn`, `platform`, and capture `probe`
  (`execFileSync` signature). Production callers should leave these alone.

## Parent integration sketch

Imports below are relative to a module under `node/src/app/`. Run this only after
existing peer security/consent and local opt-in gates have succeeded. Nothing
here adds a new CLI flag; the parent owns flags, UI consent, errors, and teardown.

```js
import { AudioCapture, AudioPlayer } from '../media/audio.mjs';
import { CHANNEL } from '../crypto/session.mjs';
import { MAX_PAYLOAD, PeerState } from '../transport/peer.mjs';

// Host only, after the user explicitly opts into sharing desktop audio:
const capture = new AudioCapture({ enabled: true, maxPayload: MAX_PAYLOAD });
capture.on('error', reportAudioError);
capture.on('log', reportAudioLog);
capture.on('data', payload => {
  if (peer.state !== PeerState.SECURE) return;
  // Shared video/audio transport queue: drop audio instead of building latency.
  if (peer.bufferedAmount > 64 * 1024) return;
  try {
    peer.sendMedia(CHANNEL.AUDIO, payload); // false => drop, never queue/retry
  } catch (err) {
    reportAudioError(err);
    void capture.stop();
  }
});
try { capture.start(); }
catch (err) { reportAudioError(err); await capture.stop(); }

// Viewer only, after explicit local playback opt-in:
const player = new AudioPlayer({ enabled: true, maxPayload: MAX_PAYLOAD });
player.on('error', err => {
  peer.off('audio', onAudio);
  reportAudioError(err);
});
player.on('log', reportAudioLog);
function onAudio(payload) {
  if (peer.state !== PeerState.SECURE) return;
  try { player.write(payload); }
  catch (err) {
    peer.off('audio', onAudio);
    reportAudioError(err);
    void player.stop();
  }
}
peer.on('audio', onAudio);

// Parent must run its corresponding teardown on disconnect/failure, consent
// revocation, audio-toggle off, and app shutdown (remove listeners FIRST):
async function stopHostAudio() { await capture.stop(); }
async function stopViewerAudio() {
  peer.off('audio', onAudio);
  await player.stop();
}
```

Host and viewer sections belong in their respective processes, not together in a
bidirectional echo loop. `reportAudioError` / `reportAudioLog` are parent callbacks.
Bind teardown to the parent's established lifecycle; do not leave capture running
merely because send attempts are being dropped. Ensure both peers use this audio
wire version before enabling the feature.

## Wire format and bounds

Each AUDIO payload is independently decodable:

| Offset | Bytes | Value |
| --- | --- | --- |
| 0 | 4 | ASCII `PA01` (protocol/format version) |
| 4 | 4 | unsigned 32-bit packet sequence, little-endian, wraps modulo 2^32 |
| 8 | 4–3840 | interleaved signed 16-bit little-endian PCM, 48000Hz, stereo L/R |

No negotiation, length field, timestamp, or fragmentation is required. The fixed
format is stereo frames of 4 bytes. Capture rounds its chunk size down to a whole
frame, bounded by both `maxPayload - 8` and 3840 bytes (20ms). A fixed-size staging
buffer handles arbitrary stdout splits; no concatenating accumulator or packet
queue is retained. At the default/full transport limit this is 50 packets/sec,
roughly 1.54 Mbit/sec of PCM plus framing/security/transport overhead.

The player checks magic, total length, frame alignment, and modular sequence
ordering before playback. Duplicates and late/reordered packets are discarded;
loss moves directly to the next packet, without waiting, silence insertion, or
unbounded jitter buffers. Gaps can click or shorten playback. This minimal
implementation has no A/V sync, codec compression, drift correction, or jitter
concealment; video and audio clocks are independent.

FFplay receives only PCM, never the packet header. The Node writable queue is
limited to 15360 bytes (80ms of PCM), and `write(false)` blocks further submissions
until `drain`. Drops advance sequence tracking so stale retries cannot play later.
There is no application retry queue. FFplay uses `-noinfbuf` to disable its
unlimited-input-buffer mode, but FFplay/SDL/OS pipes have their own bounded buffers;
**80ms is not an end-to-end latency guarantee**. Transport buffering must be gated
by the parent as in the sketch; EventEmitter return values provide no flow control.

## Tests

```sh
node --test node/test/unit/audio.test.mjs
npm run test:unit
```

Tests inject deterministic fake probes/children: no real executable is spawned,
no microphone/monitor is opened, and nothing plays. They cover opt-in/platform and
source rejection, monitor validation, prerequisite failures, shell-free arguments,
chunk split/coalescing, size/alignment/sequence wrap, corrupt/stale packets,
backpressure/drain, bounded stderr, mutable-buffer isolation, spawn/EPIPE/exit
failures, idempotent shutdown and TERM-to-KILL escalation.
