// H.264 encoder with hardware acceleration where available.
//
// Selection order is by measured preference, not by hope: VAAPI (Intel/AMD on
// Linux), NVENC (NVIDIA), then libx264 as a universal fallback. If a hardware
// encoder cannot be opened for any reason we fall back rather than fail, and
// report which one actually got used so the UI can tell the truth about it.
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

struct AVCodecContext;
struct AVFrame;
struct AVPacket;
struct AVBufferRef;
struct SwsContext;

namespace ps {

struct EncoderConfig {
  int width = 1920;
  int height = 1080;
  int fps = 60;
  int bitrateKbps = 15000;
  int gopSeconds = 4;          // keyframe interval; also the recovery interval
  std::string preferred;       // "auto", "vaapi", "nvenc", "x264"
};

struct EncodedPacket {
  uint64_t pts_us;
  bool keyframe;
  const uint8_t* data;
  size_t size;
};

class Encoder {
 public:
  Encoder();
  ~Encoder();
  Encoder(const Encoder&) = delete;
  Encoder& operator=(const Encoder&) = delete;

  // Returns false and fills `error` if no encoder at all could be opened.
  bool open(const EncoderConfig& cfg, std::string& error);

  // Feeds one BGRA frame (tightly packed rows of width*4 bytes).
  // Emitted packets are handed to `sink`; the pointer is only valid for the
  // duration of the call.
  bool encodeBGRA(const uint8_t* bgra, int stride, uint64_t pts_us,
                  const std::function<void(const EncodedPacket&)>& sink,
                  std::string& error);

  // Asks for a keyframe on the next encodeBGRA call. Used when a viewer joins
  // or reports corruption. Both requests are thread-safe: they are recorded
  // here and applied by the encoding thread on the next frame.
  void requestKeyframe() { forceKeyframe_ = true; }
  void setBitrate(int bitrateKbps) { pendingBitrateKbps_ = bitrateKbps; }

  // Flushes buffered frames at end of stream.
  void flush(const std::function<void(const EncodedPacket&)>& sink);

  const std::string& backendName() const { return backend_; }
  // SPS/PPS for decoders that need out-of-band config.
  const std::vector<uint8_t>& extradata() const { return extradata_; }
  int width() const { return cfg_.width; }
  int height() const { return cfg_.height; }

 private:
  bool tryOpen(const std::string& encoderName, const EncoderConfig& cfg, bool rgbInput, std::string& error);
  void close();
  bool drain(const std::function<void(const EncodedPacket&)>& sink, std::string& error);

  EncoderConfig cfg_;
  std::string backend_;
  AVCodecContext* ctx_ = nullptr;
  AVFrame* swFrame_ = nullptr;   // NV12/YUV420P staging
  AVFrame* hwFrame_ = nullptr;   // hardware surface, when applicable
  AVPacket* pkt_ = nullptr;
  AVBufferRef* hwDeviceCtx_ = nullptr;
  SwsContext* sws_ = nullptr;
  bool rgbInput_ = false;        // encoder converts BGRA on the GPU; no CPU colour conversion
  std::vector<uint8_t> extradata_;
  void applyBitrate(int bitrateKbps);
  static bool hasParameterSets(const uint8_t* data, size_t size);
  bool annexBExtradata() const;
  std::vector<uint8_t> keyframeBuffer_;

  std::atomic<bool> forceKeyframe_{true};    // always start on a keyframe
  std::atomic<int> pendingBitrateKbps_{0};
  int64_t frameIndex_ = 0;
};

}  // namespace ps
