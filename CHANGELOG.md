# Changelog

## 1.2.0 — 2026-09-26

### Monitors
- **Shares one monitor by default** instead of every screen side by side. Pick it on Home: *Main monitor*, any monitor
  by name, or *Let me choose each time*.
- Wayland: if the system prompt shares the whole workspace (KDE's "Full workspace"), only the chosen monitor is streamed,
  and remote mouse input is mapped to it. The screen choice is remembered, so later shares skip the prompt.
- Windows: the monitor is matched by its desktop position, which is stable when drivers reorder outputs.
- `penguin-stream monitors` lists monitors; `--monitor` picks one from the command line.

### Stream resolution
- Choose Native, 2160p, 1440p, 1080p (default), 900p, 720p, 540p or a custom size such as 1600×900. The picture keeps the
  monitor's shape and is never enlarged. Scaling runs on several CPU cores: 1440p → 1080p costs about 1 ms per frame.

### Latency
- **Latency meter** on the live page, on both computers: capture, encode, network, decode and display in milliseconds, plus
  the total from capture to screen. The two computers' clocks are synchronized over the encrypted connection. Tips name
  the setting that would help.
- **Adapt bitrate to the connection** (on by default): the bitrate drops as soon as video starts queueing, then slowly
  returns. A bitrate that is too high for the connection is the most common cause of a laggy stream.
- Live bitrate slider on both sides, with no restart. The viewer can ask the host for more or less.
- New frames go to the encoder as soon as the desktop produces them, instead of waiting for a fixed timer. This removes up
  to one frame of delay.
- Frames are split into 4 slices so the viewer decodes each one on several cores.
- Keyframes every 10 s instead of 4 s. Lost frames are still repaired immediately on request.
- The host skips frames once about two frames of video are waiting to send, then resends a full frame so the picture
  recovers.
- Windows: 1 ms timer resolution and higher process priority. Windows normally sleeps in 15.6 ms steps, which made
  frame timing jitter.
- The default bitrate is 15 Mbps (was 20) at 1080p.

### Profiles
- Five presets: **Competitive**, **Balanced (internet)**, **Same house (LAN)**, **Weak connection / relay** and
  **Desktop work**. Save your own setups by name in Settings → Profiles.

### Compatibility
- Works with 1.1.2 in both directions (tested). The latency meter needs 1.2.0 on both computers.

### Tests
- 125 tests: monitor detection and choice, resolution, clock sync, adaptive bitrate, profiles, and an end-to-end session
  that checks scaling, a live bitrate change and the full latency breakdown.

## 1.1.2 — 2026-09-25

### Fixed
- **"A JavaScript error occurred in the main process — Error: Unknown cipher"** when hosting or connecting in the
  Windows and Fedora desktop apps. Electron's crypto (BoringSSL) has no ChaCha20-Poly1305 in `createCipheriv`, and the old
  test suite only ran under plain Node (OpenSSL), so it never saw the failure.
- Signaling and the Noise session now use **AES-256-GCM** (`Noise_XX_25519_AESGCM_SHA256`). It's available in both runtimes
  and hardware-accelerated by AES-NI.
- An encryption failure during signaling now ends that session with an error message instead of crashing the app.
- The window always appears on Wayland, even when `ready-to-show` never fires.

### Compatibility
- **1.1.2 cannot connect to 1.1.0 or 1.0.0.** Room IDs, the signaling salt and the Noise prologue moved to `v2`, so peers
  on different versions fail cleanly instead of half-connecting. Update both computers.

### Tests
- New test runs the signaling encryption and a full Noise handshake **inside the Electron runtime**, plus a static check
  that no source file uses a cipher missing from BoringSSL. 112 tests pass.

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
