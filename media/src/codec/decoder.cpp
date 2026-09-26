#include "codec/decoder.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>
}

#include <cstdint>
#include <cstring>

namespace ps {
namespace {

std::string avErr(int code) {
  char buf[AV_ERROR_MAX_STRING_SIZE] = {0};
  av_strerror(code, buf, sizeof(buf));
  return buf;
}

}  // namespace

Decoder::Decoder() = default;

Decoder::~Decoder() { close(); }

void Decoder::close() {
  if (sws_) { sws_freeContext(sws_); sws_ = nullptr; }
  scalerW_ = scalerH_ = 0;
  if (pkt_) av_packet_free(&pkt_);
  if (frame_) av_frame_free(&frame_);
  if (ctx_) avcodec_free_context(&ctx_);
}

bool Decoder::open(const std::vector<uint8_t>& extradata, std::string& error) {
  close();  // a new stream configuration (e.g. resolution change) replaces the old decoder
  const AVCodec* codec = avcodec_find_decoder(AV_CODEC_ID_H264);
  if (!codec) { error = "no H.264 decoder available"; return false; }

  ctx_ = avcodec_alloc_context3(codec);
  if (!ctx_) { error = "could not allocate decoder context"; return false; }

  // Latency matters more than throughput: slice threads split one frame
  // across cores without the one-frame-per-thread delay of frame threading.
  ctx_->thread_type = FF_THREAD_SLICE;
  ctx_->thread_count = 0;
  ctx_->flags |= AV_CODEC_FLAG_LOW_DELAY;
  ctx_->flags2 |= AV_CODEC_FLAG2_FAST;

  if (!extradata.empty()) {
    ctx_->extradata = static_cast<uint8_t*>(av_mallocz(extradata.size() + AV_INPUT_BUFFER_PADDING_SIZE));
    if (!ctx_->extradata) { error = "extradata allocation failed"; return false; }
    memcpy(ctx_->extradata, extradata.data(), extradata.size());
    ctx_->extradata_size = static_cast<int>(extradata.size());
  }

  int ret = avcodec_open2(ctx_, codec, nullptr);
  if (ret < 0) { error = "avcodec_open2: " + avErr(ret); return false; }

  frame_ = av_frame_alloc();
  pkt_ = av_packet_alloc();
  if (!frame_ || !pkt_) { error = "frame/packet allocation failed"; return false; }
  return true;
}

void Decoder::ensureScaler(int w, int h, int srcFormat) {
  if (sws_ && scalerW_ == w && scalerH_ == h && scalerFmt_ == srcFormat) return;
  if (sws_) sws_freeContext(sws_);
  sws_ = sws_getContext(w, h, static_cast<AVPixelFormat>(srcFormat),
                        w, h, AV_PIX_FMT_BGRA,
                        SWS_BILINEAR, nullptr, nullptr, nullptr);
  scalerW_ = w;
  scalerH_ = h;
  scalerFmt_ = srcFormat;
  bgra_.resize(static_cast<size_t>(w) * h * 4);
}

bool Decoder::drain(const std::function<void(const DecodedFrame&)>& sink, std::string& error) {
  for (;;) {
    int ret = avcodec_receive_frame(ctx_, frame_);
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) return true;
    if (ret < 0) { error = "avcodec_receive_frame: " + avErr(ret); return false; }

    DecodedFrame out{};
    out.width = frame_->width;
    out.height = frame_->height;
    out.pts_us = static_cast<uint64_t>(frame_->pts < 0 ? 0 : frame_->pts);
    if (yuvOutput_ && (frame_->format == AV_PIX_FMT_YUV420P || frame_->format == AV_PIX_FMT_YUVJ420P)) {
      for (int i = 0; i < 3; ++i) {
        out.planes[i] = frame_->data[i];
        out.linesize[i] = frame_->linesize[i];
      }
    } else {
      ensureScaler(frame_->width, frame_->height, frame_->format);
      if (!sws_) { error = "could not create colour converter"; return false; }
      uint8_t* dst[1] = {bgra_.data()};
      const int dstStride[1] = {frame_->width * 4};
      sws_scale(sws_, frame_->data, frame_->linesize, 0, frame_->height, dst, dstStride);
      out.bgra = bgra_.data();
      out.stride = dstStride[0];
    }
    ++framesDecoded_;
    sink(out);
    av_frame_unref(frame_);
  }
}

bool Decoder::decode(const uint8_t* data, size_t size, uint64_t pts_us,
                     const std::function<void(const DecodedFrame&)>& sink,
                     std::string& error) {
  if (!ctx_) { error = "decoder not open"; return false; }

  // The bitstream reader may read up to AV_INPUT_BUFFER_PADDING_SIZE bytes
  // past the end, so decode from an owned, zero-padded copy.
  if (size > static_cast<size_t>(INT32_MAX - AV_INPUT_BUFFER_PADDING_SIZE)) { ++decodeErrors_; return true; }
  padded_.resize(size + AV_INPUT_BUFFER_PADDING_SIZE);
  memcpy(padded_.data(), data, size);
  memset(padded_.data() + size, 0, AV_INPUT_BUFFER_PADDING_SIZE);
  av_packet_unref(pkt_);
  pkt_->data = padded_.data();
  pkt_->size = static_cast<int>(size);
  pkt_->pts = static_cast<int64_t>(pts_us);

  int ret = avcodec_send_packet(ctx_, pkt_);
  pkt_->data = nullptr;
  pkt_->size = 0;
  if (ret < 0) {
    // A corrupt packet is survivable: count it, keep the stream alive, and let
    // the next keyframe resynchronise. Tearing the session down would be worse.
    ++decodeErrors_;
    return true;
  }

  return drain(sink, error);
}

void Decoder::flush(const std::function<void(const DecodedFrame&)>& sink) {
  if (!ctx_) return;
  avcodec_send_packet(ctx_, nullptr);
  std::string ignored;
  drain(sink, ignored);
}

}  // namespace ps
