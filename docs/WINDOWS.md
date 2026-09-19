# Windows media backend

## Verification status

The DXGI backend is implemented, but **has not been compiled or run on Windows**.
A Linux build does not compile `windows_dxgi.cpp` and cannot validate D3D11,
DXGI, Windows dependency discovery, or Windows runtime behavior. Windows build
and hardware smoke tests below remain required; do not treat this as a verified
Windows release.

## Build prerequisites

- Windows 8 or later with an interactive desktop and a Desktop Duplication
  capable GPU/driver; a current Windows SDK and MSVC C++ toolchain.
- CMake 3.20 or newer.
- An existing vcpkg toolchain with FFmpeg installed for the selected triplet.
  CMake uses `find_package(FFMPEG REQUIRED)` and consumes vcpkg's
  `FFMPEG_INCLUDE_DIRS`, `FFMPEG_LIBRARY_DIRS`, and `FFMPEG_LIBRARIES`. Missing
  FFmpeg must fail configuration. Use a build with an H.264 encoder (for example
  libx264 or OpenH264) as well as a decoder for the software self-test.
- Optional SDL2 from the same triplet. Windows uses `find_package(SDL2 CONFIG)`
  and `SDL2::SDL2` (or `SDL2::SDL2-static`); it does not require pkg-config.
  Without SDL2, capture/probe/selftest remain available but view does not.
- Dynamic dependency DLLs must be available beside the executable or on PATH.
  vcpkg app-local deployment depends on the toolchain configuration.

Example PowerShell commands, with dependencies/toolchain already provisioned
and `VCPKG_ROOT` set (these commands have not been executed here):

```powershell
cmake -S media -B media/build/windows -A x64 `
  "-DCMAKE_TOOLCHAIN_FILE=$env:VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" `
  -DVCPKG_TARGET_TRIPLET=x64-windows
cmake --build media/build/windows --config Release
.\media\build\windows\Release\ps-media.exe probe
.\media\build\windows\Release\ps-media.exe selftest --encoder software --frames 30
```

The executable location above assumes a Visual Studio multi-configuration
generator. MSVC receives `/W4 /permissive- /EHsc`; other compilers retain the
GNU-style warning flags. Both platforms link `Threads::Threads`. Linux keeps
pkg-config discovery for FFmpeg, SDL2, and optional capture dependencies.

## Capture behavior

- Auto-selection chooses DXGI on Windows; `--source dxgi` selects it explicitly.
- `--display N` is a zero-based index over attached outputs in DXGI adapter/output
  enumeration order. Empty means index 0, **not necessarily the primary monitor**.
  Invalid indices fail startup. A D3D11 device is created on the selected output's
  adapter rather than assuming adapter 0 owns it.
- Captures one native-size BGRA8 desktop. Odd right/bottom edges are cropped by at
  most one pixel for the encoder's even-dimension requirement. Width/height may
  be omitted or equal native/even-cropped dimensions; resizing is not implemented.
- Rotated outputs are explicitly rejected. Multi-monitor stitching, HDR fidelity,
  dirty-rectangle optimizations, and separate hardware cursor composition are not
  implemented. A separately supplied DXGI cursor may therefore be absent.
- Frames are copied through a CPU-readable staging texture into an owned,
  tightly packed BGRA vector. Dimensions, format, sample layout, RowPitch and
  row-offset/buffer-size arithmetic are checked before row copies. No mapped GPU
  pointer is returned. The returned pointer is valid only until the next
  `nextFrame()`, `stop()`, or destruction; consume it synchronously.
- COM objects, acquired duplication frames, and mapped textures have RAII cleanup.
  Map scopes unmap before releasing their acquired frame, including on failures.
- `fps=0` selects 60; supported positive values are 1..1000. Calls are paced using
  a steady clock, with monotonic microsecond timestamps starting at zero. Slow
  consumers do not trigger catch-up bursts.
- Initial acquisition waits at most 1000 ms. A first-frame timeout returns false
  with an explicit error; uninitialized/black placeholder data is never emitted.
- After one image exists, acquisition uses a zero timeout after pacing. An idle
  desktop timeout repeats the owned last image with a new timestamp, rather than
  ending the stream or busy-spinning.
- Access-lost, device-removed/reset, incompatible texture changes and other
  acquisition/map/release failures return false with a diagnostic and require
  `stop()`/`start()` (or restarting the capture process). There is no automatic
  recovery or mid-stream resolution renegotiation. Secure/locked desktops,
  session changes, unplugging a monitor and display-mode changes may interrupt
  duplication. Calling `nextFrame()` again after failure is rejected.
- Lifecycle methods are single-threaded; `stop()` is not a concurrent cancellation
  API. A first-frame wait can delay the caller for up to one second, and GPU map
  synchronization can add latency.

## Windows validation still required

1. Configure/build with MSVC and vcpkg; check missing FFmpeg fails configuration,
   SDL discovery does not invoke pkg-config, and runtime DLLs resolve.
2. Run `probe` (DXGI listed) and the software `selftest` (zero mismatches).
3. Run the following from **cmd.exe** to preserve binary stdout, then inspect the
   framed stream with the project's normal consumer:
   ```bat
   media\build\windows\Release\ps-media.exe capture --source dxgi --display 0 --fps 30 --max-frames 90 > capture.bin
   ```
4. Verify actual desktop colors/content, tightly packed output, monotonic timing,
   idle repeats, and display selection on multi-adapter hardware.
5. Exercise invalid indices/sizes, portrait displays, first-frame timeout,
   lock/unlock, monitor unplug, mode changes, and repeated start/stop. Confirm
   explicit errors and no leaked acquired frames, mappings, or COM objects.
6. Exercise the SDL viewer on Windows separately. End-to-end transport/input and
   other platform features are outside this backend's verification scope.
