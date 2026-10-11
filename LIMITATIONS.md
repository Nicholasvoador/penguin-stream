# What is verified, what is not

_The tables were last fully reviewed for 1.5.0 (2026-10-10); rows carried over from earlier releases keep the
evidence they were checked with. Release-specific evidence is in [CHANGELOG.md](CHANGELOG.md)._

This page is deliberately blunt: it lists what was actually checked for this release and what was not.

## Verified

| Area | Evidence |
|---|---|
| Automated suite | `npm test`: **185 passed, 0 failed, 0 skipped** (unit + integration: crypto, signaling, ICE/relay, encrypted H.264 end to end, UI API, settings, and remote access with real peers) |
| Crypto inside Electron | Signaling encryption and a full Noise handshake run under the bundled Electron (BoringSSL). The installed Fedora RPM completed a real host↔client connection under its own Electron. |
| NVENC GPU-colour path | `ps-media selftest --encoder nvenc` at 2560×1440, 120 frames: 0 mismatches, worst colour delta 4/255; ~3.2 ms/frame less CPU than the NV12 path (RTX 5070) |
| Fedora RPM | Installed with `dnf` into a **clean Fedora 44 container**: dependencies resolved from stock repos (`libavcodec-free`, `sdl2-compat`); bundled engine probe + encode/decode selftest pass; SUID sandbox, launcher and desktop entry correct. Re-checked the same way for 1.5.0 (install, selftest, setuid sandbox, clean uninstall) |
| Ubuntu/Debian `.deb` packages | `scripts/test-deb.sh`: each of the three is installed with `apt` into a fresh container of its own release (24.04, 26.04, Debian 13). Every dependency resolved; all libraries resolve; engine selftest passes; the bundled Node side (native WebRTC module, crypto) loads under the installed Electron; desktop entry, launcher and SUID sandbox correct; clean uninstall |
| Packaged Linux app | Boots from the packaged asar, loads the native WebRTC module, serves the UI, runs the network check (rendered headless) |
| Windows build | Installer + portable exe built; bundle contains `ps-media.exe` + FFmpeg/SDL DLLs and the win32 `node-datachannel` prebuild. `ps-media.exe` **under Wine**: probe reports DXGI/GDI capture, SendInput, ViGEm detection; software encode→decode selftest passes. Re-run for 1.5.0: `selftest` reports `ok:true`, 120 quadrant checks, 0 mismatches |
| Audio + voice-chat exclusion (Linux) | Real host→viewer session on PipeWire: game tone received at 7988/8000 amplitude, fake Discord tone < 3 (left out); own playback never re-captured |
| Windows audio engine | Under Wine with PipeWire access: WASAPI loopback capture and SDL playback work; `Discord.exe` process tree detected; fallbacks correct ("only" mode sends nothing rather than everything) |
| Network check | Live on a real CGNAT'd connection: endpoint-independent mapping detected; TURN probe verified against a local TURN server (success, wrong password, no-UDP cases) |
| Packaged Linux app, 1.5.0 | The built RPM's app directory was run for real: reports **version 1.5.0**, remote access switched on through its own API (code well-formed), *Start Penguin Stream when I log in* wrote and then removed `~/.config/autostart/penguin-stream.desktop` pointing at the right launcher, and `--hidden` with remote access on kept running with no window |
| Wayland restore without a prompt | **Verified on a real desktop** (Fedora 44, KDE Plasma 6.7.5, Wayland): one click at the PC with *restoring* ticked, then an unattended session started **with no prompt** — first video 1.64 s after the viewer connected, 1080p60, 480 frames in 8 s, keyboard/mouse ready, *End session* worked, grant renewed |

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

- Wayland asks for screen-sharing consent the first time. After that the choice is remembered, until you revoke it or the
  monitor layout changes. Upgrading from 1.4.x asks once more, because the app now registers a fixed identity with the
  desktop portal (a grant is only offered to the identity that saved it). The capture path copies through the CPU (no
  DMA-BUF zero-copy yet).
- Cropping one monitor out of a whole-workspace share uses the monitor layout reported by `kscreen-doctor`/`xrandr`.
  If the desktop is scaled unusually and the crop is wrong, choose the monitor in the system prompt instead.
- The latency meter's network figure depends on clock synchronization. Across the internet it is accurate to within
  about half the difference between the upload and download delays (usually a few ms).
- The relay uses UDP only (libjuice limitation). Networks that block all outbound UDP cannot connect.
- The custom Noise implementation is tested but has not been independently audited. See [SECURITY.md](SECURITY.md).
- Direct connections reveal your IP to the peer. Use **Relay only** to hide it (adds latency).

## Remote access (1.5.0)

| Area | Status |
|---|---|
| Access-code pairing, auto-approval, anti-replay, busy/pause rules | Automated tests with real peers (ICE/DTLS/SCTP/Noise) over a local mock Nostr relay and a local rendezvous |
| Full session through the app's own server | Automated: real host, real `ps-media` (synthetic source), real transport; video flows with no prompt; *End session* tells the viewer; capture failures and start time-outs are explained to the viewer |
| Wayland (KDE Plasma 6) restore without a prompt | Verified minutes after the grant (see above). **Not verified**: a session days later, or after a reboot or a re-login, and whether the prompt itself is visible when it is triggered from the tray with no window open |
| Windows host | **Not verified on real Windows.** Expected: works while signed in and unlocked; the lock screen and UAC prompts can't be seen or controlled |
| KDE lock screen | **Not verified.** From KWin's source: the screencast keeps running and remote input reaches the lock screen, so unlocking remotely should work |
| GNOME | **Not verified.** GNOME refuses to start screen-casts while the session is locked |
| Start at login | The XDG autostart entry is verified in the packaged Linux build (written, then removed, pointing at the right launcher). `--hidden` with remote access on stays running with no window. Windows' login item was not exercised |
| Tray icon and its menu | **Not verified.** Creating the tray runs without error in the packaged build, but the build machine has no working tray host: even a bare Electron tray registers nothing with the desktop's tray watcher there. Needs a look on a real panel |

Known behaviour: a PC that is asleep, off or not logged in can't be reached (Penguin Stream runs in your desktop session).
Set automatic login and disable sleep if you need access after power cuts or reboots.
