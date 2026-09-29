# Changelog

## 1.4.1 — 2026-09-29

Bug fixes and a small latency cut. Same wire protocol: 1.4.1 talks to 1.4.0 and 1.3.1.

### Lower latency: input on a still screen
- The stream window used to check for work every 2 ms. On a still picture (a static desktop, a paused game) every key
  press or mouse move sat there ~1 ms on average, up to 2 ms, before it was even read. Once no new frame has arrived for
  50 ms the window now sleeps until something happens and handles it at once. Measured on Wayland (Fedora 44,
  KDE Plasma 6), time for the window to pick up an event:

  | Still screen | 1.4.0 | 1.4.1 |
  |---|---|---|
  | p50 | 1.10 ms | **0.11 ms** |
  | p95 | 2.10 ms | **0.53 ms** |

- **While frames are arriving nothing changes**: the window waits exactly as 1.4.0 did. A first version that woke the
  window through SDL on every frame was measured *slower* (+0.2 ms per frame on Wayland, where each wake is a compositor
  round trip) and was not shipped. Capture → screen, 1.4.0 vs 1.4.1 alternating on Wayland (3 × 12 s each):

  | Stream | 1.4.0 | 1.4.1 |
  |---|---|---|
  | 1080p60 NVENC | 3.12 ms | 3.17 ms |
  | 1440p60 NVENC | 4.97 ms | 4.94 ms |
  | 1440p120 NVENC | 4.90 ms | 4.87 ms |
  | 1080p60 x264 | 2.41 ms | 2.41 ms |

  All within run-to-run noise (1.4.0 itself moved 0.15 ms between two runs).
- Used where SDL can really be woken from another thread (Wayland, X11, Windows, macOS). Elsewhere the old loop is kept,
  as it was measured faster there. The mode is recorded in the viewer's stats (`wake: event|poll`); `PS_VIEW_POLL=1`
  switches back to the 1.4.0 loop.

### Fixed
- **A frozen stream window is force-closed.** A window stuck in a GPU driver ignored SIGTERM and stayed open forever;
  it now gets SIGKILL after 3.5 s.
- **A stream window that sends corrupt data is closed once**, instead of logging an error for every chunk forever and
  staying open.
- **No crash without `xdg-open`.** Opening the log folder (or the browser) on a system without it, e.g. minimal or
  immutable distros, crashed the whole app.
- **Allow / Refuse** keep the prompt open until the answer is accepted. If the request had already expired you now see
  *"That request expired … your invitation still works"*; before, the click silently did nothing.
- Old diagnostics reports are cleaned up (the newest 5 are kept; the log itself is never touched).
- **Windows:** the stream window can no longer hang on exit in Microsoft's C runtime while waiting for input, and the
  capture engine can no longer touch freed memory if its input thread is stopped late. *Compiled and exercised under
  Wine (every shutdown path exits cleanly), but Wine does not reproduce the original hang, so these two are not proven
  on real Windows.*
- Windows capture error message said "after 1000 ms"; it waits 2 s.
- `.deb` file names now match what GitHub serves (`penguin-stream_<version>.<distro>_amd64.deb`); the README install
  commands were wrong for 1.4.0 downloads. The package version inside is unchanged in form, so apt upgrades normally.

### Tests
- 149 automated tests (5 new). Each new test fails on the 1.4.0 code and passes on 1.4.1.

## 1.4.0 — 2026-09-29

### Fixed: viewers disconnected after a few minutes
- **Root cause found in a real Windows ↔ Fedora session log**: every session ended with *"control channel closed"* a few
  seconds after a network hiccup. Control messages and video/audio shared one replay-protection window of 1024 records.
  When Wi-Fi stalled, the reliable control channel resent a message *after* more than 1024 video/audio records had already
  arrived, the message was taken for a replay, and the whole session was torn down. Control and media are now checked
  separately (control: strictly in order; media: a window of 16384). Same wire format — 1.3.1 and 1.4.0 still talk to
  each other. Regression test reproduces the exact case.
- **No idle timers.** A share waits for a viewer until you press Stop (1.3.1 silently gave up after 30 minutes).
- **Sharing survives a dropped session.** When a session ends — the viewer left, the network dropped, an attempt failed
  or was refused — the host goes straight back to waiting on the same invitation. Only *Stop sharing* ends it.
