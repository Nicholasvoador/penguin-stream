# Parent verification — 2026-09-18

Independent rerun before hardening: 92/92 Node tests passed. Native VAAPI
selftest independently rerun: 30 packets/30 decoded frames, zero mismatches,
zero decode errors, worst quadrant color delta 5.

Invitation hardening: replaced legacy 40-bit codes with 160-bit random copy/paste
invitations; legacy short values rejected. Added UI copy action, updated format,
and removed unsupported SAS grinding security claims. No novel PAKE introduced.
Custom cryptography remains unaudited.

Preserved and reviewed unfinished UI lifecycle patch: epoch-bound callbacks,
cancel pending consent on stop, strict methods, fragment-based launch token,
no token in HTTP query/console. Regression uncovered ECONNRESET after oversized
body rejection; fixed by closing that connection explicitly. UI rerun: 18/18.
Final full-suite rerun: 95/95 passed, zero failures/skips, ~51.1 seconds.
See private artifacts/parent-final-tests.log for details.

Local bundle script uses an explicit source allowlist and a SHA-256 per-file
manifest. Repeated generation with unchanged inputs produced identical archive
hashes. Private captured media, logs, identities, dependencies and Git history
are excluded. Not a self-contained installer; binary dependency/license review
is required before distribution. Nothing published.

Outstanding: Windows toolchain/device; Windows input/audio implementation;
live input/audio behavior and end-to-end timing; real public rendezvous/coturn
infrastructure and independent WAN endpoints; deployment hardening and signed
installers. Recorded desktop-video relay proof does not establish live capture
through relay or Internet CGNAT qualification. No qualified Windows endpoint or
public server was provided in response to the resource question.

Model routing notice reported during delegated work:
cheaper-inference/gpt-6-astra → cheaper-inference/openai/gpt-6-astra.
