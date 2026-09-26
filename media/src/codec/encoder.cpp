#include "codec/encoder.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libavutil/log.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
}

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <thread>

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
  if (preferred == "mf") return {"h264_mf"};
  if (preferred == "x264" || preferred == "software") return {"libx264", "libopenh264"};
#ifdef _WIN32
  // Media Foundation last: it exists on every Windows 10+ machine and uses the
  // GPU's encoder when the vendor-specific paths are unavailable.
  return {"h264_nvenc", "h264_amf", "h264_qsv", "libx264", "h264_mf", "libopenh264"};
#else
  // NVENC first: on hybrid laptops VAAPI usually lands on the iGPU, while the
  // desktop (and the fastest encoder) lives on the NVIDIA card.
  return {"h264_nvenc", "h264_vaapi", "libx264", "libopenh264"};
#endif
}

bool isHardware(const std::string& name) {
  return name.find("vaapi") != std::string::npos || name.find("nvenc") != std::string::npos ||
         name.find("qsv") != std::string::npos || name.find("amf") != std::string::npos ||
         name == "h264_mf";
}

}  // namespace

// True when an Annex B H.264 access unit already contains an SPS (NAL type 7).
bool Encoder::hasParameterSets(const uint8_t* data, size_t size) {
  for (size_t i = 0; i + 3 < size; ++i) {
    if (data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 && (data[i + 3] & 0x1f) == 7) return true;
  }
  return false;
}

// True when the access unit holds an IDR slice (NAL type 5) - a frame that
// decodes on its own. With intra refresh, encoders also flag "recovery point"
// frames as keyframes, but those only heal a picture that was already
// decoding; a viewer that lost frames needs a real IDR to resync instantly.
bool Encoder::hasIdr(const uint8_t* data, size_t size) {
  for (size_t i = 0; i + 3 < size; ++i) {
    if (data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 && (data[i + 3] & 0x1f) == 5) return true;
  }
  return false;
}

bool Encoder::annexBExtradata() const {
  return extradata_.size() > 4 && extradata_[0] == 0 && extradata_[1] == 0 &&
         (extradata_[2] == 1 || (extradata_[2] == 0 && extradata_[3] == 1));
}

Encoder::Encoder() = default;

Encoder::~Encoder() { close(); }

void Encoder::close() {
  if (sws_) sws_free_context(&sws_);
  if (srcFrame_) { srcFrame_->data[0] = nullptr; av_frame_free(&srcFrame_); }
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
  srcW_ = cfg.srcWidth > 0 ? cfg.srcWidth : cfg_.width;
  srcH_ = cfg.srcHeight > 0 ? cfg.srcHeight : cfg_.height;
  if (cfg_.width < 2 || cfg_.height < 2 || srcW_ < 2 || srcH_ < 2) {
    error = "invalid encoder dimensions";
    return false;
  }

  // Probing hardware encoders that are absent is expected; keep FFmpeg quiet
  // while trying them and report only the final outcome.
  const int savedLevel = av_log_get_level();
  av_log_set_level(AV_LOG_QUIET);
  std::string failures;
  for (const auto& name : candidateEncoders(cfg.preferred)) {
    // NVENC accepts BGRA and converts on the GPU, which saves a full-frame CPU
    // colour conversion per frame. Older drivers may refuse RGB input; then
    // fall back to the classic NV12 path.
    // When scaling, one CPU pass does scale + colour conversion together, so
    // the RGB shortcut no longer saves anything.
    const bool tryRgb = name == "h264_nvenc" && !std::getenv("PS_NVENC_NV12") && !scaling();
    const bool irCapable = cfg.intraRefresh && !std::getenv("PS_NO_INTRA_REFRESH") &&
                           (name == "h264_nvenc" || name == "libx264");
    for (const bool rgb : tryRgb ? std::vector<bool>{true, false} : std::vector<bool>{false}) {
      for (const bool ir : irCapable ? std::vector<bool>{true, false} : std::vector<bool>{false}) {
        std::string err;
        if (tryOpen(name, cfg_, rgb, ir, err)) {
          backend_ = name;
          av_log_set_level(savedLevel);
          return true;
        }
        failures += (failures.empty() ? "" : "; ") + name + (rgb ? " (rgb)" : "") + (ir ? " (intra-refresh)" : "") + ": " + err;
        close();
      }
    }
  }
  av_log_set_level(savedLevel);
  error = "no usable H.264 encoder (" + failures + ")";
  return false;
}

