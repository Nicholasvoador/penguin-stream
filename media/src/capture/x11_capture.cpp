// X11 screen capture via libavdevice's x11grab.
//
// Used for X11 sessions. Under a Wayland session an XWayland root window does
// not contain the composited desktop, so this backend will capture little or
// nothing there - the portal backend is the correct one for Wayland and is
// preferred automatically.

#include "capture/source.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavdevice/avdevice.h>
#include <libavformat/avformat.h>
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

class X11Source : public CaptureSource {
 public:
  ~X11Source() override { stop(); }

  bool start(const CaptureOptions& opts, std::string& error) override {
    avdevice_register_all();

    const AVInputFormat* input = av_find_input_format("x11grab");
    if (!input) { error = "x11grab not available in this ffmpeg build"; return false; }

    std::string target = opts.display;
    if (target.empty()) {
      const char* env = getenv("DISPLAY");
      target = env && *env ? env : ":0.0";
    }

    AVDictionary* options = nullptr;
    av_dict_set(&options, "framerate", std::to_string(opts.fps > 0 ? opts.fps : 60).c_str(), 0);
    av_dict_set(&options, "draw_mouse", "1", 0);
    // Without this, x11grab buffers frames and latency creeps up over time.
    av_dict_set(&options, "fflags", "nobuffer", 0);
    if (opts.width > 0 && opts.height > 0) {
      av_dict_set(&options, "video_size",
                  (std::to_string(opts.width) + "x" + std::to_string(opts.height)).c_str(), 0);
    }

    int ret = avformat_open_input(&fmt_, target.c_str(), input, &options);
    av_dict_free(&options);
    if (ret < 0) {
      error = "cannot open X display '" + target + "': " + avErr(ret);
      return false;
    }

    ret = avformat_find_stream_info(fmt_, nullptr);
    if (ret < 0) { error = "avformat_find_stream_info: " + avErr(ret); return false; }

    for (unsigned i = 0; i < fmt_->nb_streams; ++i) {
      if (fmt_->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
        streamIndex_ = static_cast<int>(i);
        break;
      }
    }
    if (streamIndex_ < 0) { error = "no video stream from x11grab"; return false; }

    AVCodecParameters* par = fmt_->streams[streamIndex_]->codecpar;
    const AVCodec* codec = avcodec_find_decoder(par->codec_id);
    if (!codec) { error = "no decoder for x11grab output"; return false; }

    ctx_ = avcodec_alloc_context3(codec);
    if (!ctx_) { error = "codec context allocation failed"; return false; }
    avcodec_parameters_to_context(ctx_, par);
    ret = avcodec_open2(ctx_, codec, nullptr);
    if (ret < 0) { error = "avcodec_open2: " + avErr(ret); return false; }

    width_ = ctx_->width & ~1;
    height_ = ctx_->height & ~1;
    if (width_ <= 0 || height_ <= 0) { error = "x11grab reported a zero-sized screen"; return false; }

    frame_ = av_frame_alloc();
    pkt_ = av_packet_alloc();
    if (!frame_ || !pkt_) { error = "frame/packet allocation failed"; return false; }

    bgra_.resize(static_cast<size_t>(width_) * height_ * 4);
    return true;
  }

  void stop() override {
    if (sws_) { sws_freeContext(sws_); sws_ = nullptr; }
    if (pkt_) av_packet_free(&pkt_);
    if (frame_) av_frame_free(&frame_);
    if (ctx_) avcodec_free_context(&ctx_);
    if (fmt_) avformat_close_input(&fmt_);
  }

  bool nextFrame(CaptureFrame& out, std::string& error) override {
    for (;;) {
      int ret = av_read_frame(fmt_, pkt_);
      if (ret < 0) { error = "av_read_frame: " + avErr(ret); return false; }

      if (pkt_->stream_index != streamIndex_) { av_packet_unref(pkt_); continue; }

      ret = avcodec_send_packet(ctx_, pkt_);
      av_packet_unref(pkt_);
      if (ret < 0) continue;

      ret = avcodec_receive_frame(ctx_, frame_);
      if (ret == AVERROR(EAGAIN)) continue;
      if (ret < 0) { error = "avcodec_receive_frame: " + avErr(ret); return false; }

      if (!sws_) {
        sws_ = sws_getContext(frame_->width, frame_->height,
                              static_cast<AVPixelFormat>(frame_->format),
                              width_, height_, AV_PIX_FMT_BGRA,
                              SWS_BILINEAR, nullptr, nullptr, nullptr);
        if (!sws_) { error = "sws_getContext failed for x11grab output"; return false; }
      }

      uint8_t* dst[1] = {bgra_.data()};
      const int dstStride[1] = {width_ * 4};
      sws_scale(sws_, frame_->data, frame_->linesize, 0, frame_->height, dst, dstStride);

      out.bgra = bgra_.data();
      out.stride = dstStride[0];
      out.width = width_;
      out.height = height_;
      out.pts_us = static_cast<uint64_t>(ptsCounter_++) * 1000000ull /
                   static_cast<uint64_t>(ctx_->framerate.num > 0 ? ctx_->framerate.num : 60);
      av_frame_unref(frame_);
      return true;
    }
  }

  int width() const override { return width_; }
  int height() const override { return height_; }
  const char* name() const override { return "x11"; }

 private:
  AVFormatContext* fmt_ = nullptr;
  AVCodecContext* ctx_ = nullptr;
  AVFrame* frame_ = nullptr;
  AVPacket* pkt_ = nullptr;
  SwsContext* sws_ = nullptr;
  std::vector<uint8_t> bgra_;
  int streamIndex_ = -1;
  int width_ = 0, height_ = 0;
  uint64_t ptsCounter_ = 0;
};

}  // namespace

std::unique_ptr<CaptureSource> makeX11Source() { return std::make_unique<X11Source>(); }

}  // namespace ps
