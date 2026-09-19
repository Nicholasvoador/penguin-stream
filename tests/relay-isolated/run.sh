#!/usr/bin/env bash
# Rootless, cached-image-only, internal-network real H264 fallback proof.
set -Eeuo pipefail
umask 077
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE="$REPO_ROOT/tests/relay-isolated"
IMAGE=docker.io/library/node:22-slim
[[ $# -le 1 ]] || { echo 'usage: run.sh [/path/to/private/source.h264]'; exit 2; }
SOURCE="${1:-/tmp/ps-portal.h264}"
mkdir -p "$BASE/artifacts"
RUN="$(mktemp -d "$BASE/artifacts/run-XXXXXXXX")"
chmod 700 "$RUN"
exec 3>&1
printf 'Private proof artifacts: %s\n' "$RUN" >&3
exec >"$RUN/run.log" 2>&1
CONTAINERS=() NETWORKS=() PIDS=()
PHASE=preflight
cleanup() {
  local status=$? cleanup_failed=0
  trap - EXIT
  set +e
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; done
  for id in "${CONTAINERS[@]}"; do podman rm -f "$id" >>"$RUN/cleanup.log" 2>&1 || cleanup_failed=1; done
  for id in "${NETWORKS[@]}"; do podman network rm "$id" >>"$RUN/cleanup.log" 2>&1 || cleanup_failed=1; done
  # Run credentials are not retained even in private artifacts.
  rm -f "$RUN/credentials.json"
  (( cleanup_failed == 0 )) || status=1
  printf '{"ok":%s,"containers":%s,"networks":%s}\n' "$([[ $cleanup_failed == 0 ]] && echo true || echo false)" "${#CONTAINERS[@]}" "${#NETWORKS[@]}" >"$RUN/cleanup.json"
  if (( status == 0 )); then
    printf 'PASS: real H264 relay proof; summary: %s/summary.json\n' "$RUN" >&3
  else
    printf 'FAIL: phase=%s exit=%s; private logs: %s\n' "$PHASE" "$status" "$RUN" >&3
    # Whitelisted diagnostics only: never dump arbitrary library logs/secrets.
    grep -E '^(AssertionError:|Error:|PermissionError:|FileNotFoundError:|RuntimeError:)' "$RUN/run.log" "$RUN/verification.log" 2>/dev/null | tail -5 | cut -c1-240 >&3
  fi
  exit "$status"
}
trap cleanup EXIT
for cmd in podman node python3 ffprobe; do command -v "$cmd"; done
[[ "$(podman info --format '{{.Host.Security.Rootless}}')" == true ]]
podman image exists "$IMAGE"
git -C "$REPO_ROOT" check-ignore "$RUN/run.log"
python3 "$BASE/media-proof.py" prepare "$SOURCE" "$RUN"
node --input-type=module - "$RUN/credentials.json" "$REPO_ROOT" <<'JS'
import fs from 'node:fs';
import crypto from 'node:crypto';
const { generateShareCode } = await import(`${process.argv[3]}/node/src/signal/code.mjs`);
fs.writeFileSync(process.argv[2], JSON.stringify({ user: 'penguin', password: crypto.randomBytes(24).toString('hex'), code: generateShareCode() }), { mode: 0o600 });
JS
mkdir -m 700 "$RUN/received"
PREFIX="ps-proof-$(basename "$RUN")-$$"
NET_A="$PREFIX-a"; NET_B="$PREFIX-b"
PHASE=networks
for net in "$NET_A" "$NET_B"; do
  # Never pre-delete names; only retain IDs returned by successful creation.
  id=$(podman network create --internal --disable-dns --opt isolate=true "$net")
  NETWORKS+=("$id") # Successful create returns this run's unique name.
  NETWORKS[$((${#NETWORKS[@]} - 1))]="$(podman network inspect "$id" --format '{{.ID}}')"
done
podman network inspect "$NET_A" >"$RUN/network-a.json"
podman network inspect "$NET_B" >"$RUN/network-b.json"
# No :z/:Z relabel: do not mutate labels on the user's checkout/private source.
# SELinux label separation is disabled only for these short-lived test containers.
MOUNT=(--security-opt label=disable --cap-drop=all --security-opt no-new-privileges
  -v "$REPO_ROOT/node:/app/node:ro" -v "$REPO_ROOT/turn:/app/turn:ro"
  -v "$REPO_ROOT/node_modules:/app/node_modules:ro" -w /app
  -v "$BASE/peer-runner.mjs:/app/tests/relay-isolated/peer-runner.mjs:ro"
  -v "$BASE/relay-runner.mjs:/app/tests/relay-isolated/relay-runner.mjs:ro"
  -v "$BASE/netcheck.mjs:/app/tests/relay-isolated/netcheck.mjs:ro"
  -v "$RUN/credentials.json:/run/credentials.json:ro"
  -v "$RUN/manifest.json:/run/manifest.json:ro")
PHASE=containers
RELAY=$(podman create --pull=never --name "$PREFIX-relay" --network "$NET_A" --network "$NET_B" "${MOUNT[@]}" "$IMAGE" node tests/relay-isolated/relay-runner.mjs)
CONTAINERS+=("$RELAY")
podman start "$RELAY"
HOST=$(podman create --pull=never --name "$PREFIX-host" --network "$NET_A" "${MOUNT[@]}" -v "$RUN/source.h264:/fixture/source.h264:ro" "$IMAGE" sleep 240)
CONTAINERS+=("$HOST")
podman start "$HOST"
CLIENT=$(podman create --pull=never --name "$PREFIX-client" --network "$NET_B" "${MOUNT[@]}" -v "$RUN/received:/output:rw" "$IMAGE" sleep 240)
CONTAINERS+=("$CLIENT")
podman start "$CLIENT"
ip() { podman inspect "$1" --format "{{(index .NetworkSettings.Networks \"$2\").IPAddress}}"; }
RELAY_A=$(ip "$RELAY" "$NET_A"); RELAY_B=$(ip "$RELAY" "$NET_B")
IP_A=$(ip "$HOST" "$NET_A"); IP_B=$(ip "$CLIENT" "$NET_B")
printf '{"host":"%s","client":"%s","relayA":"%s","relayB":"%s"}\n' "$IP_A" "$IP_B" "$RELAY_A" "$RELAY_B" >"$RUN/topology.json"
wait_file() {
  for ((i=0;i<40;i++)); do
    if podman exec "$1" test -f "$2"; then return 0; fi
    sleep .25
  done
  return 1
}
wait_file "$RELAY" /tmp/turn-stats.json
PHASE=isolation
for role in host client relay; do
  case "$role" in host) ctr=$HOST;; client) ctr=$CLIENT;; relay) ctr=$RELAY;; esac
  podman exec "$ctr" node tests/relay-isolated/netcheck.mjs routes >"$RUN/$role-routes.json"
  podman exec -d "$ctr" node tests/relay-isolated/netcheck.mjs listen 9999
  wait_file "$ctr" /tmp/udp-9999.ready
done
probe() {
  local expected="$1" label="$2" ctr="$3" address="$4" status=0
  podman exec "$ctr" node tests/relay-isolated/netcheck.mjs probe "$address" 9999 2000 >"$RUN/$label.json" || status=$?
  [[ $status == "$expected" ]]
}
# Verify each destination listener from the dual-homed relay, in addition to
# peer->relay controls. Recheck controls after negative probes.
probe 0 host-relay "$HOST" "$RELAY_A"
probe 0 client-relay "$CLIENT" "$RELAY_B"
probe 0 relay-host "$RELAY" "$IP_A"
probe 0 relay-client "$RELAY" "$IP_B"
probe 1 host-client-blocked "$HOST" "$IP_B"
probe 1 client-host-blocked "$CLIENT" "$IP_A"
probe 0 host-relay-after "$HOST" "$RELAY_A"
probe 0 client-relay-after "$CLIENT" "$RELAY_B"
printf '{"hostRelay":true,"clientRelay":true,"relayHost":true,"relayClient":true,"hostClientBlocked":true,"clientHostBlocked":true,"hostRelayAfter":true,"clientRelayAfter":true}\n' >"$RUN/isolation.json"
PHASE=media
podman exec "$HOST" node tests/relay-isolated/peer-runner.mjs host "ws://$RELAY_A:8787" "$RELAY_A" >"$RUN/host.log" 2>&1 &
HPID=$!; PIDS+=("$HPID")
sleep 1
podman exec "$CLIENT" node tests/relay-isolated/peer-runner.mjs client "ws://$RELAY_B:8787" "$RELAY_B" >"$RUN/client.log" 2>&1 &
CPID=$!; PIDS+=("$CPID")
host_status=0; client_status=0
wait "$HPID" || host_status=$?
wait "$CPID" || client_status=$?
PIDS=()
sleep 2
podman logs "$RELAY" >"$RUN/relay.log" 2>&1
podman exec "$RELAY" cat /tmp/turn-stats.json >"$RUN/turn-stats.json"
[[ $host_status == 0 && $client_status == 0 ]]
PHASE=host-verification
python3 "$BASE/media-proof.py" verify "$RUN" >"$RUN/verification.log" 2>&1
PHASE=complete
