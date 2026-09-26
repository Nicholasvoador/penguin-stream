// Screen capture source abstraction.
//
// Every backend produces tightly-packed BGRA frames, which is what both the
// encoder and the SDL renderer want, and what X11, PipeWire and DXGI can all
// deliver without an extra conversion in the common case.
#pragma once

#include "input/event.h"

#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace ps {

struct CaptureFrame {
  const uint8_t* bgra = nullptr;
  int stride = 0;
  int width = 0;
  int height = 0;
  uint64_t pts_us = 0;
  // steady_clock microseconds when these pixels were grabbed (0 = unknown).
  // Lets the engine report how long capture + encode really took per frame.
  uint64_t captured_us = 0;
};

// A rectangle in desktop (logical) coordinates.
struct Rect {
  int x = 0, y = 0, w = 0, h = 0;
  bool valid() const { return w > 0 && h > 0; }
};

struct CaptureOptions {
  int width = 0;          // 0 = native (X11 grab size only; scaling happens in the encoder)
  int height = 0;
  int fps = 60;
  bool allowInput = false; // Keyboard/mouse opt-in; portal consent is still required.
  std::string display;    // X11 display / monitor index (Windows)
  // Wayland portal: the monitor the user picked in Penguin Stream, and the
  // bounding box of all monitors. If the compositor hands us the whole
  // workspace (KDE "Full workspace"), we crop to `monitor`.
  Rect monitor;
  Rect workspace;
  std::string restoreToken;  // portal: skip the picker when the choice was remembered
};

// Monotonic microseconds shared by every stage of the pipeline.
inline uint64_t steadyMicros() {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
}

class CaptureSource {
 public:
  virtual ~CaptureSource() = default;

  virtual bool start(const CaptureOptions& opts, std::string& error) = 0;
  virtual void stop() = 0;

  // Keyboard/mouse injection for the captured output. Called from the control
  // thread, concurrently with nextFrame(); implementations must be thread-safe.
  // Unsupported backends fail closed.
  virtual bool input(const InputEvent&) { return false; }
  // Whether keyboard/mouse injection is actually usable after start().
  virtual bool inputReady() const { return false; }

  // Blocks until the next frame is ready.
  // Returns false on end-of-stream or unrecoverable error (error set).
  virtual bool nextFrame(CaptureFrame& frame, std::string& error) = 0;

  virtual int width() const = 0;
  virtual int height() const = 0;
  virtual const char* name() const = 0;
  // Portal: token that lets the next share reuse this monitor choice silently.
  virtual std::string restoreToken() const { return {}; }
  // Human-readable note about what is being captured (e.g. cropping applied).
  virtual std::string captureNote() const { return {}; }
};

// Deterministic generated pattern. Requires no display server, which is what
// makes the encode/decode pipeline testable in CI and in a container.
std::unique_ptr<CaptureSource> makeSyntheticSource();

// Expected colour of the synthetic pattern at a given region and frame, so a
// test can verify that what came out of the decoder is what went in.
struct Rgb { uint8_t r, g, b; };
Rgb syntheticExpectedColor(int quadrant, int frameIndex);

#ifdef PS_HAVE_X11
std::unique_ptr<CaptureSource> makeX11Source();
#endif
#ifdef PS_HAVE_PIPEWIRE
std::unique_ptr<CaptureSource> makePortalPipeWireSource();
#endif
#ifdef PS_HAVE_DXGI
std::unique_ptr<CaptureSource> makeDxgiSource();
std::unique_ptr<CaptureSource> makeGdiSource();   // fallback when duplication is unavailable
// JSON array of the desktop's monitors (physical pixels, desktop coordinates).
std::string listWindowsMonitorsJson();
#endif

// Picks the best available backend for the current session.
// `forced` may be "synthetic", "x11", "portal", "dxgi", "gdi", or empty for auto.
std::unique_ptr<CaptureSource> makeCaptureSource(const std::string& forced, std::string& chosen);

}  // namespace ps