- **Automatic reconnect.** After an unexpected drop the viewer reconnects by itself (first try after 0.3 s, then backing
  off to every 15 s) until it is back or you press Cancel. A device you approved earlier in the same share gets straight
  back in without a new prompt; anyone else still has to be approved.
- While a stream is live the computer and its screen are kept awake, so power-saving can't end the session.

### Your invitation code stays the same
- The host keeps **one invitation code** from share to share, so your friend can reuse the one they have. A **New code**
  button replaces it only when you want to (e.g. it reached the wrong person) — the old one then stops working.
- The viewer remembers the last invitation that worked: **Reconnect to the last host** is one click on the Connect page.
- Invitation codes are never written to logs or diagnostics reports.

### Adaptive bitrate, rebuilt (latency first)
- 1.3.1 mistook ordinary Wi-Fi jitter for congestion: in the field log the bitrate fell from 10 to 1.5 Mbps in 10 s with
  **no** queue anywhere, and never came back. The new controller:
  - measures queueing from the *fastest* frames of each quarter second against the fastest of the last 10 s — jitter
    spreads the distribution but leaves its minimum alone, a real queue delays every frame. No clock sync needed.
  - reacts 4× a second (was once a second), and when a queue stands it drops straight below the rate the viewer actually
    receives — the link's real capacity — so the queue drains within about a second.
  - comes back fast: at once to just below the capacity it found, then in growing steps once that is clearly beaten.
  - backs off from the rate really sent (the encoder cannot go below ~1.4 Mbps on a busy 1080p60 picture; 1.3.1 kept
    cutting a target it was already missing).
  - changes the bitrate sparingly (each change costs an NVENC keyframe).
  - Simulated links in the test suite: jitter-only Wi-Fi keeps ≥ 8 Mbps (1.3.1: 1.5 Mbps), a 6 Mbps bottleneck is found in
    < 3 s with low delay, a 5 s squeeze to 3 Mbps is followed by a full recovery.
- The log says *why* the bitrate changed (`send queue 40 ms`, `queue delay 90 ms`, `link clear, recovering` …).

### Lower latency
- **NVENC no longer pads every frame with filler data.** Constant-bitrate mode made NVENC pad each frame to
  bitrate ÷ fps with zeros. Same test run: **1.3.1 sent 5.6 MB in 3 s, 86.7 % of it filler; 1.4.0 sends 0.7 MB, 0 %
  filler**, same picture (PSNR 90 dB), same per-frame size cap. Every frame is now as small as its content, so it leaves
  sooner, and the link no longer looks saturated to the bitrate control. AMD (AMF) and VAAPI use no-filler modes too
  (untested on that hardware); trailing filler is stripped for any encoder. `PS_NVENC_CBR=1` restores the old mode.
- **Video is no longer held behind lost packets.** The media channel was meant to be unordered, but the option was
  spelled the browser way and silently ignored, so one lost packet held back every later frame for at least a round trip.
- **Congestion is visible immediately.** The network send buffer was 4 MB: up to ~2 s of video could pile up invisibly
  before frame-skipping or the bitrate control noticed. Now 256 KB.
- **Lost frames are detected.** Frames that vanished completely were never counted: no recovery request, loss shown as
  0 %, the bitrate control blind to it.
- **No keyframe storms**: after asking for a keyframe the viewer waits for it (or ~1.5 round trips) before asking again,
  and the host sends one keyframe per loss burst.
- **The stream window can't fall behind silently**: if decoding can't keep up, it skips to the next keyframe instead of
  queuing frames without limit (latency used to grow second by second, invisible to the meter).
- Corruption the decoder sees triggers a keyframe request at once.
- Engine message parsing is linear: a 3 MB keyframe took 5.2 ms to reassemble, now 0.2 ms. The replay check dropped from
  2.2 µs to 0.1 µs per packet.
- Windows: 1 ms timers are kept even when Windows 11 throttles background processes; capture/render threads get
  multimedia ("Games") scheduling; the viewer uses the Direct3D 11 flip-model renderer instead of Direct3D 9.
- Viewer audio returns to ~30 ms after a burst instead of lagging by up to 120 ms for minutes.
- End-to-end benchmark vs 1.3.1: see *Measured* below.

