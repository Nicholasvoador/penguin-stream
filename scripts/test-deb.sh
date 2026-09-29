#!/usr/bin/env bash
# Install-tests every built .deb in a fresh container of its own distro.
#   scripts/test-deb.sh              (all dist/*.deb for the current version)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
declare -A IMAGES=(
  [ubuntu24.04]=docker.io/library/ubuntu:24.04
  [ubuntu26.04]=docker.io/library/ubuntu:26.04
  [debian13]=docker.io/library/debian:13
)
status=0
for deb in "$ROOT"/dist/penguin-stream_"$VERSION".*_amd64.deb; do
  name=$(basename "$deb"); distro=${name#penguin-stream_"$VERSION".}; distro=${distro%_amd64.deb}
  img=${IMAGES[$distro]:?no image for $distro}
  echo "===== $name on $img"
  podman run --rm -v "$ROOT/dist:/debs:ro,Z" -v "$ROOT/packaging/debian/test-install.sh:/t.sh:ro,Z" \
    "$img" bash /t.sh "/debs/$name" || status=1
done
exit $status
