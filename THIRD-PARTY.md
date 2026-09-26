# Third-party software

Penguin Stream's own code is MIT-licensed (see [LICENSE](LICENSE)). The apps also ship with the components below, each under
its own license. The Windows installers include copies in `resources/bin/licenses/`.

| Component | Used for | License | Shipped in |
|---|---|---|---|
| [FFmpeg](https://ffmpeg.org) (`libavcodec`, `libavutil`, `libswscale`, `libswresample`) | Video encoding/decoding and scaling | GPL v3 build (BtbN win64-gpl-shared) on Windows; the distribution's build on Fedora | Windows: DLLs · Fedora: system package |
| [SDL2](https://libsdl.org) | Stream window, input, controllers, audio playback | zlib | Windows: DLL · Fedora: system package |
| [ViGEmClient](https://github.com/nefarius/ViGEmClient) | Virtual Xbox controllers on a Windows host (needs the ViGEmBus driver) | MIT | Compiled into `ps-media.exe` |
| [Electron](https://www.electronjs.org) | Desktop app shell | MIT (Chromium: BSD-style + others, see `LICENSES.chromium.html` in the app folder) | Both |
| [node-datachannel](https://github.com/murat-dogan/node-datachannel) / [libdatachannel](https://github.com/paullouisageneau/libdatachannel) | WebRTC transport (ICE, DTLS, SCTP) | MPL 2.0 | Both |
| [ws](https://github.com/websockets/ws) | Local UI and rendezvous WebSockets | MIT | Both |
| [@noble/secp256k1](https://github.com/paulmillr/noble-secp256k1) | Nostr signaling signatures | MIT | Both |
| [Hack](https://sourcefoundry.org/hack/) font, bold (glyphs 32–126 baked into `media/src/render/overlay_font.h` by `scripts/gen-overlay-font.py`) | Text in the stream-window overlay | MIT + Bitstream Vera License | Compiled into `ps-media` |
| PipeWire, GLib, libX11 | Wayland/X11 capture and audio on Linux | LGPL / MIT-style | Fedora: system packages |

FFmpeg's GPL build means the Windows `ps-media.exe` as a whole is distributed under the GPL v3 terms. Its complete source is
this repository plus the exact upstream archives listed in `resources/bin/licenses/SOURCES.txt`.

The project does not include Sunshine or Moonlight code.
