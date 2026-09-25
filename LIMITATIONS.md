# What is verified, what is not

_Last updated for 1.1.2 (2026-09-25). Release-specific notes are in [CHANGELOG.md](CHANGELOG.md)._

This page is deliberately blunt: it lists what was actually checked for this release and what was not.

## Verified

| Area | Evidence |
|---|---|
| Automated suite | `npm test`: **112 passed, 0 failed, 0 skipped** (unit + integration: crypto, signaling, ICE/relay, encrypted H.264 end to end, UI API, settings) |
| Crypto inside Electron | Signaling encryption and a full Noise handshake run under the bundled Electron (BoringSSL). The installed Fedora RPM completed a real host↔client connection under its own Electron. |
| NVENC GPU-colour path | `ps-media selftest --encoder nvenc` at 2560×1440, 120 frames: 0 mismatches, worst colour delta 4/255; ~3.2 ms/frame less CPU than the NV12 path (RTX 5070) |
| Fedora RPM | Installed with `dnf` into a **clean Fedora 44 container**: dependencies resolved from stock repos (`libavcodec-free`, `sdl2-compat`); bundled engine probe + encode/decode selftest pass; SUID sandbox, launcher and desktop entry correct |
| Packaged Linux app | Boots from the packaged asar, loads the native WebRTC module, serves the UI, runs the network check (rendered headless) |
| Windows build | Installer + portable exe built; bundle contains `ps-media.exe` + FFmpeg/SDL DLLs and the win32 `node-datachannel` prebuild. `ps-media.exe` **under Wine**: probe reports DXGI/GDI capture, SendInput, ViGEm detection; software encode→decode selftest passes |
| Audio + voice-chat exclusion (Linux) | Real host→viewer session on PipeWire: game tone received at 7988/8000 amplitude, fake Discord tone < 3 (left out); own playback never re-captured |
| Windows audio engine | Under Wine with PipeWire access: WASAPI loopback capture and SDL playback work; `Discord.exe` process tree detected; fallbacks correct ("only" mode sends nothing rather than everything) |
| Network check | Live on a real CGNAT'd connection: endpoint-independent mapping detected; TURN probe verified against a local TURN server (success, wrong password, no-UDP cases) |

## Not verified yet — please report results

| Area | Status |
|---|---|
| **Windows on real hardware** | Not run on a physical Windows PC during this release (no Windows machine in the build environment). The Electron app, DXGI capture, SendInput and GPU encoders on Windows are built and packaged but unproven end to end. |
| **Windows ↔ Fedora over the Internet** | No two-machine WAN session was run for this release. |
| **Cloudflare TURN** | Implemented against Cloudflare's documented API; not exercised with a real account. The generic TURN path it relies on is tested. |
| **Wayland remote input** | Implemented through the RemoteDesktop portal and unit-tested; live injection on KDE/GNOME not re-verified for this release. |
| **Windows app exclusion** | Process loopback (leaving Discord out) is implemented to Microsoft's API but Wine can't run it; it hasn't been exercised on real Windows yet. Windows can exclude only one app tree at a time, and a Windows machine that both views and hosts may re-capture its own stream audio. |
| **Code signing** | Windows builds are unsigned (SmartScreen warning). The RPM is unsigned (`dnf` installs local files without a GPG check). |

## Known behaviour

- Wayland asks for screen-sharing consent on every share (compositor policy). The portal captures one monitor, and the capture
  path copies through the CPU (no DMA-BUF zero-copy yet).
- The relay uses UDP only (libjuice limitation). Networks that block all outbound UDP cannot connect.
- The custom Noise implementation is tested but has not been independently audited. See [SECURITY.md](SECURITY.md).
- Direct connections reveal your IP to the peer. Use **Relay only** to hide it (adds latency).