### Measured (this machine, loopback, idle; 1.3.1 and 1.4.0 alternating, 3 × 20 s each, capture → screen p50)
| Stream | 1.3.1 | 1.4.0 | network stage |
|---|---|---|---|
| 1080p60 NVENC | 3.30 ms | **2.87 ms** | 0.39 → 0.15 ms |
| 1440p60 NVENC | 5.07 ms | **4.89 ms** | 0.35 → 0.19 ms |
| 1440p120 NVENC | 4.84 ms | **4.70 ms** | 0.25 → 0.16 ms |
| 1080p60 x264 | 2.32 ms | 2.34 ms | unchanged (x264 never padded) |

Loopback has unlimited bandwidth, so this shows only the local cost of smaller frames. The fixes that matter most on a
real internet link (no filler, unordered media, small send buffer, the new bitrate control, no disconnects) cannot be
measured on loopback.

### Security and robustness
- The viewer now sees the four verification words **while** the host is asked to compare them (before, only after the
  host had already approved, which made the check impossible).
- Stop/Cancel while connecting can no longer leave a stream running in the background.
- An engine that exits while frames are still being written no longer crashes the whole app.
- A relay credentials URL's `?apiKey=` is hidden in diagnostics reports.
- `--fps 0` no longer crashes the engine; the stream window redraws after being uncovered or resized.

### Ubuntu and Debian
- Native `.deb` packages for **Ubuntu 24.04, Ubuntu 26.04 and Debian 13**, each built against that release's own
  FFmpeg/PipeWire/SDL and install-tested in a clean container.

### Look
- New penguin: redrawn mascot (proper head, chest and flippers, grounded feet, forward lean) and a separate hand-tuned
  small icon for 16–32 px taskbars. New README banner.

### Tested / not tested
- **Tested on this machine** (Fedora 44, RTX 5070): the full suite (144 tests, incl. real host↔viewer sessions over
  loopback: direct, relay, audio, input, latency), engine self-tests (NVENC, NV12, x264), 1.3.1 ↔ 1.4.0 sessions in both
  directions, the Windows engine under Wine (version, self-test, probe), `.deb` install tests in clean containers.
- **Not tested**: a real Windows PC with the new build, real internet paths (the reconnect and bitrate fixes are proven
  with the field log, unit tests and simulated links, not yet on your friend's connection), AMD/Intel encoders.

### Compatibility
- Works with 1.3.1 in both directions (tested). For the new bitrate control and reconnect behaviour, update both sides.

## 1.3.1 — 2026-09-26

### Zero-copy and memory optimizations
- **Windows cursor capture**: replaced full-frame memory copies (~15 MB/frame at 1440p) with sub-rectangle cursor compositing, saving and restoring only the small bounding box under the cursor pointer.
- **Wayland PipeWire zero-copy**: frame buffers pass directly to the encoder without intermediate back-buffer copying whenever strides match.
- **Direct NVENC memory access**: NVENC reads capture frames directly from capture memory without allocating and copying to intermediate staging buffers (with automatic fallback).

### Latency and pacing
- **Zero-wait frame pacing**: minimum frame spacing of `0.6 * period` with dynamic budget accounting, eliminating fixed capture wait latency across high-refresh displays (144 Hz, 165 Hz, 240 Hz) and 60 Hz sources.
- **Monotonic clock sync**: aligned timestamp clocks between the C++ engine and Node application, ensuring accurate latency breakdown reporting on Windows hosts.

### Intra-refresh loss recovery
- **H.264 intra-refresh**: cyclic column intra-refresh for NVENC and libx264 enables smooth video recovery from packet loss within ~1 s without sending massive IDR keyframe spikes.
- **Keyframe suppression**: suppresses redundant full keyframe requests when intra-refresh is active to prevent bandwidth spikes on lossy networks.

### Diagnostics and HUD overlay
- **Troubleshooting logbook**: rotating plain-text diagnostics saved to `%APPDATA%\penguin-stream\logbook.txt` on Windows and `~/.local/state/penguin-stream/logbook.txt` on Linux, with periodic 10s stream health metrics.
- **Activity log export**: Web UI Activity tab allows viewing recent log entries and downloading a sanitized diagnostic report with one click.
- **In-stream HUD overlay**: low-overhead performance HUD using an embedded Hack monospace bitmap font (toggled OFF by default; enable via Ctrl+Alt+Shift+S or settings).

### Compatibility
- Fully backwards-compatible with 1.2.0 and 1.1.2.

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
