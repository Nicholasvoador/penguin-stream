# Changelog

## 1.1.0 — 2026-09-25

### Audio
- **Windows desktop audio** (WASAPI loopback) and a native player on both systems. Audio no longer needs
  `ffmpeg`/`ffplay`/`pactl`; it runs inside the media engine, so the packaged apps have it out of the box. On by default.
- **Keep voice chat out of the stream** (default on): Discord, TeamSpeak, Zoom, Teams, Mumble… are left out of the captured
  audio, so friends in the same call don't hear everyone twice. You still hear them locally. Also: leave out any apps, or
  stream only one app.
  - Linux: PipeWire graph linking; any number of apps, plus anything tagged *Communication*.
  - Windows 10 2004+: WASAPI process loopback excluding (or including) the app's process tree, re-checked every 3 s.
  - "Only this app" never widens to "everything" on failure. Warnings show up as notifications in the app.
- Lower audio latency: 10 ms packets; 30 ms jitter buffer with a 120 ms cap so audio can't drift behind video.
- Penguin Stream never re-captures its own playback (no feedback loop).
- New end-to-end test: real session, fake Discord at 1000 Hz and a game at 440 Hz; the viewer gets the game (7988/8000) and
  not Discord (< 3).
- `doctor` reports audio capability.

## 1.0.0 — 2026-09-25

### Desktop app
- Real desktop application (Electron shell) for **Windows** (installer + portable exe) and **Fedora** (native RPM),
  replacing the "console window + browser tab" launcher. The stream itself still renders in the native SDL window for latency.
- Redesigned interface: sidebar navigation, Home / Live session / Devices / Settings / Network / Activity pages,
  step indicator while sharing, live route/RTT/bitrate/frames tiles, dark and light themes.
- Settings are saved automatically (stream quality, input defaults, relay) in the per-user config directory.

### Connectivity
- **Relay setup in the app:** Cloudflare Realtime TURN (free tier, 24 h credentials minted locally), any HTTPS
  credentials URL (e.g. Metered), or your own TURN server. Only one side needs it.
- **Network check:** measures NAT mapping behaviour (endpoint-independent vs symmetric), IPv6 reachability and STUN RTT,
  and proves the configured relay with a real TURN allocation.
- Fixed: ICE server lists in the standard `urls: [...]` array form were only half-read, and TCP/TLS TURN URLs, which the
  libjuice ICE agent cannot use, are now skipped instead of breaking relay candidates.
- The CLI uses the relay saved in Settings too.

### Latency
- NVENC takes BGRA input and converts colour on the GPU: about 3.2 ms less CPU work per frame at 1440p on the capture→send
  path (measured), with colour accuracy unchanged (selftest worst delta 4/255). `PS_NVENC_NV12=1` restores the old path.
- Single-frame VBV for all encoders (was two), capping per-frame size and so worst-case send time.

### Other
- 7 new tests (110 total).

## 0.10.0 and earlier
Transport (ICE/DTLS/SCTP), Noise XX end-to-end encryption, Nostr pairing, hardware encode/decode, Wayland/X11/DXGI capture,
keyboard/mouse/controller input with live permissions, experimental Linux audio. See the git history.
