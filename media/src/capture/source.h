// Screen capture source abstraction.
//
// Every backend produces tightly-packed BGRA frames, which is what both the
// encoder and the SDL renderer want, and what X11, PipeWire and DXGI can all
// deliver without an extra conversion in the common case.
#pragma once

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
};

struct CaptureOptions {
  int width = 0;          // 0 = native
  int height = 0;
  int fps = 60;
  std::string display;    // X11 display / portal restore token / monitor index
};

class CaptureSource {
 public:
  virtual ~CaptureSource() = default;

  virtual bool start(const CaptureOptions& opts, std::string& error) = 0;
  virtual void stop() = 0;

  // Blocks until the next frame is ready.
  // Returns false on end-of-stream or unrecoverable error (error set).
  virtual bool nextFrame(CaptureFrame& frame, std::string& error) = 0;

  virtual int width() const = 0;
  virtual int height() const = 0;
  virtual const char* name() const = 0;
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
#endif

// Picks the best available backend for the current session.
// `forced` may be "synthetic", "x11", "portal", "dxgi", or empty for auto.
std::unique_ptr<CaptureSource> makeCaptureSource(const std::string& forced, std::string& chosen);

}  // namespace ps
