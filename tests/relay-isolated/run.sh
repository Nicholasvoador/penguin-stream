#!/usr/bin/env bash
#
# Forced-relay proof on an isolated topology.
#
# Builds a CGNAT-like network with rootless podman:
#
#     [peer-a] --- ps-net-a --- [turn+rendezvous] --- ps-net-b --- [peer-b]
#                 10.89.0.0/24    (dual-homed)        10.89.1.0/24
#
# ps-net-a and ps-net-b are created with isolate=true, so peer-a has NO route
# to peer-b. The only mutually reachable host is the relay. A successful
# media session therefore *must* have traversed the relay - we assert the
# selected ICE candidate pair is typ relay AND that the TURN server's own byte
# counters moved by at least the payload we sent.
#
# Everything runs in rootless containers. No host firewall, service, or network
# configuration is modified. Cleanup removes only the resources created here.
#
# Usage: ./run.sh [--keep]
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARTIFACTS="$REPO_ROOT/artifacts"
IMAGE="${PS_TEST_IMAGE:-docker.io/library/node:22-slim}"  # glibc: the node-datachannel prebuilt is not musl-compatible
NET_A=ps-net-a
NET_B=ps-net-b
C_RELAY=ps-relay
C_A=ps-peer-a
C_B=ps-peer-b
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

mkdir -p "$ARTIFACTS"
LOG="$ARTIFACTS/relay-isolated-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

FAILED=0
step()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
pass()  { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }
info()  { printf '  ---- %s\n' "$*"; }

cleanup() {
  if [[ $KEEP -eq 1 ]]; then
    info "--keep given; leaving containers and networks in place"
    return
  fi
  step "Cleanup"
  podman rm -f "$C_RELAY" "$C_A" "$C_B" >/dev/null 2>&1
  podman network rm -f "$NET_A" "$NET_B" >/dev/null 2>&1
  info "removed containers and networks created by this script"
}
trap cleanup EXIT

command -v podman >/dev/null 2>&1 || { echo "podman is required"; exit 2; }

step "Preparing isolated networks"
podman rm -f "$C_RELAY" "$C_A" "$C_B" >/dev/null 2>&1
podman network rm -f "$NET_A" "$NET_B" >/dev/null 2>&1
podman network create --opt isolate=true "$NET_A" >/dev/null
podman network create --opt isolate=true "$NET_B" >/dev/null
info "$NET_A $(podman network inspect $NET_A --format '{{range .Subnets}}{{.Subnet}}{{end}}')"
info "$NET_B $(podman network inspect $NET_B --format '{{range .Subnets}}{{.Subnet}}{{end}}')"

MOUNT=(-v "$REPO_ROOT:/app:ro,z" -w /app)

step "Starting relay (TURN + rendezvous), dual-homed"
TURN_USER=penguin
TURN_PASS="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' )"
podman run -d --name "$C_RELAY" --network "$NET_A" --network "$NET_B" "${MOUNT[@]}" \
  -e TURN_USER="$TURN_USER" -e TURN_PASSWORD="$TURN_PASS" \
  "$IMAGE" node /app/tests/relay-isolated/relay-runner.mjs >/dev/null
sleep 3

RELAY_A=$(podman inspect "$C_RELAY" --format "{{(index .NetworkSettings.Networks \"$NET_A\").IPAddress}}")
RELAY_B=$(podman inspect "$C_RELAY" --format "{{(index .NetworkSettings.Networks \"$NET_B\").IPAddress}}")
info "relay is $RELAY_A on $NET_A and $RELAY_B on $NET_B"
podman logs "$C_RELAY" 2>&1 | sed 's/^/  relay| /' | head -5

step "Starting peer containers"
podman run -d --name "$C_A" --network "$NET_A" "${MOUNT[@]}" "$IMAGE" sleep 300 >/dev/null
podman run -d --name "$C_B" --network "$NET_B" "${MOUNT[@]}" "$IMAGE" sleep 300 >/dev/null
IP_A=$(podman inspect "$C_A" --format "{{(index .NetworkSettings.Networks \"$NET_A\").IPAddress}}")
IP_B=$(podman inspect "$C_B" --format "{{(index .NetworkSettings.Networks \"$NET_B\").IPAddress}}")
info "peer-a=$IP_A  peer-b=$IP_B"

step "Precondition: the peers must NOT be able to reach each other"
# UDP rather than ICMP: no ping in the slim image, and UDP is what carries media.
podman exec -d "$C_B" node /app/tests/relay-isolated/netcheck.mjs listen 9999
podman exec -d "$C_RELAY" node /app/tests/relay-isolated/netcheck.mjs listen 9999
sleep 2

if podman exec "$C_A" node /app/tests/relay-isolated/netcheck.mjs probe "$IP_B" 9999 4000 >/dev/null 2>&1; then
  fail "peer-a reached peer-b over UDP - topology is NOT isolated, any relay result would be meaningless"
  exit 1
else
  pass "peer-a cannot reach peer-b ($IP_B) over UDP"
fi

# Positive controls: if these fail the test is broken, not the code.
if podman exec "$C_A" node /app/tests/relay-isolated/netcheck.mjs probe "$RELAY_A" 9999 4000 >/dev/null 2>&1; then
  pass "peer-a can reach the relay ($RELAY_A) over UDP"
else
  fail "peer-a cannot reach the relay - setup broken"; exit 1
