# Packaging status

No installer is released or signed. Build/run from source is the supported development delivery. `cmake --install media/build --prefix <project-staging-directory>` stages ps-media; set `PS_MEDIA_BIN` to that executable when running the Node CLI outside its default build path. This must not target system directories without separate approval.

A complete offline bundle must include the Node runtime (or a documented compatible prerequisite), production `npm ci --omit=dev` dependencies including the platform/architecture-specific node-datachannel addon, `node/`, `turn/` (CLI imports it even when unused), and ps-media with its FFmpeg/SDL runtime libraries. Audio additionally requires FFmpeg/FFplay and Linux pactl. Do not copy Linux binaries/node_modules to Windows. Review FFmpeg codec configuration and linked-library licenses before redistribution; the package's MIT field does not supersede third-party licenses.

Windows: see WINDOWS.md for untested vcpkg/MSVC instructions. Packaging must include DLL resolution testing, code signing, uninstall behavior and installer permissions. Fedora: RPM/Flatpak integration and application portal identity/desktop entry remain future work. No firewall/service configuration, autostart, elevation, public deployment, or Sunshine configuration belongs in installation without explicit operator approval.

Release gates: real Windows↔Fedora desktop/video/audio/input tests, permission cancellation/revocation and lock/unlock, malicious media/control tests, reviewed cryptography, maintained coturn deployment and public CGNAT measurement, clean-machine install/uninstall, license inventory, reproducible checksums/signatures. None is implied by a successful local source build.

## Local allowlisted archive

Run `python3 scripts/package.py`. The deterministic uncompressed TAR includes
original source, documentation/tests, package lock and the local Linux engine
(if built), plus a per-file SHA-256 manifest. Dependencies/shared libraries are
not bundled; this is not a signed or self-contained installer. The script excludes
artifacts, captured media, node_modules, credentials and Git history by allowlist.
Review THIRD-PARTY.md before any distribution. No archive is uploaded automatically.
