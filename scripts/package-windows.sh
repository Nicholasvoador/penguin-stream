#!/usr/bin/env bash
# Builds the portable Windows x64 release zip on Linux, reproducibly:
#   dist/penguin-stream-<version>-windows-x64.zip (+ .sha256)
#
# Needs: podman (rootless is fine), node/npm, curl, python3, sha256sum.
# All third-party inputs are pinned and checksum-verified. ps-media.exe is
# cross-compiled with Fedora's MinGW toolchain inside a container, so nothing
# is installed on the host.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="${PS_BUILD_CACHE:-$HOME/.cache/penguin-build}"
VERSION="$(node -p "require('$ROOT/package.json').version")"
NAME="penguin-stream-$VERSION-windows-x64"
STAGE="$ROOT/dist/$NAME"

NODE_VERSION=v24.21.0
NODE_ZIP="node-$NODE_VERSION-win-x64.zip"
NODE_SHA=158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541
FFMPEG_ZIP=ffmpeg-n8.1.3-win64-gpl-shared-8.1.zip
FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-24-14-14/$FFMPEG_ZIP"
FFMPEG_SHA=ef8310a639c2577d9f1a04c0b112c3659d3f3547a2582d5f519b5cd0c8487dcf
SDL_TGZ=SDL2-devel-2.32.10-mingw.tar.gz
SDL_URL="https://github.com/libsdl-org/SDL/releases/download/release-2.32.10/$SDL_TGZ"
SDL_SHA=83a5d74012311edc3c0d40ea6faecbe57ad692aa033fa5dc273cc937e3938ff2
IMAGE=penguin-mingw-f44

mkdir -p "$CACHE"
fetch() {  # url file sha256
  local url=$1 file=$2 sha=$3
  if [ ! -f "$CACHE/$file" ] || ! echo "$sha  $CACHE/$file" | sha256sum -c --quiet - 2>/dev/null; then
    echo "downloading $file"
    curl -fsSL -o "$CACHE/$file.part" "$url"
    mv "$CACHE/$file.part" "$CACHE/$file"
  fi
  echo "$sha  $CACHE/$file" | sha256sum -c --quiet -
}
fetch "https://nodejs.org/dist/$NODE_VERSION/$NODE_ZIP" "$NODE_ZIP" "$NODE_SHA"
fetch "$FFMPEG_URL" "$FFMPEG_ZIP" "$FFMPEG_SHA"
fetch "$SDL_URL" "$SDL_TGZ" "$SDL_SHA"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$CACHE/$FFMPEG_ZIP" "$WORK"
python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$CACHE/$NODE_ZIP" "$WORK"
tar -xzf "$CACHE/$SDL_TGZ" -C "$WORK"
FFMPEG_DIR="$(echo "$WORK"/ffmpeg-n8.1*)"
SDL_DIR="$WORK/SDL2-2.32.10/x86_64-w64-mingw32"
NODE_DIR="$WORK/node-$NODE_VERSION-win-x64"

# --- cross-compile ps-media.exe -------------------------------------------------
if ! podman image exists "$IMAGE"; then
  podman build -t "$IMAGE" -f - "$WORK" <<'EOF'
FROM registry.fedoraproject.org/fedora:44
RUN dnf -y install mingw64-gcc-c++ mingw64-winpthreads-static cmake ninja-build && dnf clean all
EOF
fi
mkdir -p "$WORK/out"
podman run --rm \
  -v "$ROOT/media:/src/media:ro,Z" -v "$FFMPEG_DIR:/ffmpeg:ro,Z" -v "$SDL_DIR:/sdl:ro,Z" -v "$WORK/out:/out:Z" \
  "$IMAGE" bash -euo pipefail -c '
    cmake -S /src/media -B /tmp/b -G Ninja \
      -DCMAKE_TOOLCHAIN_FILE=/usr/share/mingw/toolchain-mingw64.cmake -DCMAKE_BUILD_TYPE=Release \
      -DPS_FFMPEG_ROOT=/ffmpeg -DSDL2_DIR=/sdl/lib/cmake/SDL2 \
      -DCMAKE_FIND_ROOT_PATH="/usr/x86_64-w64-mingw32/sys-root/mingw;/sdl" >/tmp/configure.log 2>&1 \
      || { cat /tmp/configure.log; exit 1; }
    cmake --build /tmp/b 2>&1 | grep -E "error|warning" && exit 1 || true
    x86_64-w64-mingw32-strip -o /out/ps-media.exe /tmp/b/ps-media.exe'

