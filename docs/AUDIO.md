# Desktop audio

The host streams what its computer plays, and the viewer hears it. Both Windows and Fedora can send and play.
**Settings → Audio** controls it; turn *Stream desktop audio* on at both ends. It's on by default.

## The "friend on Discord" problem, and the fix

If you share your screen while you're both in the same Discord call, streaming *all* of the host's audio sends Discord
back to your friend. They hear everyone twice, their own voice included, delayed.

Echo cancellation can't fix that cleanly. The duplicate arrives through a different path, with a different codec and
delay, so it isn't a simple echo. Penguin Stream **leaves the voice app out of the captured audio** instead. That's deterministic,
and you keep hearing the call normally on your own machine.

- **Keep voice chat out of the stream** (on by default) leaves out Discord (and Vesktop/WebCord/ArmCord/Legcord), TeamSpeak,
  Mumble, Zoom, Teams, Skype, Slack, WhatsApp, Telegram, Signal, Element and Guilded. On Linux it also leaves out any stream
  tagged with the *Communication* role.
- **Also leave out these apps:** comma-separated names (partial, any case), e.g. `Spotify, obs64`.
- **Or stream only this app:** e.g. just the game. This never falls back to "everything". If the app can't be isolated,
  no audio is sent and the app tells you why.
- Penguin Stream's own playback is always left out, so a machine that views and hosts can't feed back into itself (Linux; see
  limitations for Windows).

### How it works

| | Linux (PipeWire) | Windows (WASAPI) |
|---|---|---|
| Capture | Own capture node, not auto-connected; each allowed app's output is linked into it. Apps keep playing to your speakers untouched. | Process loopback (`VAD\Process_Loopback`) in *exclude* or *include* mode for the chosen app's process tree; plain loopback otherwise |
| Leaving apps out | Any number of apps | One app tree at a time (the first match), re-resolved every 3 s so an app started mid-session is caught |
| Requirements | PipeWire (Fedora default) | Windows 10 version 2004 (build 19041) or newer for leaving apps out; older versions stream everything and warn |
| Playback | SDL (PipeWire/Pulse) | SDL (WASAPI) |

## Latency

- Capture node quantum ≈ 5 ms; 10 ms packets on the wire (unreliable channel: a late packet is dropped, never retried).
- Viewer jitter buffer: playback starts at 30 ms buffered, and anything past 120 ms queued is dropped so audio can't drift
  behind the video. It re-buffers after an underrun instead of stuttering.

## Wire format

Each packet: `PA01` + u32 sequence (little-endian) + up to 20 ms of s16le 48 kHz stereo PCM (≈ 1.5 Mbit/s). Packets
travel end-to-end encrypted on the AUDIO channel. The player validates magic, size and alignment, and drops duplicates and
stale sequence numbers. Uncompressed PCM costs bandwidth but no codec delay; Opus is a possible future option for slow links.

## Verification

- `node/test/integration/audio-e2e.test.mjs` runs a real host→viewer session on PipeWire. A fake "Discord" app plays 1000 Hz and
  a "game" plays 440 Hz. The viewer's output measures 440 Hz at 7988/8000 amplitude and 1000 Hz at < 3 (left out). Nothing is
  audible during the test: every stream in it is kept off real devices.
- Windows: `ps-media.exe` was exercised under Wine with PipeWire access. Loopback capture and SDL playback work, a
  `Discord.exe` process tree is detected, and the fallbacks behave as described. Wine doesn't implement process loopback,
  so **leaving an app out on real Windows has not been verified yet**.
