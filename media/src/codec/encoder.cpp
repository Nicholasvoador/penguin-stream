#include "codec/encoder.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
}

#include <cstring>

namespace ps {
namespace {

std::string avErr(int code) {
  char buf[AV_ERROR_MAX_STRING_SIZE] = {0};
  av_strerror(code, buf, sizeof(buf));
  return buf;
}

// Ordered by how well they suit low-latency desktop streaming on each platform.
std::vector<std::string> candidateEncoders(const std::string& preferred) {
  if (preferred == "vaapi") return {"h264_vaapi"};
  if (preferred == "nvenc") return {"h264_nvenc"};
  if (preferred == "qsv") return {"h264_qsv"};
  if (preferred == "amf") return {"h264_amf"};
  if (preferred == "x264" || preferred == "software") return {"libx264", "libopenh264"};
#ifdef _WIN32
  return {"h264_nvenc", "h264_amf", "h264_qsv", "libx264", "libopenh264"};
#else
  return {"h264_vaapi", "h264_nvenc", "libx264", "libopenh264"};
#endif
}

bool isHardware(const std::string& name) {
  return name.find("vaapi") != std::string::npos || name.find("nvenc") != std::string::npos ||
         name.find("qsv") != std::string::npos || name.find("amf") != std::string::npos;
}

}  // namespace

Encoder::Encoder() = default;

Encoder::~Encoder() { close(); }

void Encoder::close() {
  if (sws_) { sws_freeContext(sws_); sws_ = nullptr; }
  if (pkt_) { av_packet_free(&pkt_); }
  if (swFrame_) { av_frame_free(&swFrame_); }
  if (hwFrame_) { av_frame_free(&hwFrame_); }
  if (ctx_) { avcodec_free_context(&ctx_); }
  if (hwDeviceCtx_) { av_buffer_unref(&hwDeviceCtx_); }
}

bool Encoder::open(const EncoderConfig& cfg, std::string& error) {
  cfg_ = cfg;
  // Encoders require even dimensions for 4:2:0 chroma.
  cfg_.width &= ~1;
  cfg_.height &= ~1;

  std::string lastError;
  for (const auto& name : candidateEncoders(cfg.preferred)) {
    std::string err;
    if (tryOpen(name, cfg_, err)) {
      backend_ = name;
      return true;
    }
    lastError = name + ": " + err;
    close();
  }
  error = "no usable H.264 encoder (" + lastError + ")";
  return false;
}

bool Encoder::tryOpen(const std::string& encoderName, const EncoderConfig& cfg, std::string& error) {
  const AVCodec* codec = avcodec_find_encoder_by_name(encoderName.c_str());
  if (!codec) { error = "not built into this ffmpeg"; return false; }

  ctx_ = avcodec_alloc_context3(codec);
  if (!ctx_) { error = "could not allocate codec context"; return false; }

  ctx_->width = cfg.width;
  ctx_->height = cfg.height;
  ctx_->time_base = AVRational{1, 1000000};       // microsecond pts
  ctx_->framerate = AVRational{cfg.fps, 1};
  ctx_->bit_rate = static_cast<int64_t>(cfg.bitrateKbps) * 1000;
  ctx_->rc_max_rate = ctx_->bit_rate;
  // A small VBV buffer keeps latency bounded: the encoder cannot bank bits and
  // emit a huge frame later, which is what produces multi-second stalls.
  ctx_->rc_buffer_size = static_cast<int>(ctx_->bit_rate / cfg.fps * 2);
  ctx_->gop_size = cfg.fps * cfg.gopSeconds;
  ctx_->max_b_frames = 0;                          // B-frames add reorder latency
  ctx_->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

  const bool hw = isHardware(encoderName);

  if (encoderName == "h264_vaapi") {
    int ret = av_hwdevice_ctx_create(&hwDeviceCtx_, AV_HWDEVICE_TYPE_VAAPI, nullptr, nullptr, 0);
    if (ret < 0) { error = "no VAAPI device: " + avErr(ret); return false; }

    AVBufferRef* framesRef = av_hwframe_ctx_alloc(hwDeviceCtx_);
    if (!framesRef) { error = "av_hwframe_ctx_alloc failed"; return false; }
    auto* frames = reinterpret_cast<AVHWFramesContext*>(framesRef->data);
    frames->format = AV_PIX_FMT_VAAPI;
    frames->sw_format = AV_PIX_FMT_NV12;
    frames->width = cfg.width;
    frames->height = cfg.height;
    frames->initial_pool_size = 20;
    ret = av_hwframe_ctx_init(framesRef);
    if (ret < 0) {
      av_buffer_unref(&framesRef);
      error = "av_hwframe_ctx_init failed: " + avErr(ret);
      return false;
    }
    ctx_->pix_fmt = AV_PIX_FMT_VAAPI;
    ctx_->hw_frames_ctx = av_buffer_ref(framesRef);
    av_buffer_unref(&framesRef);
  } else if (encoderName == "h264_nvenc") {
    ctx_->pix_fmt = AV_PIX_FMT_NV12;
    av_opt_set(ctx_->priv_data, "preset", "p1", 0);      // fastest
    av_opt_set(ctx_->priv_data, "tune", "ull", 0);       // ultra-low latency
    av_opt_set(ctx_->priv_data, "rc", "cbr", 0);
    av_opt_set(ctx_->priv_data, "delay", "0", 0);
  } else if (encoderName == "h264_qsv" || encoderName == "h264_amf") {
    ctx_->pix_fmt = AV_PIX_FMT_NV12;
    av_opt_set(ctx_->priv_data, "usage", "ultralowlatency", 0);
  } else {
    ctx_->pix_fmt = AV_PIX_FMT_YUV420P;
    av_opt_set(ctx_->priv_data, "preset", "ultrafast", 0);
    av_opt_set(ctx_->priv_data, "tune", "zerolatency", 0);
    av_opt_set(ctx_->priv_data, "profile", "baseline", 0);
  }

  int ret = avcodec_open2(ctx_, codec, nullptr);
  if (ret < 0) { error = "avcodec_open2: " + avErr(ret); return false; }

  // Staging frame in the encoder's software pixel format.
  swFrame_ = av_frame_alloc();
  if (!swFrame_) { error = "av_frame_alloc failed"; return false; }
  swFrame_->format = hw ? AV_PIX_FMT_NV12 : ctx_->pix_fmt;
  swFrame_->width = cfg.width;
  swFrame_->height = cfg.height;
  ret = av_frame_get_buffer(swFrame_, 32);
  if (ret < 0) { error = "av_frame_get_buffer: " + avErr(ret); return false; }

  if (encoderName == "h264_vaapi") {
    hwFrame_ = av_frame_alloc();
    if (!hwFrame_) { error = "hw frame alloc failed"; return false; }
    ret = av_hwframe_get_buffer(ctx_->hw_frames_ctx, hwFrame_, 0);
    if (ret < 0) { error = "av_hwframe_get_buffer: " + avErr(ret); return false; }
  }

  sws_ = sws_getContext(cfg.width, cfg.height, AV_PIX_FMT_BGRA,
                        cfg.width, cfg.height,
                        static_cast<AVPixelFormat>(swFrame_->format),
                        SWS_BILINEAR, nullptr, nullptr, nullptr);
  if (!sws_) { error = "sws_getContext failed"; return false; }

  pkt_ = av_packet_alloc();
  if (!pkt_) { error = "av_packet_alloc failed"; return false; }

  if (ctx_->extradata && ctx_->extradata_size > 0) {
    extradata_.assign(ctx_->extradata, ctx_->extradata + ctx_->extradata_size);
  }
  return true;
}

bool Encoder::drain(const std::function<void(const EncodedPacket&)>& sink, std::string& error) {
  for (;;) {
    int ret = avcodec_receive_packet(ctx_, pkt_);
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) return true;
    if (ret < 0) { error = "avcodec_receive_packet: " + avErr(ret); return false; }

    EncodedPacket out{};
    out.pts_us = static_cast<uint64_t>(pkt_->pts < 0 ? 0 : pkt_->pts);
    out.keyframe = (pkt_->flags & AV_PKT_FLAG_KEY) != 0;
    out.data = pkt_->data;
    out.size = static_cast<size_t>(pkt_->size);
    sink(out);
    av_packet_unref(pkt_);
  }
}

