# Changelog

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