# --- stage ------------------------------------------------------------------------
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/runtime" "$STAGE/licenses"
cp "$WORK/out/ps-media.exe" "$STAGE/bin/"
cp "$FFMPEG_DIR"/bin/{avcodec-62,avutil-60,swresample-6,swscale-9}.dll "$STAGE/bin/"
cp "$SDL_DIR/bin/SDL2.dll" "$STAGE/bin/"
cp "$NODE_DIR/node.exe" "$STAGE/runtime/"
cp "$NODE_DIR/LICENSE" "$STAGE/licenses/Node.js-LICENSE.txt"
cp "$FFMPEG_DIR/LICENSE.txt" "$STAGE/licenses/FFmpeg-LICENSE-GPLv3.txt"
cp "$WORK/SDL2-2.32.10/LICENSE.txt" "$STAGE/licenses/SDL2-LICENSE.txt"
cp "$ROOT/media/third_party/vigem/LICENSE" "$STAGE/licenses/ViGEmClient-LICENSE.txt"
cp "$ROOT/media/third_party/hack/LICENSE.md" "$STAGE/licenses/Hack-font-LICENSE.txt"
cp "$ROOT/LICENSE" "$STAGE/LICENSE.txt"
cp "$ROOT/THIRD-PARTY.md" "$STAGE/"
cp "$ROOT"/packaging/windows/* "$STAGE/"
mkdir -p "$STAGE/node" "$STAGE/turn"
cp -r "$ROOT/node/src" "$STAGE/node/src"
cp -r "$ROOT/turn/src" "$STAGE/turn/src"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/"
# Production dependencies with the official Windows x64 prebuilt of
# node-datachannel (no compiler needed on the user's PC).
(cd "$STAGE" && npm ci --omit=dev --os=win32 --cpu=x64 --ignore-scripts --no-audit --no-fund --loglevel=error)
test -f "$STAGE/node_modules/@node-datachannel/win32-x64-msvc/node_datachannel.node" \
  || { echo "missing node-datachannel win32 prebuild" >&2; exit 1; }
rm -rf "$STAGE/node_modules/@node-datachannel/linux-"* "$STAGE/node_modules/.package-lock.json"

cat > "$STAGE/licenses/SOURCES.txt" <<EOF
Penguin Stream $VERSION - MIT - https://github.com/Nicholasvoador/penguin-stream
bin/*.dll FFmpeg n8.1.3 (GPLv3 build incl. x264) - BtbN/FFmpeg-Builds $FFMPEG_ZIP
  sha256 $FFMPEG_SHA - source: https://github.com/FFmpeg/FFmpeg/tree/n8.1.3 and https://github.com/BtbN/FFmpeg-Builds
bin/SDL2.dll SDL 2.32.10 (zlib) - $SDL_URL
runtime/node.exe Node.js $NODE_VERSION (MIT) - https://nodejs.org/dist/$NODE_VERSION/
ps-media.exe embeds ViGEmClient (MIT) - https://github.com/nefarius/ViGEmClient
ps-media.exe embeds glyphs of the Hack font (MIT + Bitstream Vera License) - https://sourcefoundry.org/hack/
EOF
for f in "$STAGE/licenses/SOURCES.txt"; do sed -i 's/$/\r/' "$f"; done

# --- zip (deterministic order and timestamps) ---------------------------------------
OUT="$ROOT/dist/$NAME.zip"
python3 - "$STAGE" "$OUT" "$NAME" <<'EOF'
import os, sys, zipfile
stage, out, name = sys.argv[1:]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for dirpath, dirnames, filenames in os.walk(stage):
        dirnames.sort()
        for f in sorted(filenames):
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, stage).replace(os.sep, '/')
            info = zipfile.ZipInfo(f'{name}/{rel}', date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(full, 'rb') as fh:
                z.writestr(info, fh.read(), compresslevel=9)
EOF
(cd "$ROOT/dist" && sha256sum "$NAME.zip" > "$NAME.zip.sha256")
ls -la "$OUT"
cat "$OUT.sha256"