bool Encoder::encodeBGRA(const uint8_t* bgra, int stride, uint64_t pts_us,
                         const std::function<void(const EncodedPacket&)>& sink,
                         std::string& error) {
  if (!ctx_) { error = "encoder not open"; return false; }

  int ret = av_frame_make_writable(swFrame_);
  if (ret < 0) { error = "av_frame_make_writable: " + avErr(ret); return false; }

  const uint8_t* srcSlice[1] = {bgra};
  const int srcStride[1] = {stride};
  sws_scale(sws_, srcSlice, srcStride, 0, cfg_.height, swFrame_->data, swFrame_->linesize);

  AVFrame* toEncode = swFrame_;
  if (hwFrame_) {
    ret = av_hwframe_transfer_data(hwFrame_, swFrame_, 0);
    if (ret < 0) { error = "av_hwframe_transfer_data: " + avErr(ret); return false; }
    hwFrame_->pts = static_cast<int64_t>(pts_us);
    toEncode = hwFrame_;
  }
  toEncode->pts = static_cast<int64_t>(pts_us);

  if (forceKeyframe_) {
    toEncode->pict_type = AV_PICTURE_TYPE_I;
    toEncode->flags |= AV_FRAME_FLAG_KEY;
    forceKeyframe_ = false;
  } else {
    toEncode->pict_type = AV_PICTURE_TYPE_NONE;
  }

  ret = avcodec_send_frame(ctx_, toEncode);
  if (ret < 0) { error = "avcodec_send_frame: " + avErr(ret); return false; }
  ++frameIndex_;

  return drain(sink, error);
}

void Encoder::flush(const std::function<void(const EncodedPacket&)>& sink) {
  if (!ctx_) return;
  avcodec_send_frame(ctx_, nullptr);
  std::string ignored;
  drain(sink, ignored);
}

}  // namespace ps
