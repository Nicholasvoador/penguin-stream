# Private real-H264 isolated relay proof

Run from the existing checkout:

```sh
bash tests/relay-isolated/run.sh /tmp/ps-portal.h264
node --test tests/relay-isolated/chunker.test.mjs
```

Prerequisites: rootless Podman, **cached** `docker.io/library/node:22-slim`, installed repository dependencies compatible with that image, host Python 3 and host ffprobe. Nothing is installed or pulled. The current fixture contract deliberately requires a regular 750242-byte, mode-0644 source with two H264 access units. The original source is read, never modified or mounted.

## Evidence and acceptance

1. Copy the private source into a unique ignored run directory with umask 077 (directory 0700; fixture 0600). Host ffprobe decodes the copy, extracts exact contiguous packet/access-unit boundaries, and counts two frames. Inspect Annex-B NAL **types only**: first AU must have SPS/PPS before IDR and no non-IDR VCL. Decode the ten-times-repeated stream on the host and require 20 frames without ffprobe error output before networking starts.
2. Create two uniquely named rootless Podman networks with `--internal --disable-dns --opt isolate=true`. The relay is dual-homed; each peer joins only one network. Check the actual network metadata and all three containers' route tables: no IPv4 or usable IPv6 default route. No external endpoint is contacted.
3. Bind UDP echo listeners on both peers and the relay. Require host→relay, client→relay, relay→host, and relay→client positive controls. Require host→client and client→host negative probes. Repeat both peer→relay controls afterward. Replies must match a random nonce, source address and port. A negative probe requires repeated explicit ENETUNREACH/EHOSTUNREACH or multiple successfully submitted datagrams without replies; arbitrary socket errors are failures.
4. Use existing `hostSession` / `joinSession` with consent, Noise encryption and `iceTransportPolicy=all` (automatic fallback forced by topology, **not** policy-only relay). Send actual encoded access units with application `Chunker.split`, `Peer.sendMedia(CHANNEL.VIDEO, ...)`, and `Reassembler.push`. Maximum chunk payload is 12000 bytes, including the 17-byte application header. Ten repeats produce **20 transport access units**, **640 chunks**, and an expected **20 decoded frames**. Those counts are independently verified, not treated as synonyms.
5. Client writes only reassembled H264 to `/output/received.h264`, mode 0600. Ready/unit/end controls pace the test and prevent listener/teardown races; media is never retransmitted. Snapshot both selected pairs before teardown. Require host local `relay`, client remote equal to a relay interface rather than the host, matching hashed SAS, all expected chunks/units/bytes, zero media rejects and zero dropped/duplicate/malformed reassembly records.
6. Require independent TURN server counters: at least two allocations, nonzero forwarding both directions, relayed bytes at least the entire H264 payload, and zero auth failures. Host verification compares received bytes directly against source × 10, verifies expected SHA-256, and runs **actual host ffprobe** on received H264, requiring 20 decoded frames and no decoder-error output.
7. Remove only successfully created resources, tracked by IDs (network name retained only until its ID resolves). Containers use create→record ID→start so a failed start remains cleanup-owned. Never pre-delete names or force-remove networks. Run credentials are deleted during cleanup; logs are not printed wholesale. A failure returns nonzero and names its phase and private artifact path.

## Privacy and boundaries

All artifacts are under `tests/relay-isolated/artifacts/`, ignored by the scoped `.gitignore`, including JSON, logs and nested received output. Credentials use private read-only files, not argv/environment/logs. The host peer alone receives a read-only fixture mount; the client receives an output-directory mount, not the source. Mounts expose only required application directories and runner files, not the whole checkout or prior artifacts. No media bytes, images or base64 are emitted. Summary output contains metadata/hashes only.

The containers drop all capabilities and use `no-new-privileges`. On SELinux hosts, `label=disable` is scoped to these disposable containers so the harness does not relabel the checkout or fixture with `:z/:Z`. This reduces SELinux separation **inside this test**, not host policy. The harness does not change host firewall, services, configuration or privileges. Podman manages its own rootless network namespace. No commits, branch operations, external research/network requests, installs or OpenClaw changes are involved.

## Artifacts and limitations

The launcher prints the exact run directory. A successful run has `summary.json`, `verification.log`, `source-probe.json`, `expected-probe.json`, `received-probe.json`, `turn-stats.json`, route/network/probe JSON, private peer/relay logs and `cleanup.json`. `source.h264`, `expected.h264` and `received/received.h264` are private media, not attachments. Failed runs remain for diagnosis; do not mistake an old summary for the launcher exit status.

This proves byte-exact encrypted application-media transport and independent decoding through the project's TURN relay on an isolated rootless topology. It does not prove live capture/display, sustained real-time throughput, audio, WAN loss behavior, arbitrary CGNAT compatibility or performance. Per-unit acknowledgements and conservative chunk pacing are proof harness behavior, not the application's production streaming schedule. A client candidate can be `host → prflx` with `relayed:false`: it sees the relay interface as peer-reflexive. The host's explicit relay candidate, exact relay-address check, UDP no-route evidence and independent TURN counters establish relay use together.

The initial development runs caught strict probe classification of actual no-route errors and a selected-pair snapshot taken after host teardown; both were fixed and the complete proof rerun. No acceptance condition was relaxed to permit partial media delivery.
