# Threat model and security review — experimental

This is a targeted source review and local test report, **not an independent security audit or production approval**. Native decoders, WebRTC bindings and custom protocol code process hostile bytes. Use only with trusted peers until reviewed and hardened.

## Assets and adversaries

Assets: desktop pixels, keyboard/mouse permission, system audio, identity private keys, share codes, UI bearer token, TURN credentials. Adversaries: network observers, malicious signaling/relay operators, Internet clients exhausting services, untrusted browser pages targeting the loopback UI, and authenticated but malicious viewers. A compromised endpoint or local user with the same OS account can read process memory/files; this design does not defend against them.

## Implemented controls

- ICE/DTLS/SCTP via node-datachannel; application record encryption uses Node's X25519 and ChaCha20-Poly1305 primitives in a custom Noise XX implementation.
- Per-record channel/sequence headers are authenticated. Authentication is checked **before** updating the bounded replay window. Tests cover corruption, replay, small-order keys, unrelated sessions and SAS divergence under MITM.
- Host application starts video only after cryptographic handshake and explicit host consent. Compare the four verification words out of band. `--yes` is restricted by the CLI to explicit synthetic capture; it skips human verification and is only for controlled tests.
- Wayland capture uses the compositor's portal consent flow rather than bypassing desktop permissions.
- UI binds to loopback and requires a random per-run bearer token. Static content has CSP and nosniff, and HTTP has Host/Origin checks; the UI token is a sensitive local capability, not protection against programs running as your own OS user.
- Identity files are tested for mode 0600 on Linux. Windows ACL behavior is untested.

## Important remaining issues

1. **Invitations are now 160-bit random copy/paste values.** Legacy 40-bit codes are rejected; the room verifier remains public and does not provide password security. Do not use human-chosen invitations. Keep invitations private and compare SAS independently. This change removes feasible exhaustive guessing of generated invitations, not the need for a reviewed protocol.
2. **Custom cryptography lacks independent interoperability/audit evidence.** Passing self-tests does not establish Noise compliance or security. Prefer a maintained reviewed implementation before production.
3. **Bundled TURN is a test fixture, not a public service.** UDP-only, incomplete RFC behavior, no production bandwidth/user quotas or destination restrictions; credentials can permit access to relay-reachable networks. Use maintained coturn with authenticated short-lived users, peer-address restrictions, quotas, TLS support and operational monitoring. No coturn/public deployment was tested here.
4. **Rendezvous DoS:** connection/message/backpressure quotas, paired-room expiry and robust proxy-aware throttling require further work. WSS is required outside loopback for metadata and infrastructure authentication. No public server was deployed.
5. **UI boundary:** WebSocket upgrade Host/Origin checks, 1 KiB message bounds, eight-client cap, POST-only mutation, strict consent booleans, no-store/referrer policy and removal of the token from the displayed URL have been added. Token launch URLs can still exist in process/local logs. Avoid exposing the UI through any proxy. Remote control remains opt-in and experimentally implemented, not end-to-end proven.
6. **Viewer lifecycle:** fixed the detached reader's stack-reference lifetime bug by giving it shared ownership of its frame buffer and thread-local decoder state. Added finite bounded dimensions and strict hex config validation. The reader can still remain blocked until process exit; broader native decoder fuzzing/resource limits and robust cross-platform shutdown remain required. An authenticated peer is not necessarily benign.
7. **Input/audio and trust:** only explicit per-session permissions should enable control/audio; revocation must release held keys and stop processes. Do not auto-persist an unverified viewer-side host as 'verified'. No unattended access, file transfer, clipboard sync, lock-screen/UAC control or privilege escalation is implemented.
8. **Privacy:** direct ICE exposes addresses to the other peer. Relay-only gathering on loopback was observed to select peer-reflexive paths, so the UI must not promise IP anonymity based solely on a flag. Prove selected candidates and actual traffic paths in the intended deployment.

## Safe operating envelope

Local development and explicitly approved private-network experiments only. Do not run any component as root/admin. Do not reuse TURN/share/UI secrets; do not put credentials in command arguments. Never publish captured desktop artifacts or private identity files. Keep dependencies current and review their licenses and binary supply chains. Report security defects privately to the project owner; there is no established public security-contact service.
