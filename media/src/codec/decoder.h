// H.264 decoder producing BGRA frames for the SDL renderer.
//
// Software decoding by default: desktop streams are typically 1080p60, which
// any modern CPU handles, and it avoids the hardware-surface download that
// often costs more than it saves at this resolution.
#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

struct AVCodecContext;
struct AVFrame;
struct AVPacket;
struct SwsContext;

namespace ps {

struct DecodedFrame {
  int width;
  int height;
  uint64_t pts_us;
  const uint8_t* bgra;     // null when the frame is delivered as planar YUV
  int stride;
  // Planar 4:2:0 output (setYuvOutput(true)): lets the renderer upload YUV and
  // convert on the GPU instead of spending CPU on a BGRA conversion per frame.
  const uint8_t* planes[3];
  int linesize[3];
};

class Decoder {
 public:
  Decoder();
  ~Decoder();
  void close();
  Decoder(const Decoder&) = delete;
  Decoder& operator=(const Decoder&) = delete;

  bool open(const std::vector<uint8_t>& extradata, std::string& error);

  // Decodes one access unit. Frames are handed to `sink`; the pixel pointer is
  // valid only for the duration of the callback.
  bool decode(const uint8_t* data, size_t size, uint64_t pts_us,
              const std::function<void(const DecodedFrame&)>& sink,
              std::string& error);

  void flush(const std::function<void(const DecodedFrame&)>& sink);

  // Deliver 8-bit 4:2:0 frames as planes when the decoder produces them.
  void setYuvOutput(bool yuv) { yuvOutput_ = yuv; }

  uint64_t framesDecoded() const { return framesDecoded_; }
  uint64_t decodeErrors() const { return decodeErrors_; }

 private:
  bool drain(const std::function<void(const DecodedFrame&)>& sink, std::string& error);
  void ensureScaler(int w, int h, int srcFormat);

  AVCodecContext* ctx_ = nullptr;
  AVFrame* frame_ = nullptr;
  AVPacket* pkt_ = nullptr;
  SwsContext* sws_ = nullptr;
  std::vector<uint8_t> bgra_;
  std::vector<uint8_t> padded_;
  int scalerW_ = 0, scalerH_ = 0, scalerFmt_ = -1;
  bool yuvOutput_ = false;
  uint64_t framesDecoded_ = 0;
  uint64_t decodeErrors_ = 0;
};

}  // namespace ps
