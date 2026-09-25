#!/usr/bin/env bash
# Builds the desktop app installers.
#
#   scripts/build-desktop.sh linux   -> dist/penguin-stream-<v>.x86_64.rpm
#   scripts/build-desktop.sh win     -> dist/PenguinStream-<v>-Setup.exe, -Portable.exe
#
# Linux: uses media/build/ps-media (build it first with CMake).
# Windows: cross-compiles ps-media.exe via scripts/package-windows.sh (podman,
# MinGW, pinned + checksummed FFmpeg/SDL/Node inputs). Nothing is installed on
# the host.
set -euo pipefail

TARGET="${1:?usage: build-desktop.sh linux|win}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
STAGE="$ROOT/build/stage-$TARGET"

rm -rf "$STAGE"
mkdir -p "$STAGE/app" "$STAGE/bin"

# --- application files ---------------------------------------------------------
mkdir -p "$STAGE/app/node" "$STAGE/app/turn"
cp -r "$ROOT/desktop" "$STAGE/app/desktop"
rm -rf "$STAGE/app/desktop/build" "$STAGE/app/desktop/builder.config.cjs"
cp -r "$ROOT/node/src" "$STAGE/app/node/src"
cp -r "$ROOT/turn/src" "$STAGE/app/turn/src"
node -e '
  const p = require(process.argv[1]);
  const out = {
    name: p.name, productName: "Penguin Stream", version: p.version, description: p.description,
    author: { name: "Penguin Stream contributors", email: "noreply@github.com" },
    homepage: "https://github.com/Nicholasvoador/penguin-stream",
    license: p.license, type: "module", main: "desktop/main.mjs", dependencies: p.dependencies,
  };
  require("fs").writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
' "$ROOT/package.json" "$STAGE/app/package.json"
cp "$ROOT/package-lock.json" "$STAGE/app/"

OS=linux
[ "$TARGET" = win ] && OS=win32
(cd "$STAGE/app" && npm install --omit=dev --os="$OS" --cpu=x64 --ignore-scripts --no-audit --no-fund --loglevel=error)
NDC="$STAGE/app/node_modules/@node-datachannel"
if [ "$TARGET" = win ]; then
  test -f "$NDC/win32-x64-msvc/node_datachannel.node" || { echo "missing node-datachannel win32 prebuild" >&2; exit 1; }
  find "$NDC" -mindepth 1 -maxdepth 1 ! -name 'win32-x64-msvc' -exec rm -rf {} +
else
  test -f "$NDC/linux-x64-gnu/node_datachannel.node" || { echo "missing node-datachannel linux prebuild" >&2; exit 1; }
  find "$NDC" -mindepth 1 -maxdepth 1 ! -name 'linux-x64-gnu' -exec rm -rf {} +
fi
rm -f "$STAGE/app/package-lock.json" "$STAGE/app/node_modules/.package-lock.json"

# --- media engine ------------------------------------------------------------------
if [ "$TARGET" = win ]; then
  "$ROOT/scripts/package-windows.sh" >/dev/null
  WINSTAGE="$ROOT/dist/penguin-stream-$VERSION-windows-x64"
  cp "$WINSTAGE"/bin/* "$STAGE/bin/"
  mkdir -p "$STAGE/bin/licenses"
  cp "$WINSTAGE"/licenses/* "$STAGE/bin/licenses/"
  # The portable Node zip is an intermediate here, not a release artifact.
  rm -rf "$WINSTAGE" "$ROOT/dist/penguin-stream-$VERSION-windows-x64.zip"*
else
  test -x "$ROOT/media/build/ps-media" || { echo "build media/build/ps-media first (cmake)" >&2; exit 1; }
  install -m755 "$ROOT/media/build/ps-media" "$STAGE/bin/ps-media"
  strip "$STAGE/bin/ps-media" 2>/dev/null || true
fi

# --- package -------------------------------------------------------------------------
cd "$ROOT"
if [ "$TARGET" = win ]; then
  # NSIS runs the generated installer under Wine to extract its uninstaller;
  # use electron-builder's official Wine image rather than whatever the host has.
  mkdir -p "$HOME/.cache/electron" "$HOME/.cache/electron-builder"
  podman run --rm -e PS_TARGET=win -e ELECTRON_CACHE=/cache/electron -e ELECTRON_BUILDER_CACHE=/cache/electron-builder \
    -v "$ROOT:/project:Z" -v "$HOME/.cache/electron:/cache/electron:Z" -v "$HOME/.cache/electron-builder:/cache/electron-builder:Z" \
    -w /project docker.io/electronuserland/builder:wine \
    node node_modules/electron-builder/cli.js --win --x64 --config desktop/builder.config.cjs --publish never
else
  PS_TARGET=linux npx electron-builder --linux --x64 --config desktop/builder.config.cjs --publish never
  # Native RPM: rpmbuild computes library Requires from the actual binaries.
  TOP="$ROOT/build/rpm"
  rm -rf "$TOP"
  mkdir -p "$TOP"/{SOURCES,SPECS,BUILD,RPMS,SRPMS,BUILDROOT}
  cp -a "$ROOT/dist/linux-unpacked" "$TOP/SOURCES/linux-unpacked"
  cp "$ROOT/desktop/build/icon.png" "$TOP/SOURCES/icon.png"
  rpmbuild -bb --quiet --define "_topdir $TOP" --define "ps_version $VERSION" \
    "$ROOT/packaging/fedora/penguin-stream.spec"
  cp "$TOP"/RPMS/x86_64/penguin-stream-"$VERSION"-*.rpm "$ROOT/dist/"
fi
ls -la dist | grep -E "$VERSION" || true