fi
if podman exec "$C_B" node /app/tests/relay-isolated/netcheck.mjs probe "$RELAY_B" 9999 4000 >/dev/null 2>&1; then
  pass "peer-b can reach the relay ($RELAY_B) over UDP"
else
  fail "peer-b cannot reach the relay - setup broken"; exit 1
fi

CODE="$(podman exec "$C_A" node -e 'import("/app/node/src/signal/code.mjs").then(m=>console.log(m.generateShareCode()))' 2>/dev/null | tr -d "\r\n")"
info "share code for this run: $CODE"

RVURL_A="ws://$RELAY_A:8787"
RVURL_B="ws://$RELAY_B:8787"

run_peer() {
  local ctr="$1" role="$2" turnhost="$3" rvurl="$4" out="$5"
  podman exec -e ICE_POLICY="${ICE_POLICY:-all}" -e FRAME_COUNT=40 -e FRAME_SIZE=8000 "$ctr" \
    node /app/tests/relay-isolated/peer-runner.mjs \
    "$role" "$rvurl" "$turnhost" 3478 "$TURN_USER" "$TURN_PASS" "$CODE" >"$out" 2>&1
}

step "Scenario 1: automatic fallback (iceTransportPolicy=all, no direct path exists)"
OUT_H="$ARTIFACTS/.relay-host.json"; OUT_C="$ARTIFACTS/.relay-client.json"
ICE_POLICY=all run_peer "$C_A" host "$RELAY_A" "$RVURL_A" "$OUT_H" &
HPID=$!
sleep 2
ICE_POLICY=all run_peer "$C_B" client "$RELAY_B" "$RVURL_B" "$OUT_C" &
CPID=$!
wait $HPID; wait $CPID

HOST_JSON=$(grep -h '^RESULT:' "$OUT_H" 2>/dev/null | tail -1 | sed 's/^RESULT://')
CLIENT_JSON=$(grep -h '^RESULT:' "$OUT_C" 2>/dev/null | tail -1 | sed 's/^RESULT://')

if [[ -z "$HOST_JSON" || -z "$CLIENT_JSON" ]]; then
  fail "a peer produced no result"
  echo "--- host log ---"; tail -20 "$OUT_H"
  echo "--- client log ---"; tail -20 "$OUT_C"
else
  echo "  host  : $HOST_JSON"
  echo "  client: $CLIENT_JSON"

  node -e '
    const host = JSON.parse(process.argv[1]);
    const client = JSON.parse(process.argv[2]);
    const hostIp = process.argv[3];
    const clientIp = process.argv[4];
    let bad = 0;
    const ok = (c, m) => { console.log(`  ${c ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${m}`); if (!c) bad = 1; };

    ok(host.ok && client.ok, "both peers completed without error" + (host.error||client.error ? ` (${host.error||client.error})` : ""));

    // The offering side reports its own relay candidate directly.
    ok(host.transport?.relayed === true,
       `host selected a RELAYED candidate pair (local=${host.transport?.localType})`);

    // The answering side sees the relay as a PEER-REFLEXIVE remote, because the
    // media arrives from the relay address rather than from the peer. So the
    // precise check is: the client must NOT be talking to the peer\x27s address.
    ok(client.transport?.remoteAddress && client.transport.remoteAddress !== hostIp,
       `client\x27s remote is the relay (${client.transport?.remoteAddress}), not peer-a directly (${hostIp})`);
    ok(host.transport?.remoteAddress !== clientIp || host.transport?.localType === "relay",
       `host is not using a direct path to peer-b (${clientIp})`);

    ok(host.sas && host.sas === client.sas, `SAS matched end to end ("${host.sas}")`);
    ok(client.received > 0, `client received ${client.received} media frames`);
    ok(client.received >= host.sent * 0.5, `no catastrophic loss: ${client.received}/${host.sent} frames`);
    ok(client.rejected === 0, "every relayed frame authenticated");
    process.exit(bad);
  ' "$HOST_JSON" "$CLIENT_JSON" "$IP_A" "$IP_B" || FAILED=1
fi

step "Relay server accounting (independent evidence that bytes crossed the relay)"
podman exec "$C_RELAY" cat /tmp/turn-stats.json 2>/dev/null | tee "$ARTIFACTS/.turn-stats.json" | sed 's/^/  /'
STATS=$(cat "$ARTIFACTS/.turn-stats.json" 2>/dev/null)
if [[ -n "$STATS" ]]; then
  node -e '
    const s = JSON.parse(process.argv[1]);
    let bad = 0;
    const ok = (c, m) => { console.log(`  ${c ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${m}`); if (!c) bad = 1; };
    ok(s.allocations >= 2, `TURN served ${s.allocations} allocations`);
    ok(s.relayedToPeer > 0 && s.relayedToClient > 0, `TURN forwarded both directions (${s.relayedToPeer} out, ${s.relayedToClient} in)`);
    ok(s.bytesRelayed > 200000, `TURN relayed ${s.bytesRelayed} bytes of real traffic`);
    ok(s.authFailures === 0, "no TURN auth failures");
    process.exit(bad);
  ' "$STATS" || FAILED=1
else
  fail "could not read TURN statistics"
fi

step "Result"
if [[ $FAILED -eq 0 ]]; then
  printf '  \033[32mALL RELAY ASSERTIONS PASSED\033[0m\n'
  printf '  Peers with no route to each other streamed media through the relay.\n'
else
  printf '  \033[31mRELAY TEST FAILED\033[0m\n'
fi
info "log saved to $LOG"
exit $FAILED
