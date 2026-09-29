#!/usr/bin/env bash
# Install-test a .deb in a FRESH container of its distro (no build tools):
#   apt install ./pkg.deb must pull every dependency; then the installed app
#   must actually work: all libraries resolve, the engine's selftest passes,
#   and the bundled Node side (native WebRTC module, crypto) loads under the
#   installed Electron runtime.
# usage (inside container): test-install.sh /debs/<file>.deb
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
DEB=$1
apt-get update -qq
apt-get install -y -qq "$DEB" >/tmp/apt.log 2>&1 || { tail -25 /tmp/apt.log; echo "FAIL: apt install"; exit 1; }
echo "PASS apt install ($(dpkg-query -W -f='${Version}' penguin-stream))"

fail=0
for bin in /opt/penguin-stream/resources/bin/ps-media /opt/penguin-stream/penguin-stream; do
  missing=$(ldd "$bin" 2>&1 | grep "not found" || true)
  if [ -n "$missing" ]; then echo "FAIL ldd $bin:"; echo "$missing"; fail=1; else echo "PASS all libraries resolve: $bin"; fi
done

out=$(/opt/penguin-stream/resources/bin/ps-media selftest --frames 60 --encoder x264)
echo "$out" | grep -q '"ok":true' && echo "PASS engine selftest (x264): $out" || { echo "FAIL selftest: $out"; fail=1; }

# Encoders/capture the engine reports on this distro's FFmpeg.
/opt/penguin-stream/resources/bin/ps-media probe 2>/dev/null | head -c 400; echo

# Node side under the INSTALLED Electron (its own Node + BoringSSL):
# native node-datachannel prebuild + AES-GCM signalling crypto.
cat > /tmp/nodecheck.cjs <<'EOF'
const path = require('path');
const app = '/opt/penguin-stream/resources/app.asar';
(async () => {
  const ndc = require(path.join(app, 'node_modules/node-datachannel'));
  const pc = new ndc.PeerConnection('t', { iceServers: [] });
  const dc = pc.createDataChannel('probe'); dc.close(); pc.close(); ndc.cleanup();
  const code = await import(path.join(app, 'node/src/signal/code.mjs'));
  console.log('node', process.versions.node, 'electron', process.versions.electron,
              'node-datachannel ok, signal exports:', Object.keys(code).length);
})().catch((e) => { console.error('NODECHECK FAIL', e); process.exit(1); });
EOF
if ELECTRON_RUN_AS_NODE=1 /opt/penguin-stream/penguin-stream /tmp/nodecheck.cjs; then echo "PASS Electron runtime + native WebRTC module"; else echo "FAIL Electron runtime check"; fail=1; fi

test -f /usr/share/applications/penguin-stream.desktop && test -L /usr/bin/penguin-stream && echo "PASS desktop entry + launcher" || { echo "FAIL desktop entry"; fail=1; }
stat -c '%a' /opt/penguin-stream/chrome-sandbox | grep -q 4755 && echo "PASS chrome-sandbox setuid" || { echo "FAIL chrome-sandbox perms"; fail=1; }

apt-get remove -y -qq penguin-stream >/dev/null 2>&1 && [ ! -e /opt/penguin-stream/penguin-stream ] && echo "PASS clean uninstall" || { echo "FAIL uninstall"; fail=1; }
[ $fail = 0 ] && echo "ALL PASS" || { echo "SOME CHECKS FAILED"; exit 1; }
