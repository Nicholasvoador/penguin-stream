#!/usr/bin/env bash
# Builds Ubuntu/Debian packages, one per release (each links that release's
# own FFmpeg/PipeWire/SDL; their sonames differ, so one binary can't serve all):
#
#   scripts/build-deb.sh            -> dist/penguin-stream_<v>.<distro>_amd64.deb
#   scripts/build-deb.sh ubuntu24.04
#
# Needs podman and dist/linux-unpacked (from: scripts/build-desktop.sh linux).
# Nothing is installed on the host.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
test -x "$ROOT/dist/linux-unpacked/penguin-stream" || {
  echo "dist/linux-unpacked missing: run scripts/build-desktop.sh linux first" >&2; exit 1; }

declare -A IMAGES=(
  [ubuntu24.04]=docker.io/library/ubuntu:24.04
  [ubuntu26.04]=docker.io/library/ubuntu:26.04
  [debian13]=docker.io/library/debian:13
)
TARGETS=("${@:-ubuntu24.04 ubuntu26.04 debian13}")
[ $# -eq 0 ] && TARGETS=(ubuntu24.04 ubuntu26.04 debian13)

for t in "${TARGETS[@]}"; do
  img="${IMAGES[$t]:?unknown target $t (known: ${!IMAGES[*]})}"
  echo "== $t ($img)"
  podman run --rm -e PS_VERSION="$VERSION" -e PS_SUFFIX="$t" \
    -v "$ROOT:/src:ro,Z" -v "$ROOT/dist/linux-unpacked:/app:ro,Z" -v "$ROOT/dist:/out:Z" \
    "$img" bash /src/packaging/debian/build-in-container.sh
done
ls -la "$ROOT"/dist/penguin-stream_"$VERSION".*_amd64.deb
