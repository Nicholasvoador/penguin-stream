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
  const uint8_t* bgra;
  int stride;
};

class Decoder {
 public:
  Decoder();
  ~Decoder();
  Decoder(const Decoder&) = delete;
  Decoder& operator=(const Decoder&) = delete;

  bool open(const std::vector<uint8_t>& extradata, std::string& error);

  // Decodes one access unit. Frames are handed to `sink`; the pixel pointer is
  // valid only for the duration of the callback.
  bool decode(const uint8_t* data, size_t size, uint64_t pts_us,
              const std::function<void(const DecodedFrame&)>& sink,
              std::string& error);

  void flush(const std::function<void(const DecodedFrame&)>& sink);

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
  int scalerW_ = 0, scalerH_ = 0, scalerFmt_ = -1;
  uint64_t framesDecoded_ = 0;
  uint64_t decodeErrors_ = 0;
};

}  // namespace ps
