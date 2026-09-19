// Synthetic capture source: a deterministic pattern with no display server.
//
// This exists so the encode -> transport -> decode pipeline can be tested for
// real (real H.264, real libavcodec) without capturing anyone's actual desktop
// and without requiring a session. The pattern is four flat colour quadrants
// that cycle per frame, plus a moving bar and a frame counter bar, so a test
// can assert that decoded pixels match what was fed in.

#include "capture/source.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <thread>

namespace ps {
namespace {

// Flat, saturated colours far apart in YUV space, so lossy H.264 at any sane
// bitrate still lands within tolerance.
constexpr Rgb kPalette[4][4] = {
  {{220, 40, 40}, {40, 200, 60}, {50, 70, 230}, {230, 200, 40}},
  {{40, 200, 60}, {50, 70, 230}, {230, 200, 40}, {220, 40, 40}},
  {{50, 70, 230}, {230, 200, 40}, {220, 40, 40}, {40, 200, 60}},
  {{230, 200, 40}, {220, 40, 40}, {40, 200, 60}, {50, 70, 230}},
};

class SyntheticSource : public CaptureSource {
 public:
  bool start(const CaptureOptions& opts, std::string& error) override {
    width_ = opts.width > 0 ? (opts.width & ~1) : 1280;
    height_ = opts.height > 0 ? (opts.height & ~1) : 720;
    fps_ = opts.fps > 0 ? opts.fps : 60;
    buffer_.assign(static_cast<size_t>(width_) * height_ * 4, 0);
    frameIndex_ = 0;
    startTime_ = std::chrono::steady_clock::now();
    (void)error;
    return true;
  }

  void stop() override { buffer_.clear(); }

  bool nextFrame(CaptureFrame& frame, std::string& error) override {
    (void)error;
    // Pace to the requested frame rate so downstream timing behaves like a
    // real capture rather than running as fast as the CPU allows.
    const auto target = startTime_ + std::chrono::microseconds(
        static_cast<int64_t>(frameIndex_) * 1000000 / fps_);
    std::this_thread::sleep_until(target);

    render();

    frame.bgra = buffer_.data();
    frame.stride = width_ * 4;
    frame.width = width_;
    frame.height = height_;
    frame.pts_us = static_cast<uint64_t>(frameIndex_) * 1000000ull / static_cast<uint64_t>(fps_);
    ++frameIndex_;
    return true;
  }

  int width() const override { return width_; }
  int height() const override { return height_; }
  const char* name() const override { return "synthetic"; }

 private:
  void render() {
    const int half_w = width_ / 2;
    const int half_h = height_ / 2;
    const int phase = static_cast<int>(frameIndex_ % 4);

    for (int y = 0; y < height_; ++y) {
      uint8_t* row = buffer_.data() + static_cast<size_t>(y) * width_ * 4;
      const int qy = (y < half_h) ? 0 : 1;
      for (int x = 0; x < width_; ++x) {
        const int qx = (x < half_w) ? 0 : 1;
        const Rgb c = kPalette[phase][qy * 2 + qx];
        row[x * 4 + 0] = c.b;
        row[x * 4 + 1] = c.g;
        row[x * 4 + 2] = c.r;
        row[x * 4 + 3] = 255;
      }
    }

    // Moving vertical bar: makes inter-frame motion non-trivial so the encoder
    // is actually doing motion estimation rather than emitting empty P-frames.
    const int barW = std::max(8, width_ / 40);
    const int barX = static_cast<int>((frameIndex_ * 7) % static_cast<uint64_t>(width_ - barW));
    for (int y = 0; y < height_; ++y) {
      uint8_t* row = buffer_.data() + static_cast<size_t>(y) * width_ * 4;
      for (int x = barX; x < barX + barW; ++x) {
        row[x * 4 + 0] = 255;
        row[x * 4 + 1] = 255;
        row[x * 4 + 2] = 255;
        row[x * 4 + 3] = 255;
      }
    }
  }

  std::vector<uint8_t> buffer_;
  int width_ = 1280;
  int height_ = 720;
  int fps_ = 60;
  uint64_t frameIndex_ = 0;
  std::chrono::steady_clock::time_point startTime_;
};

}  // namespace

std::unique_ptr<CaptureSource> makeSyntheticSource() {
  return std::make_unique<SyntheticSource>();
}

Rgb syntheticExpectedColor(int quadrant, int frameIndex) {
  return kPalette[frameIndex % 4][quadrant];
}

}  // namespace ps
