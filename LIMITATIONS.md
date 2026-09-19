# Tested / untested matrix — 2026-09-18

The full Windows↔Fedora remote desktop objective is **not complete**. This repository now contains a useful Fedora Wayland video prototype and experimental permission-gated input/audio paths, not a production remote-access product.

| Path | Evidence | Status |
|---|---|---|
| Linux CMake/C++17 build | FFmpeg, PipeWire/GIO, SDL; final build successful | Tested |
| Synthetic VAAPI encode/decode | 30/30 frames, zero decode errors/mismatches, worst color delta 5 | Tested |
| Node regression suite | serial `node --test --test-concurrency=1 --test-timeout=65000 node/test/`: 92 passed, 0 failed, 0 skipped, ~52.3 s | Tested |
| Local CLI synthetic stream | final smoke viewer decoded 688 frames; SAS matched | Tested after integrated changes, audio/input disabled |
| Encrypted H264 integration | final isolated test 60 encoded / 60 received / 60 ffprobe-decoded at 640x360 | Tested |
| Real Fedora Wayland desktop capture | portal + h264_vaapi; final bounded capture 30 packets / 30 independently decoded frames, 2560x1440, requested 10 fps; native stream ~5.6 MB | Tested, local capture only |
| Real desktop H264 forced through relay topology | two portal-captured frames repeated 10x; 20/20 decoded, 7,502,420 byte-exact received bytes, 640 chunks; authenticated; selected host candidate relay; bidirectional peer reachability blocked with positive relay controls; TURN ~8.22 MB forwarded | Tested local rootless isolated topology; recorded video, NOT live capture-through-relay latency |
| Wayland remote keyboard/mouse | RemoteDesktop + ScreenCast shared permission session; strict input validation, key mapping, release tracking, bounded stdin/keyframe path | Builds and unit/parser tested; real consent/injection/revocation NOT tested |
| Linux desktop audio | opt-in PulseAudio default-output monitor → fixed PCM → authenticated AUDIO channel → FFplay; unit tests with fake children; read-only device/prerequisite check | Implemented and CLI-integrated; live capture/playback quality/sync/latency NOT tested |
| Windows DXGI capture | missing backend implemented; CMake MSVC/vcpkg/SDL handling and documentation | NOT compiled or runtime tested; no Windows node/toolchain |
| Windows input/audio | no Windows injector or audio capture/player backend | NOT implemented |
| Real Windows↔Fedora end-to-end | needs two actual OS endpoints | BLOCKED: no Windows node |
| Public Internet / CGNAT / coturn | no public relay or independent WAN endpoints available; coturn not installed | BLOCKED: infrastructure absent; no production claim |
| Packaging / clean-machine onboarding | source build instructions, packaging checklist | No signed installer/release or zero-config public service |

## Known behavior and caveats

- Headless auto-source now fails closed rather than silently falling back to synthetic. Use `--source synthetic` explicitly for tests and `--source portal` for real Fedora desktop verification.
- Portal picks one monitor, embeds cursor and requires compositor permission. CPU buffer copy path, not zero-copy DMA-BUF. Idle frames repeat; mode changes stop capture rather than renegotiate. Scaling/HDR/multi-monitor stitching and accurate A/V clocks are unfinished.
- Input is off by default. Both CLI endpoints use `--allow-input`; host additionally requires portal keyboard and pointer permission. Only the Wayland portal can inject. Special/unicode/layout behavior beyond validated ASCII/common SDL keysyms is limited. Never test arbitrary input against sensitive windows.
- `--audio` is independent opt-in on each Linux CLI endpoint. Output-monitor capture may include all applications/notifications/calls; there is no microphone fallback. PCM uses ~1.54 Mbit/s, no Opus compression, jitter buffer, timestamps, resampling or A/V synchronization. Avoid same-output feedback loops.
- Relay proof uses the custom test TURN on internal rootless networks, forced by lack of a direct route with ICE policy `all` (automatic fallback). This is not evidence that the `--force-relay` flag itself guarantees IP privacy; loopback can select peer-reflexive paths. Use coturn for production after real-world tests.
- A concurrent full-suite attempt hit early ICE failure and hung in the previous E2E harness's failure cleanup. Cleanup was improved; isolated rerun and final serial suite pass. Do not suppress this as if all attempted runs passed.
- Media artifacts are private, local and Git-ignored. Logs may contain ephemeral share/UI secrets; publish only redacted summaries. The repeat-fixture relay script validates the specific two-frame capture and is not a general benchmark.

See SECURITY.md for concrete security fixes and residual risks, docs/WINDOWS.md for untested Windows build steps, docs/AUDIO.md for audio wire/API details, and docs/PACKAGING.md for release gates.
