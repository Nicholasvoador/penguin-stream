# Threat model and security review — experimental

This is a targeted source review and local test report, **not an independent security audit or production approval**. Native decoders, WebRTC bindings and custom protocol code process hostile bytes. Use only with trusted peers until reviewed and hardened.

## Assets and adversaries

Assets: desktop pixels, keyboard/mouse permission, system audio, identity private keys, share codes, UI bearer token, TURN credentials. Adversaries: network observers, malicious signaling/relay operators, Internet clients exhausting services, untrusted browser pages targeting the loopback UI, and authenticated but malicious viewers. A compromised endpoint or local user with the same OS account can read process memory/files; this design does not defend against them.

## Implemented controls

- ICE/DTLS/SCTP via node-datachannel; application record encryption uses Node's X25519 and AES-256-GCM primitives in a custom Noise XX implementation (`Noise_XX_25519_AESGCM_SHA256`). AES-GCM was chosen because it exists in both OpenSSL (Node) and BoringSSL (Electron), and a test runs the handshake under Electron.
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
7. **Input/audio and trust:** only explicit per-session permissions should enable control/audio; revocation must release held keys and stop processes. Do not auto-persist an unverified viewer-side host as 'verified'. Unattended access exists only as opt-in **remote access** (below). No file transfer, clipboard sync, Windows lock-screen/UAC control or privilege escalation is implemented.
8. **Privacy:** direct ICE exposes addresses to the other peer. Relay-only gathering on loopback was observed to select peer-reflexive paths, so the UI must not promise IP anonymity based solely on a flag. Prove selected candidates and actual traffic paths in the intended deployment.

## Safe operating envelope

Local development and explicitly approved private-network experiments only. Do not run any component as root/admin. Do not reuse TURN/share/UI secrets; do not put credentials in command arguments. Never publish captured desktop artifacts or private identity files. Keep dependencies current and review their licenses and binary supply chains. Report security defects privately to the project owner; there is no established public security-contact service.

## 1.0 additions: relay credentials and settings

- Relay secrets (TURN password, Cloudflare API token) live only in `settings.json` in the per-user config directory
  (`~/.config/penguin-stream`, `%APPDATA%\penguin-stream`), written with owner-only permissions on Linux. The UI API never
  returns them: it only reports whether one is set. Windows ACLs rely on the per-user profile default.
- A Cloudflare API token can mint TURN credentials billed to that account; treat it like a password. Sessions only ever use
  24-hour credentials derived from it, and the token itself never goes to the peer.
- The desktop window loads only the loopback UI origin; navigation elsewhere is blocked and external links open in the system
  browser. The renderer runs sandboxed with context isolation and no Node integration.

## 1.5 additions: remote access (unattended)

What it grants: while the owner has switched remote access **on**, anyone holding the PC's access code can see and control
that desktop session **without a prompt**, exactly as the logged-in user. It is meant for reaching your own computer.

- **Off by default.** It is switched on only through its own local UI action, which the UI confirms first. The generic
  settings endpoint ignores `remoteAccess`/`accessCode`, so a settings import or a bug there cannot switch it on. Turning
  it off stops the listener and ends a live remote session immediately. It is remembered across restarts.
- **The code is a capability, not a password.** It is `PA-` plus 160 bits from the CSPRNG and is never chosen by a human.
  Pairing runs over public Nostr relays that anyone can read, so a guessable secret could be attacked offline. Stored in
  `settings.json` (owner-only on Linux). It is never returned by the settings API, the broadcast UI state, diagnostics
  or logs (the log redactor matches it), and is handed out only by `GET /api/remote-access`.
- **Domain separation.** Room id, signaling key, Noise prologue and Nostr topic for access codes use different labels
  from invitations, so an invitation (even one with the same 160-bit body) can never reach the remote-access listener.
  Invitation derivations are unchanged byte for byte (golden-value test).
- **Approval = proof of the code.** The Noise prologue is derived from the code. A peer without it cannot complete the
  XX handshake (the responder's static key is encrypted under the transcript), and the host's approval callback runs only
  after the handshake. The approval verdict is now strict: only `true`/`{ ok: true }` approves (previously any truthy value).
- **Anti-replay on the signaling.** Access-code signals carry the sender's clock and are ignored outside ±10 minutes. The
  listener also remembers viewer sessions it already dealt with and ignores them. A relay that recorded a connection
  cannot replay it to keep the listener busy. Tested, including a control case without the memory.
- **Visibility and control at the PC.** Every session shows a banner with the device fingerprint and *End session*, a
  desktop notification, and a log line. *New code* invalidates the old code at once and ends a session using it.
  While another session is live on the PC, remote access is paused, so it cannot hijack someone else's session. A friend
  who is only *waiting* on an invitation is paused and resumed afterwards.
- **Wayland.** The compositor's restore grant ("allow restoring") lets Penguin Stream start screen + input capture
  without a prompt. The engine registers itself with the desktop portal under a fixed app id (`penguin-stream`, overridable
  with `PS_PORTAL_APP_ID`) *before* it asks for anything else on that connection, so the grant is bound to one identity
  that does not depend on how the app was started (menu, autostart, a terminal). Grants are per identity: a session that
  cannot restore gets a permission prompt instead, which is the only way an unattended session can stall. Capture that
  does not start within 30 s is ended and explained to the viewer; because that means the prompt appeared with nobody
  there, the stored grant is then dropped and the owner is told to allow screen access once more (the card goes back to
  *One-time setup*), so the same dead grant is not retried forever.

Residual risks: the access code is as powerful as the user's desktop session. Malware on either device can read it, and
there is no second factor or device allow-list yet. Relay operators can see that an IP is listening on some topic for as
long as remote access is on (not who connects, nor any content). The device fingerprint shown at the PC is for auditing,
not authorization. The KDE lock screen receives remote input per KWin's design, which lets you unlock remotely, but this is not
verified in a real session yet.