bool Encoder::tryOpen(const std::string& encoderName, const EncoderConfig& cfg, bool rgbInput, bool intraRefresh,
                      std::string& error) {
  rgbInput_ = rgbInput;
  intraRefresh_ = intraRefresh;
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
  // Single-frame VBV (as game streamers use): no frame may exceed one frame's
  // worth of bits, so no frame takes longer than a frame interval to send.
  ctx_->rc_buffer_size = static_cast<int>(ctx_->bit_rate / cfg.fps);
  // With intra refresh the "GOP" is the refresh wave: the whole picture is
  // rebuilt over one second, a strip per frame, with no IDR frames at all.
  ctx_->gop_size = intraRefresh ? std::max(2, cfg.fps) : cfg.fps * cfg.gopSeconds;
  ctx_->max_b_frames = 0;                          // B-frames add reorder latency
  ctx_->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
  // Several slices per frame let the viewer decode one frame on several cores
  // at once (slice threading) - a big cut in decode time at 1080p and above -
  // and confine packet loss damage to part of the picture.
  ctx_->slices = cfg.height >= 1000 ? 4 : 2;

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
    // Pipeline depth 1 avoids multi-frame driver buffering.
    av_opt_set_int(ctx_->priv_data, "async_depth", 1, 0);
    av_opt_set_int(ctx_->priv_data, "b_depth", 1, 0);
  } else if (encoderName == "h264_nvenc") {
    // BGR0 == the capture's BGRA byte order on little-endian machines. Tag the
    // stream BT.601 limited, which is what NVENC's RGB->YUV produces and what
    // the viewer assumes.
    ctx_->pix_fmt = rgbInput ? AV_PIX_FMT_BGR0 : AV_PIX_FMT_NV12;
    ctx_->colorspace = AVCOL_SPC_SMPTE170M;
    ctx_->color_range = AVCOL_RANGE_MPEG;
    av_opt_set(ctx_->priv_data, "preset", "p1", 0);      // fastest
    av_opt_set(ctx_->priv_data, "tune", "ull", 0);       // ultra-low latency
    av_opt_set(ctx_->priv_data, "rc", "cbr", 0);
    av_opt_set(ctx_->priv_data, "delay", "0", 0);
    av_opt_set(ctx_->priv_data, "zerolatency", "1", 0);
    av_opt_set(ctx_->priv_data, "forced-idr", "1", 0);
    if (intraRefresh) av_opt_set(ctx_->priv_data, "intra-refresh", "1", 0);
  } else if (encoderName == "h264_amf") {
    ctx_->pix_fmt = AV_PIX_FMT_NV12;
    av_opt_set(ctx_->priv_data, "usage", "ultralowlatency", 0);
    av_opt_set(ctx_->priv_data, "quality", "speed", 0);
    av_opt_set(ctx_->priv_data, "rc", "cbr", 0);
    av_opt_set(ctx_->priv_data, "header_insertion_mode", "idr", 0);
  } else if (encoderName == "h264_qsv") {
    ctx_->pix_fmt = AV_PIX_FMT_NV12;
    av_opt_set(ctx_->priv_data, "preset", "veryfast", 0);
    av_opt_set_int(ctx_->priv_data, "async_depth", 1, 0);
    av_opt_set_int(ctx_->priv_data, "look_ahead", 0, 0);
    av_opt_set_int(ctx_->priv_data, "low_delay_brc", 1, 0);
  } else if (encoderName == "h264_mf") {
    ctx_->pix_fmt = AV_PIX_FMT_NV12;
    av_opt_set(ctx_->priv_data, "scenario", "display_remoting", 0);
    av_opt_set(ctx_->priv_data, "rate_control", "ld_vbr", 0);
    av_opt_set_int(ctx_->priv_data, "hw_encoding", 0, 0);  // let MF pick; forcing hw fails on some drivers
  } else {
    ctx_->pix_fmt = AV_PIX_FMT_YUV420P;
    av_opt_set(ctx_->priv_data, "preset", "ultrafast", 0);
    av_opt_set(ctx_->priv_data, "tune", "zerolatency", 0);
    av_opt_set(ctx_->priv_data, "profile", "baseline", 0);
    av_opt_set(ctx_->priv_data, "x264-params", "no-mbtree=1:sync-lookahead=0:rc-lookahead=0:sliced-threads=1", 0);
    if (intraRefresh) av_opt_set(ctx_->priv_data, "intra-refresh", "1", 0);
  }

  int ret = avcodec_open2(ctx_, codec, nullptr);
  if (ret < 0) { error = "avcodec_open2: " + avErr(ret); return false; }

  // Staging frame in the encoder's software pixel format.
  swFrame_ = av_frame_alloc();
  if (!swFrame_) { error = "av_frame_alloc failed"; return false; }
  swFrame_->format = hw && !rgbInput_ ? AV_PIX_FMT_NV12 : ctx_->pix_fmt;
  // The viewer decodes as BT.601 limited range; say so explicitly so the
  // frame-based scaler converts to exactly that.
  swFrame_->colorspace = AVCOL_SPC_SMPTE170M;
  swFrame_->color_range = AVCOL_RANGE_MPEG;
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

  srcFrame_ = av_frame_alloc();
  if (!srcFrame_) { error = "av_frame_alloc failed"; return false; }
  if (!rgbInput_) {
    // Colour conversion (+ scaling) is the one per-frame CPU pass. Split it
    // across cores: measured 4.6 ms -> 1.1 ms for 1440p -> 1080p on a desktop
    // CPU, and it helps the same-size path on every non-NVENC encoder.
    // Downscaling uses an area filter so small text stays legible.
    sws_ = sws_alloc_context();
    if (!sws_) { error = "sws_alloc_context failed"; return false; }
    const unsigned cores = std::max(1u, std::thread::hardware_concurrency());
    av_opt_set_int(sws_, "sws_flags", scaling() ? SWS_AREA : SWS_POINT, 0);
    av_opt_set_int(sws_, "threads", std::min(8u, std::max(1u, cores / 2)), 0);
  }

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
    out.keyframe = (pkt_->flags & AV_PKT_FLAG_KEY) != 0 && hasIdr(pkt_->data, static_cast<size_t>(pkt_->size));
    out.data = pkt_->data;
    out.size = static_cast<size_t>(pkt_->size);
    // Every keyframe must be decodable on its own (loss recovery, late
    // joiners, recordings). Some encoders (NVENC, x264 with global headers)
    // only emit SPS/PPS out of band, so prepend them when missing.
    if (out.keyframe && annexBExtradata() && !hasParameterSets(out.data, out.size)) {
      keyframeBuffer_.assign(extradata_.begin(), extradata_.end());
      keyframeBuffer_.insert(keyframeBuffer_.end(), out.data, out.data + out.size);
      out.data = keyframeBuffer_.data();
      out.size = keyframeBuffer_.size();
    }
    sink(out);
    av_packet_unref(pkt_);
  }
}

