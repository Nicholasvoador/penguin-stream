# Dependencies and distribution limits

The MIT license applies to this project's original code, not third-party software.
This prototype does not embed Sunshine or Moonlight source. Its architecture uses
FFmpeg and platform capture APIs plus node-datachannel/libdatachannel and ws.

`npm ci` installs pinned dependency versions from package-lock.json, with their
respective licenses and transitive dependencies. Node dependencies are not bundled.
The included local Linux `ps-media` executable is dynamically linked to the local
FFmpeg, SDL2, PipeWire, GLib and system libraries; inspect with `ldd` before use.
Matching shared libraries must be separately installed. FFmpeg licensing depends
on build configuration and enabled codecs (LGPL/GPL and possibly nonredistributable
combinations). Review the exact FFmpeg build and all corresponding obligations
before external binary distribution. This archive is a local development artifact,
not a reviewed redistributable release or a Windows installer.

Rebuild from included source with CMake for other machines. No captured media,
identity files, credentials, node_modules, Git history or test logs are included.
