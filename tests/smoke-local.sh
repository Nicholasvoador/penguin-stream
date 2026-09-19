#!/usr/bin/env bash
#
# Local end-to-end smoke test using the real CLI commands a user would type.
#
# Runs a rendezvous server, a host sharing the SYNTHETIC source (never the real
# desktop), and a viewer, then checks that frames actually arrived and that
# both sides derived the same verification words.
#
# The viewer uses SDL's dummy video driver so this runs without a display.
#
# Usage: ./tests/smoke-local.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
ARTIFACTS="$REPO_ROOT/artifacts"
mkdir -p "$ARTIFACTS"

RV_LOG="$ARTIFACTS/smoke-rendezvous.log"
HOST_LOG="$ARTIFACTS/smoke-host.log"
CLIENT_LOG="$ARTIFACTS/smoke-client.log"
PORT=${PORT:-8791}

FAILED=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null
  done
  wait 2>/dev/null
}
trap cleanup EXIT

step "Starting rendezvous on port $PORT"
node node/src/cli.mjs rendezvous --port "$PORT" >"$RV_LOG" 2>&1 &
PIDS+=($!)
sleep 2
if grep -q "listening" "$RV_LOG"; then
  pass "rendezvous up"
else
  fail "rendezvous did not start"; cat "$RV_LOG"; exit 1
fi

step "Starting host (synthetic source - never the real desktop)"
node node/src/cli.mjs host \
  --rendezvous "ws://127.0.0.1:$PORT" \
  --source synthetic --fps 30 --bitrate 3000 --yes \
  >"$HOST_LOG" 2>&1 &
HOST_PID=$!
PIDS+=("$HOST_PID")

CODE=""
for _ in $(seq 1 30); do
  CODE=$(grep -oE 'Share code:[[:space:]]+[A-Z0-9]{4}-[A-Z0-9]{4}' "$HOST_LOG" 2>/dev/null | head -1 | grep -oE '[A-Z0-9]{4}-[A-Z0-9]{4}')
  [[ -n "$CODE" ]] && break
  sleep 0.5
done

if [[ -n "$CODE" ]]; then
  pass "host published share code $CODE"
else
  fail "host never printed a share code"; tail -20 "$HOST_LOG"; exit 1
fi

step "Connecting viewer"
SDL_VIDEODRIVER=dummy timeout 30 node node/src/cli.mjs connect "$CODE" \
  --rendezvous "ws://127.0.0.1:$PORT" >"$CLIENT_LOG" 2>&1
sleep 1

step "Results"
grep -qE "connected" "$CLIENT_LOG" && pass "viewer reported a secure connection" \
  || fail "viewer never connected"

HOST_SAS=$(grep -oE 'Verification words:[[:space:]]+[a-z ]+' "$HOST_LOG" | head -1 | sed 's/.*words:[[:space:]]*//' | xargs)
CLIENT_SAS=$(grep -oE 'Verification words:[[:space:]]+[a-z ]+' "$CLIENT_LOG" | head -1 | sed 's/.*words:[[:space:]]*//' | xargs)

if [[ -n "$HOST_SAS" && "$HOST_SAS" == "$CLIENT_SAS" ]]; then
  pass "verification words matched on both sides: \"$HOST_SAS\""
else
  fail "verification words differ (host='$HOST_SAS' client='$CLIENT_SAS')"
fi

grep -qE "stream: [0-9]+x[0-9]+ h264" "$CLIENT_LOG" && pass "viewer negotiated an H.264 stream" \
  || fail "viewer never received stream config"

FRAMES=$(grep -oE 'session summary: [0-9]+ frames decoded' "$CLIENT_LOG" | tail -1 | grep -oE '[0-9]+' | head -1)
[[ -z "$FRAMES" ]] && FRAMES=$(grep -oE '[0-9]+ frames,' "$CLIENT_LOG" | tail -1 | grep -oE '[0-9]+')
if [[ -n "$FRAMES" && "$FRAMES" -gt 10 ]]; then
  pass "viewer decoded $FRAMES frames"
else
  fail "viewer decoded too few frames (${FRAMES:-0})"
fi

grep -qE "streaming: .* frames sent" "$HOST_LOG" && pass "host reported streaming stats" \
  || printf '  ---- host stats line not present (short run)\n'

step "Summary"
if [[ $FAILED -eq 0 ]]; then
  printf '  \033[32mSMOKE TEST PASSED\033[0m\n'
else
  printf '  \033[31mSMOKE TEST FAILED\033[0m - see %s\n' "$ARTIFACTS"
fi
printf '  logs: %s\n' "$ARTIFACTS/smoke-*.log"
exit $FAILED