bool Encoder::encodeBGRA(const uint8_t* bgra, int stride, uint64_t pts_us,
                         const std::function<void(const EncodedPacket&)>& sink,
                         std::string& error) {
  if (!ctx_) { error = "encoder not open"; return false; }
  if (const int kbps = pendingBitrateKbps_.exchange(0)) applyBitrate(kbps);

  int ret = av_frame_make_writable(swFrame_);
  if (ret < 0) { error = "av_frame_make_writable: " + avErr(ret); return false; }

  AVFrame* toEncode = swFrame_;
  bool borrowed = false;
  if (rgbInput_ && zeroCopy_) {
    // NVENC copies a system-memory frame into its own input surface while
    // the frame is sent (delay 0), so it can read the capture's pixels
    // directly - no full-frame copy into a staging frame first. The buffer
    // is wrapped with a no-op free: we still own the memory.
    av_frame_unref(srcFrame_);
    srcFrame_->format = ctx_->pix_fmt;
    srcFrame_->width = cfg_.width;
    srcFrame_->height = cfg_.height;
    srcFrame_->colorspace = AVCOL_SPC_SMPTE170M;
    srcFrame_->color_range = AVCOL_RANGE_MPEG;
    const size_t bytes = static_cast<size_t>(stride) * (cfg_.height - 1) + static_cast<size_t>(cfg_.width) * 4;
    srcFrame_->buf[0] = av_buffer_create(const_cast<uint8_t*>(bgra), bytes, [](void*, uint8_t*) {}, nullptr,
                                         AV_BUFFER_FLAG_READONLY);
    if (!srcFrame_->buf[0]) { error = "av_buffer_create failed"; return false; }
    srcFrame_->data[0] = const_cast<uint8_t*>(bgra);
    srcFrame_->linesize[0] = stride;
    toEncode = srcFrame_;
    borrowed = true;
  } else if (rgbInput_) {
    av_image_copy_plane(swFrame_->data[0], swFrame_->linesize[0], bgra, stride, cfg_.width * 4, cfg_.height);
  } else {
    // Wrap the caller's pixels without copying.
    av_frame_unref(srcFrame_);
    srcFrame_->format = AV_PIX_FMT_BGRA;
    srcFrame_->width = srcW_;
    srcFrame_->height = srcH_;
    srcFrame_->data[0] = const_cast<uint8_t*>(bgra);
    srcFrame_->linesize[0] = stride;
    ret = sws_scale_frame(sws_, swFrame_, srcFrame_);
    srcFrame_->data[0] = nullptr;
    if (ret < 0) { error = "sws_scale_frame: " + avErr(ret); return false; }
  }

  if (hwFrame_) {
    ret = av_hwframe_transfer_data(hwFrame_, swFrame_, 0);
    if (ret < 0) { error = "av_hwframe_transfer_data: " + avErr(ret); return false; }
    hwFrame_->pts = static_cast<int64_t>(pts_us);
    toEncode = hwFrame_;
  }
  toEncode->pts = static_cast<int64_t>(pts_us);

  if (forceKeyframe_.exchange(false)) {
    toEncode->pict_type = AV_PICTURE_TYPE_I;
    toEncode->flags |= AV_FRAME_FLAG_KEY;
  } else {
    toEncode->pict_type = AV_PICTURE_TYPE_NONE;
    toEncode->flags &= ~AV_FRAME_FLAG_KEY;
  }

  ret = avcodec_send_frame(ctx_, toEncode);
  if (ret < 0) {
    if (borrowed) av_frame_unref(srcFrame_);
    error = "avcodec_send_frame: " + avErr(ret);
    return false;
  }
  ++frameIndex_;

  const bool ok = drain(sink, error);
  if (borrowed) {
    // If the encoder still references our pixels it would read them after we
    // hand them back to the capture. Never observed with NVENC at delay 0,
    // but if a driver does it, copy from now on.
    if (av_buffer_get_ref_count(srcFrame_->buf[0]) > 1) zeroCopy_ = false;
    av_frame_unref(srcFrame_);
  }
  return ok;
}

void Encoder::flush(const std::function<void(const EncodedPacket&)>& sink) {
  if (!ctx_) return;
  avcodec_send_frame(ctx_, nullptr);
  std::string ignored;
  drain(sink, ignored);
}

void Encoder::applyBitrate(int bitrateKbps) {
  if (!ctx_ || bitrateKbps < 100 || bitrateKbps > 200000) return;
  cfg_.bitrateKbps = bitrateKbps;
  ctx_->bit_rate = static_cast<int64_t>(bitrateKbps) * 1000;
  ctx_->rc_max_rate = ctx_->bit_rate;
  ctx_->rc_buffer_size = static_cast<int>(ctx_->bit_rate / (cfg_.fps > 0 ? cfg_.fps : 60));
}

}  // namespace ps


