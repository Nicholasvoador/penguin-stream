#include "codec/decoder.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>
}

namespace ps {
namespace {

std::string avErr(int code) {
  char buf[AV_ERROR_MAX_STRING_SIZE] = {0};
  av_strerror(code, buf, sizeof(buf));
  return buf;
}

}  // namespace

Decoder::Decoder() = default;

Decoder::~Decoder() {
  if (sws_) sws_freeContext(sws_);
  if (pkt_) av_packet_free(&pkt_);
  if (frame_) av_frame_free(&frame_);
  if (ctx_) avcodec_free_context(&ctx_);
}

bool Decoder::open(const std::vector<uint8_t>& extradata, std::string& error) {
  const AVCodec* codec = avcodec_find_decoder(AV_CODEC_ID_H264);
  if (!codec) { error = "no H.264 decoder available"; return false; }

  ctx_ = avcodec_alloc_context3(codec);
  if (!ctx_) { error = "could not allocate decoder context"; return false; }

  // Latency matters more than throughput here: decode on the calling thread
  // and never hold frames back waiting to reorder.
  ctx_->thread_count = 1;
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

    ensureScaler(frame_->width, frame_->height, frame_->format);
    if (!sws_) { error = "could not create colour converter"; return false; }

    uint8_t* dst[1] = {bgra_.data()};
    const int dstStride[1] = {frame_->width * 4};
    sws_scale(sws_, frame_->data, frame_->linesize, 0, frame_->height, dst, dstStride);

    DecodedFrame out{};
    out.width = frame_->width;
    out.height = frame_->height;
    out.pts_us = static_cast<uint64_t>(frame_->pts < 0 ? 0 : frame_->pts);
    out.bgra = bgra_.data();
    out.stride = dstStride[0];
    ++framesDecoded_;
    sink(out);
    av_frame_unref(frame_);
  }
}

bool Decoder::decode(const uint8_t* data, size_t size, uint64_t pts_us,
                     const std::function<void(const DecodedFrame&)>& sink,
                     std::string& error) {
  if (!ctx_) { error = "decoder not open"; return false; }

  av_packet_unref(pkt_);
  // av_packet_from_data would take ownership; we only borrow the caller's bytes
  // for the duration of avcodec_send_packet, so point at them directly.
  pkt_->data = const_cast<uint8_t*>(data);
  pkt_->size = static_cast<int>(size);
  pkt_->pts = static_cast<int64_t>(pts_us);

  int ret = avcodec_send_packet(ctx_, pkt_);
  if (ret < 0) {
    // A corrupt packet is survivable: count it, keep the stream alive, and let
    // the next keyframe resynchronise. Tearing the session down would be worse.
    ++decodeErrors_;
    pkt_->data = nullptr;
    pkt_->size = 0;
    return true;
  }
  pkt_->data = nullptr;
  pkt_->size = 0;

  return drain(sink, error);
}

void Decoder::flush(const std::function<void(const DecodedFrame&)>& sink) {
  if (!ctx_) return;
  avcodec_send_packet(ctx_, nullptr);
  std::string ignored;
  drain(sink, ignored);
}

}  // namespace ps
