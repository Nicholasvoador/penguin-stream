#!/usr/bin/env bash
# Builds ps-media and a .deb INSIDE a Debian-family container, against that
# distro's own FFmpeg / PipeWire / SDL (sonames differ per release, so one
# binary cannot serve all). Called by scripts/build-deb.sh; not for direct use.
#
# Mounted: /src (repo, read-only), /app (electron-builder linux-unpacked, ro),
#          /out (dist). Env: PS_VERSION, PS_SUFFIX (e.g. ubuntu24.04).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  build-essential cmake ninja-build pkg-config dpkg-dev file \
  libavcodec-dev libavformat-dev libavutil-dev libswscale-dev libavdevice-dev \
  libpipewire-0.3-dev libglib2.0-dev libsdl2-dev libx11-dev >/tmp/apt.log 2>&1 || { tail -30 /tmp/apt.log; exit 1; }
# Electron's runtime libraries, only so dpkg-shlibdeps can map every soname
# the app needs to this release's real package names. Since the 64-bit time_t
# transition several are renamed with a t64 suffix (Ubuntu 24.04+, Debian 13:
# libasound2t64, libgtk-3-0t64...), and apt will NOT pick a provider for the
# old name when it is a pure virtual package. Take the t64 name when this
# release has it, else the classic one.
pick() {
  local out=() n
  for n in "$@"; do
    if apt-cache show "${n}t64" >/dev/null 2>&1; then out+=("${n}t64"); else out+=("$n"); fi
  done
  printf '%s ' "${out[@]}"
}
# shellcheck disable=SC2046
apt-get install -y -qq --no-install-recommends $(pick \
  libgtk-3-0 libnss3 libnspr4 libasound2 libgbm1 libxkbcommon0 libcups2 libatk1.0-0 \
  libatk-bridge2.0-0 libatspi2.0-0 libdrm2 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 \
  libpango-1.0-0 libcairo2 libexpat1 libudev1 libdbus-1-3 libxcb1) >>/tmp/apt.log 2>&1 \
  || { tail -30 /tmp/apt.log; exit 1; }

cmake -S /src/media -B /tmp/engine -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/engine 2>&1 | tail -5; test -x /tmp/engine/ps-media
/tmp/engine/ps-media selftest --frames 30 --encoder x264 | tee /tmp/selftest.json
grep -q '"ok":true' /tmp/selftest.json

PKG=/tmp/pkg
ROOTDIR=$PKG/root
rm -rf "$PKG"; mkdir -p "$ROOTDIR/DEBIAN" "$ROOTDIR/opt/penguin-stream" "$ROOTDIR/usr/bin" \
  "$ROOTDIR/usr/share/applications" "$ROOTDIR/usr/share/icons/hicolor/512x512/apps" \
  "$ROOTDIR/usr/share/doc/penguin-stream"
cp -a /app/. "$ROOTDIR/opt/penguin-stream/"
# The app ships the engine built for THIS distro, not the Fedora one.
install -m755 /tmp/engine/ps-media "$ROOTDIR/opt/penguin-stream/resources/bin/ps-media"
strip "$ROOTDIR/opt/penguin-stream/resources/bin/ps-media"
chmod 4755 "$ROOTDIR/opt/penguin-stream/chrome-sandbox"
ln -s /opt/penguin-stream/penguin-stream "$ROOTDIR/usr/bin/penguin-stream"
install -m644 /src/desktop/build/icon.png "$ROOTDIR/usr/share/icons/hicolor/512x512/apps/penguin-stream.png"
install -m644 /src/packaging/linux/penguin-stream.desktop "$ROOTDIR/usr/share/applications/penguin-stream.desktop"
install -m644 /src/LICENSE "$ROOTDIR/usr/share/doc/penguin-stream/copyright"

# Library dependencies come from the real binaries (engine + Electron), the
# same way rpmbuild's automatic Requires work on Fedora. Electron's bundled
# libffmpeg/libEGL/etc. live inside /opt and are excluded.
mkdir -p "$PKG/debian"
printf 'Source: penguin-stream\n\nPackage: penguin-stream\nArchitecture: amd64\n' > "$PKG/debian/control"
# libffmpeg.so is Electron's private copy in /opt (found via -l, no package).
( cd "$PKG" && dpkg-shlibdeps -O -l"$ROOTDIR/opt/penguin-stream" --ignore-missing-info \
    "$ROOTDIR/opt/penguin-stream/resources/bin/ps-media" \
    "$ROOTDIR/opt/penguin-stream/penguin-stream" 2>"$PKG/shlibdeps.err" ) \
  | sed -n 's/^shlibs:Depends=//p' > "$PKG/depends" \
  || { grep -i error "$PKG/shlibdeps.err"; exit 1; }
DEPS=$(cat "$PKG/depends")
[ -n "$DEPS" ] || { echo "dpkg-shlibdeps produced no dependencies" >&2; exit 1; }

SIZE=$(du -sk "$ROOTDIR" | cut -f1)
cat > "$ROOTDIR/DEBIAN/control" <<EOF
Package: penguin-stream
Version: ${PS_VERSION}~${PS_SUFFIX}
Architecture: amd64
Maintainer: Penguin Stream contributors <noreply@github.com>
Installed-Size: ${SIZE}
Depends: ${DEPS}, xdg-desktop-portal
Recommends: xdg-desktop-portal-gnome | xdg-desktop-portal-kde, pipewire
Section: net
Priority: optional
Homepage: https://github.com/Nicholasvoador/penguin-stream
Description: Low-latency remote desktop that works behind CGNAT
 Penguin Stream shares a desktop between Windows and Linux with hardware
 H.264, direct peer-to-peer UDP (also behind CGNAT) with optional relay
 fallback, end-to-end encryption and keyboard, mouse and controller input
 that each side can switch on and off live.
EOF
# Refresh desktop/icon caches when the tools exist; never fail the install.
cat > "$ROOTDIR/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t /usr/share/icons/hicolor || true
exit 0
EOF
cp "$ROOTDIR/DEBIAN/postinst" "$ROOTDIR/DEBIAN/postrm"
chmod 755 "$ROOTDIR/DEBIAN/postinst" "$ROOTDIR/DEBIAN/postrm"

OUT="/out/penguin-stream_${PS_VERSION}~${PS_SUFFIX}_amd64.deb"
dpkg-deb --root-owner-group -Zxz --build "$ROOTDIR" "$OUT" >/dev/null
echo "built $OUT"
echo "Depends: $DEPS"
