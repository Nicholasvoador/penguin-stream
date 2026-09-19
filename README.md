# Penguin Stream — experimental remote-desktop prototype

**Not a finished Windows ↔ Fedora remote desktop product.** Fedora Wayland portal capture now builds and has produced independently decoded real desktop H.264. The baseline transport/CLI/UI tests pass. Permission-gated Wayland input and opt-in Linux audio are implemented and CLI-integrated but live input/audio operation remains unproven. Windows execution, public CGNAT and production relay security remain unproven or incomplete.

## Build and run (Fedora/Linux)

Prerequisites: Node.js >=20, CMake >=3.20, a C++17 compiler, pkg-config, FFmpeg development libraries (`libavcodec libavformat libavutil libswscale libavdevice`), SDL2, PipeWire and GIO development libraries. Install dependencies through your own approved package-management workflow; these instructions do not change host services/firewall.

```sh
npm ci
cmake -S media -B media/build
cmake --build media/build -j2
./media/build/ps-media probe
node node/src/cli.mjs doctor
node node/src/cli.mjs rendezvous --port 8787
```

In separate terminals:

```sh
node node/src/cli.mjs host --source portal --fps 30 --no-input
node node/src/cli.mjs connect "PASTE-INVITATION-HERE" --no-input
```

Invitations contain 160 random bits and are intended for copy/paste, not short spoken codes. Replace the invitation placeholder with the one printed by the host. Compare the four verification words over an independent trusted channel and explicitly approve on the host. The Wayland screen-selection prompt is compositor-controlled: select only the intended screen. `Ctrl+C` stops the host; close the viewer window to disconnect. A local UI is available with `node node/src/cli.mjs ui`; its per-run token URL is sensitive and must not be shared or exposed remotely.

For experimental Wayland control, add `--allow-input` on both CLI endpoints and approve keyboard/pointer access in the compositor prompt. For Linux desktop audio, add `--audio` on each endpoint; this captures the host's default output monitor, never intentionally the microphone. Input/audio live operation is not verified; see the matrix before enabling. Avoid audio feedback when both ends run on one machine.

The default rendezvous is **loopback only from the clients' perspective**. For two machines, both must be configured with the same reachable rendezvous using `--rendezvous`; there is no bundled public infrastructure. Do not deploy the development rendezvous directly on the public Internet. Use authenticated WSS termination and quotas before any deployment.

## CGNAT / relay

Use maintained **coturn**, not the bundled custom UDP test relay, for a production deployment. Configure client ICE through `PENGUIN_TURN`, `PENGUIN_TURN_USER`, and `PENGUIN_TURN_PASSWORD`, or the UI advanced options. Prefer short-lived credentials delivered by a trusted service; do not put passwords in shell arguments or commit them. `--force-relay` requests relay-only ICE but public-network privacy/relay behavior requires separate verification. The existing loopback test can select peer-reflexive paths; it is **not** proof of relay byte transport. The isolated rootless-container harness checks no peer-to-peer route, selected candidates and TURN accounting.

There is no public relay supplied, no account provisioning, no packaged cross-platform installer, and no zero-configuration Internet onboarding yet.

## Tests (bounded output)

```sh
mkdir -p artifacts
npm test > artifacts/tests.log 2>&1; tail -60 artifacts/tests.log
./tests/smoke-local.sh > artifacts/smoke.log 2>&1; tail -35 artifacts/smoke.log
```

Normal tests use synthetic video, not the real desktop. Real screen captures contain private information: keep artifacts local, private, ignored by Git, and never attach them to public reports. See `LIMITATIONS.md` and `SECURITY.md` for the evidence matrix and threat model.
