# Implementation milestone / parent handoff — 2026-09-18

Requested parent: agent:main:dashboard:e7a0ac03-85c2-43c8-ae9c-043e86c6cecf.

Goal remains active. No full cross-platform completion claim.

Implemented: preserved/finished Wayland portal capture with stable consumer buffers, safe plane bounds, real first-frame wait, idle-frame cadence; opt-in RemoteDesktop keyboard/pointer permissions with validated input and held-state release; bounded stdin control/keyframes, flush and failure exits; experimental DXGI backend and Windows CMake; opt-in Linux monitor audio with bounded PCM transport/playback; auth/UI/TURN hardening and SDL reader lifetime fix; practical source build, packaging checklist, threat model and verification matrix.

Measured proof:
- Linux build passes; 30-frame VAAPI synthetic selftest, zero mismatches/decode errors, worst color delta 5.
- Final serial Node suite 92/92 passed (~52.3 seconds); subsequent UI suite 15/15 passed.
- Isolated encrypted H264 integration 60 sent / 60 received / 60 independently decoded.
- Real KDE Wayland desktop: portal + VAAPI 2560x1440 at requested 10 fps; 30 captured packets / 30 ffprobe-decoded frames. Private artifact artifacts/desktop-final.h264.
- Rootless isolated real-video relay proof: original two desktop frames repeated ten times, 20 received/decoded, 640 chunks, 7,502,420 byte-exact bytes; zero rejected/dropped/malformed/duplicate units. TURN forwarded 8,219,780 bytes with two allocations. No route between peers in either direction and positive relay controls passed. Three containers/two networks cleaned up. Evidence tests/relay-isolated/artifacts/run-AbNdTvYn/summary.json (private ignored).
- One overlapping full-suite attempt failed ICE and hung due failure cleanup; fixed E2E cleanup and isolated/final serial reruns passed. Do not erase that qualification.

Security highlights: reject unsigned post-MESSAGE-INTEGRITY TURN attrs and duplicate security/scalar attrs, allocation owner checks, expiry checks, capped nonce/allocation resources and pending-bind reservation; UI WS Host/Origin + bounds, strict approval boolean/POST mutations and no-store/referrer; removed automatic unverified viewer trust; input off by default; CLI --yes only synthetic; no silent synthetic fallback. Residual risks include 40-bit code offline guessing, unaudited custom Noise implementation, no production rendezvous DoS/quotas or coturn deployment, native-decoder hardening and complete shutdown behavior.

Blockers / untested: no Windows node or build toolchain (DXGI not compiled); no Windows input/audio; no public relay/coturn/WAN endpoints; real portal input injection/revocation and audible audio sync/latency not exercised; relay proof is replayed capture, not live pipeline performance; no signed installers or clean-machine onboarding. These are detailed in LIMITATIONS.md, SECURITY.md and docs/.

All implementation changes are project-scoped. No host firewall/service/config, privileged installs, purchases, public deployment or Sunshine configuration edits. Private media and raw logs are Git-ignored and not published.

Delegated model route reported by workers: cheaper-inference/gpt-6-astra → cheaper-inference/openai/gpt-6-astra. One initial Windows patch operation denied its path; no change then. Standard absolute-path file write was accepted and used for the implementation without changing access policy.
