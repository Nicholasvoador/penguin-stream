// ps-media: capture/encode and decode/render engine for penguin-stream.
//
// Modes:
//   probe     - report available encoders and capture backends as JSON
//   selftest  - synthetic -> encode -> decode, verify pixels survived. No display needed.
//   capture   - capture -> encode -> framed packets on stdout
//   view      - framed packets on stdin -> decode -> SDL window, input on stdout
//
// The Node process drives this over stdio. Keeping the media path in C++ and
// the network path in Node means each side uses the tool that is actually good
// at the job, at the cost of one pipe.

#include "capture/source.h"
#include "codec/decoder.h"
#include "audio/audio.h"
#include "codec/encoder.h"
#include "ipc/framing.h"
#include "input/event.h"
#include "input/gamepad.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/log.h>
}

#include <algorithm>
#include <atomic>
#include <memory>
#include <mutex>
#include <thread>
#include <utility>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <cerrno>
#include <csignal>

#ifndef _WIN32
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>
#endif

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <timeapi.h>
#endif

#ifndef PS_VERSION
#define PS_VERSION "dev"
#endif

namespace ps {

std::unique_ptr<CaptureSource> makeCaptureSource(const std::string& forced, std::string& chosen) {
  if (forced == "synthetic") { chosen = "synthetic"; return makeSyntheticSource(); }

#ifdef PS_HAVE_DXGI
  if (forced == "gdi") { chosen = "gdi"; return makeGdiSource(); }
  if (forced.empty() || forced == "dxgi") { chosen = "dxgi"; return makeDxgiSource(); }
#endif

#ifdef PS_HAVE_PIPEWIRE
  // On Wayland the portal is the only sanctioned way to capture, and it is what
  // KDE/GNOME actually implement. Prefer it whenever a Wayland session exists.
  const char* wayland = getenv("WAYLAND_DISPLAY");
  if (forced == "portal" || (forced.empty() && wayland && *wayland)) {
    chosen = "portal";
    return makePortalPipeWireSource();
  }
#endif

#ifdef PS_HAVE_X11
  const char* display = getenv("DISPLAY");
  if (forced == "x11" || (forced.empty() && display && *display)) {
    chosen = "x11";
    return makeX11Source();
  }
#endif

  // Never silently substitute a generated pattern for a real desktop.
  chosen.clear();
  return nullptr;
}

namespace {

std::atomic<bool> g_running{true};
volatile std::sig_atomic_t g_stopRequested = 0;
void stopSignal(int) { g_stopRequested = 1; }

uint64_t nowMicros() {
  return static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::microseconds>(
          std::chrono::steady_clock::now().time_since_epoch())
          .count());
}

std::string getArg(int argc, char** argv, const std::string& flag, const std::string& fallback) {
  for (int i = 1; i + 1 < argc; ++i) {
    if (flag == argv[i]) return argv[i + 1];
  }
  return fallback;
}

int intArg(int argc, char** argv, const std::string& flag, int fallback) {
  const std::string v = getArg(argc, argv, flag, "");
  if (v.empty()) return fallback;
  try { return std::stoi(v); } catch (...) { return fallback; }
}

// "x,y,w,h" -> Rect (invalid/empty on any parse problem).
Rect rectArg(int argc, char** argv, const std::string& flag) {
  const std::string v = getArg(argc, argv, flag, "");
  Rect r;
  if (v.empty() || v.size() > 64) return {};
  if (std::sscanf(v.c_str(), "%d,%d,%d,%d", &r.x, &r.y, &r.w, &r.h) != 4) return {};
  if (r.w <= 0 || r.h <= 0 || r.w > 16384 || r.h > 16384 || std::abs(r.x) > 65536 || std::abs(r.y) > 65536) return {};
  return r;
}

// Fits the captured size inside the requested box, keeping the aspect ratio
// and never upscaling (that would cost bandwidth and add nothing).
void fitStreamSize(int srcW, int srcH, int boxW, int boxH, int& outW, int& outH) {
  outW = srcW & ~1;
  outH = srcH & ~1;
  if (boxW <= 0 && boxH <= 0) return;
  // A portrait monitor with a landscape box: compare like with like.
  if ((srcH > srcW) != (boxH > boxW) && boxW > 0 && boxH > 0) std::swap(boxW, boxH);
  double s = 1.0;
  if (boxW > 0) s = std::min(s, double(boxW) / srcW);
  if (boxH > 0) s = std::min(s, double(boxH) / srcH);
  if (s >= 0.999) return;
  outW = std::max(160, static_cast<int>(srcW * s + 0.5)) & ~1;
  outH = std::max(90, static_cast<int>(srcH * s + 0.5)) & ~1;
}

// Rolling latency statistics (milliseconds) for the stats message.
struct Timing {
  std::vector<double> samples;
  void add(double ms) { if (ms >= 0 && ms < 10000) samples.push_back(ms); }
  std::string json(const char* name) {
    if (samples.empty()) return std::string("\"") + name + "\":null";
    std::sort(samples.begin(), samples.end());
    double sum = 0;
    for (double v : samples) sum += v;
    const double avg = sum / samples.size();
    const double p95 = samples[std::min(samples.size() - 1, static_cast<size_t>(samples.size() * 0.95))];
    char buf[160];
    std::snprintf(buf, sizeof(buf), "\"%s\":{\"avg\":%.2f,\"p95\":%.2f,\"max\":%.2f}", name, avg, p95,
                  samples.back());
    samples.clear();
    return buf;
  }
};

/* ------------------------------- probe -------------------------------- */

int runProbe() {
  std::string out = "{\"encoders\":[";
  bool first = true;
  for (const char* name : {"h264_nvenc", "h264_vaapi", "h264_qsv", "h264_amf", "h264_mf",
                           "libx264", "libopenh264"}) {
    if (avcodec_find_encoder_by_name(name)) {
      if (!first) out += ",";
      out += "\"" + std::string(name) + "\"";
      first = false;
    }
  }
  out += "],\"decoders\":[";
  out += avcodec_find_decoder(AV_CODEC_ID_H264) ? "\"h264\"" : "";
  out += "],\"capture\":[\"synthetic\"";
#ifdef PS_HAVE_X11
  out += ",\"x11\"";
#endif
#ifdef PS_HAVE_PIPEWIRE
  out += ",\"portal\"";
#endif
#ifdef PS_HAVE_DXGI
  out += ",\"dxgi\",\"gdi\"";
#endif
  out += "],\"render\":[";
#ifdef PS_HAVE_SDL
  out += "\"sdl\"";
#endif
  std::string padBackend, padWhy;
  const bool padOk = probeVirtualGamepads(padBackend, padWhy);
  out += "],\"input\":{\"kbm\":[";
#ifdef PS_HAVE_DXGI
  out += "\"sendinput\"";
#endif
#ifdef PS_HAVE_PIPEWIRE
  out += "\"portal\"";
#endif
  out += "],\"gamepad\":\"" + padBackend + "\",\"gamepadReady\":" + (padOk ? "true" : "false") +
         ",\"gamepadError\":\"" + jsonEscape(padWhy) + "\"}";
#if defined(PS_HAVE_AUDIO_CAPTURE)
  out += ",\"audio\":" + audioProbeJson();
#elif defined(PS_HAVE_SDL)
  out += ",\"audio\":{\"capture\":\"\",\"appFilter\":false,\"play\":\"sdl\"}";
#endif
  out += ",\"version\":\"" PS_VERSION "\"}";
  printf("%s\n", out.c_str());
  return 0;
}

/* ------------------------------ selftest ------------------------------ */

// Average colour of a quadrant, ignoring a margin so the moving bar and block
// edges do not skew the measurement.
Rgb averageQuadrant(const uint8_t* bgra, int stride, int w, int h, int quadrant) {
  const int hw = w / 2, hh = h / 2;
  const int x0 = (quadrant % 2) ? hw : 0;
  const int y0 = (quadrant / 2) ? hh : 0;
  const int mx = hw / 4, my = hh / 4;

  uint64_t r = 0, g = 0, b = 0, n = 0;
  for (int y = y0 + my; y < y0 + hh - my; ++y) {
    const uint8_t* row = bgra + static_cast<size_t>(y) * stride;
    for (int x = x0 + mx; x < x0 + hw - mx; ++x) {
      // Skip the white bar: it is intentionally saturated in all channels.
      if (row[x * 4] > 230 && row[x * 4 + 1] > 230 && row[x * 4 + 2] > 230) continue;
      b += row[x * 4 + 0];
      g += row[x * 4 + 1];
      r += row[x * 4 + 2];
      ++n;
    }
  }
  if (n == 0) return {0, 0, 0};
  return {static_cast<uint8_t>(r / n), static_cast<uint8_t>(g / n), static_cast<uint8_t>(b / n)};
}

int runSelftest(int argc, char** argv) {
  const int frames = intArg(argc, argv, "--frames", 30);
  const int width = intArg(argc, argv, "--width", 640);
  const int height = intArg(argc, argv, "--height", 360);
  const int tolerance = intArg(argc, argv, "--tolerance", 40);
  const std::string preferred = getArg(argc, argv, "--encoder", "auto");

  auto source = makeSyntheticSource();
  CaptureOptions copts;
  copts.width = width;
  copts.height = height;
  copts.fps = 60;
  std::string err;
  if (!source->start(copts, err)) {
    fprintf(stderr, "selftest: capture start failed: %s\n", err.c_str());
    return 1;
  }

  Encoder enc;
  EncoderConfig ecfg;
  ecfg.width = width;
  ecfg.height = height;
  ecfg.fps = 60;
  ecfg.bitrateKbps = 8000;
  ecfg.preferred = preferred;
  if (!enc.open(ecfg, err)) {
    fprintf(stderr, "selftest: encoder open failed: %s\n", err.c_str());
    return 1;
  }

  Decoder dec;
  if (!dec.open(enc.extradata(), err)) {
    fprintf(stderr, "selftest: decoder open failed: %s\n", err.c_str());
    return 1;
  }

  size_t encodedBytes = 0;
  int encodedPackets = 0;
  int keyframes = 0;
  int decodedFrames = 0;
  int verified = 0;
  int mismatches = 0;
  int worstDelta = 0;

  // Map decoded frames back to the source frame index via pts.
  for (int i = 0; i < frames && g_running; ++i) {
    CaptureFrame cf;
    if (!source->nextFrame(cf, err)) {
      fprintf(stderr, "selftest: capture failed: %s\n", err.c_str());
      return 1;
    }

    const bool ok = enc.encodeBGRA(
        cf.bgra, cf.stride, cf.pts_us,
        [&](const EncodedPacket& p) {
          encodedBytes += p.size;
          ++encodedPackets;
          if (p.keyframe) ++keyframes;

          std::string derr;
          dec.decode(p.data, p.size, p.pts_us,
                     [&](const DecodedFrame& d) {
                       ++decodedFrames;
                       if (d.width != width || d.height != height) {
                         fprintf(stderr, "selftest: size mismatch %dx%d\n", d.width, d.height);
                         ++mismatches;
                         return;
                       }
                       // Round rather than truncate: pts for frame N is
                       // floor(N*1e6/60), so a plain division maps it back to
                       // N-1 whenever that floor lost a fraction.
                       const int srcIndex =
                           static_cast<int>((d.pts_us * 60ull + 500000ull) / 1000000ull);
                       for (int q = 0; q < 4; ++q) {
                         const Rgb want = syntheticExpectedColor(q, srcIndex);
                         const Rgb got = averageQuadrant(d.bgra, d.stride, d.width, d.height, q);
                         const int dr = std::abs(int(want.r) - int(got.r));
                         const int dg = std::abs(int(want.g) - int(got.g));
                         const int db = std::abs(int(want.b) - int(got.b));
                         const int delta = std::max({dr, dg, db});
                         worstDelta = std::max(worstDelta, delta);
                         if (delta > tolerance) {
                           ++mismatches;
                           fprintf(stderr,
                                   "selftest: frame %d quadrant %d expected (%d,%d,%d) got (%d,%d,%d)\n",
                                   srcIndex, q, want.r, want.g, want.b, got.r, got.g, got.b);
                         } else {
                           ++verified;
                         }
                       }
                     },
                     derr);
        },
        err);

    if (!ok) {
      fprintf(stderr, "selftest: encode failed: %s\n", err.c_str());
      return 1;
    }
  }

  enc.flush([&](const EncodedPacket& p) {
    encodedBytes += p.size;
    ++encodedPackets;
    std::string derr;
    dec.decode(p.data, p.size, p.pts_us, [&](const DecodedFrame&) { ++decodedFrames; }, derr);
  });
  dec.flush([&](const DecodedFrame&) { ++decodedFrames; });

  printf("{\"ok\":%s,\"encoder\":\"%s\",\"frames_in\":%d,\"packets\":%d,"
         "\"encoded_bytes\":%zu,\"keyframes\":%d,\"frames_decoded\":%d,"
         "\"quadrants_verified\":%d,\"mismatches\":%d,\"worst_delta\":%d,"
         "\"decode_errors\":%llu}\n",
         (mismatches == 0 && decodedFrames > 0) ? "true" : "false",
         enc.backendName().c_str(), frames, encodedPackets, encodedBytes, keyframes,
         decodedFrames, verified, mismatches, worstDelta,
         static_cast<unsigned long long>(dec.decodeErrors()));

  return (mismatches == 0 && decodedFrames > 0) ? 0 : 1;
}

/* ------------------------------ capture ------------------------------- */

// Reads framed messages from stdin on a dedicated thread, so remote input is
// injected the moment it arrives instead of waiting for the capture/encode
// loop. Handles keyframe/bitrate requests, live permission changes and the
// virtual controllers; emits rumble and input status back to Node.
class CaptureControls {
 public:
  CaptureControls(CaptureSource& source, Encoder& encoder, bool allowKbm, bool allowPad)
      : source_(source), encoder_(encoder), kbmAllowed_(allowKbm), padAllowed_(allowPad) {
    reportStatus(true);
    thread_ = std::thread([this] { run(); });
  }

  ~CaptureControls() {
    {
      std::lock_guard<std::mutex> lock(mu_);
      running_ = false;
    }
#ifdef _WIN32
    // ReadFile on an anonymous pipe cannot be polled; cancel the blocked read.
    // Retry briefly in case the thread had not yet entered ReadFile.
    for (int i = 0; i < 100 && !readerDone_; ++i) {
      if (const DWORD tid = readerThreadId_.load()) {
        if (HANDLE h = OpenThread(THREAD_TERMINATE, FALSE, tid)) {
          CancelSynchronousIo(h);
          CloseHandle(h);
        }
      }
      if (!readerDone_) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    if (!readerDone_) {
      thread_.detach();  // process exit reaps it; it can no longer act (running_ is false)
    }
#endif
    if (thread_.joinable()) thread_.join();
    releaseEverything();
  }

  bool failed() const { return failed_; }
  bool shutdownRequested() const { return shutdownRequested_; }

  // Called by the capture loop once per frame: forwards the latest force-
  // feedback state per controller (at most one frame of added latency).
  void flushRumble() {
    std::pair<double, double> values[kMaxPads];
    bool dirty[kMaxPads];
    {
      std::lock_guard<std::mutex> lock(rumbleMu_);
      for (int i = 0; i < kMaxPads; ++i) {
        values[i] = rumble_[i];
        dirty[i] = rumbleDirty_[i];
        rumbleDirty_[i] = false;
      }
    }
    for (int i = 0; i < kMaxPads; ++i) {
      if (!dirty[i]) continue;
      char buf[128];
      std::snprintf(buf, sizeof(buf), "{\"t\":\"rumble\",\"slot\":%d,\"lo\":%.3f,\"hi\":%.3f}", i,
                    values[i].first, values[i].second);
      writeJson(stdout, MsgType::Control, buf);
    }
  }

 private:
  void run() {
#ifdef _WIN32
    struct Done { std::atomic<bool>& f; ~Done() { f = true; } } done{readerDone_};
    readerThreadId_ = GetCurrentThreadId();
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    uint8_t bytes[4096];
    for (;;) {
      DWORD size = 0;
      const BOOL ok = ReadFile(in, bytes, sizeof(bytes), &size, nullptr);
      if (!ok || size == 0) {
        // Broken pipe / EOF: Node is gone or asked us to stop. Cancellation
        // during shutdown also lands here.
        onEof();
        return;
      }
      if (!consume(bytes, size)) return;
    }
#else
    const int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
    if (flags >= 0) fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK);
    for (;;) {
      {
        std::lock_guard<std::mutex> lock(mu_);
        if (!running_) break;
      }
      pollfd fd{STDIN_FILENO, POLLIN, 0};
      const int ready = poll(&fd, 1, 20);
      if (ready < 0) {
        if (errno == EINTR) continue;
        failed_ = true;
        break;
      }
      if (!ready) continue;
      if (fd.revents & (POLLERR | POLLNVAL)) { failed_ = true; break; }
      uint8_t bytes[4096];
      const ssize_t size = read(STDIN_FILENO, bytes, sizeof(bytes));
      if (size == 0) { onEof(); break; }
      if (size < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) continue;
        failed_ = true;
        break;
      }
      if (!consume(bytes, static_cast<size_t>(size))) break;
    }
    if (flags >= 0) fcntl(STDIN_FILENO, F_SETFL, flags);
#endif
  }

  void onEof() {
    std::lock_guard<std::mutex> lock(mu_);
    if (!running_) return;
    releaseEverythingLocked();
    shutdownRequested_ = true;
  }

  // Returns false when the stream is invalid or shutdown was requested.
  bool consume(const uint8_t* bytes, size_t size) {
    std::lock_guard<std::mutex> lock(mu_);
    if (!running_) return false;
    buffer_.insert(buffer_.end(), bytes, bytes + size);
    size_t offset = 0;
    while (buffer_.size() - offset >= 5) {
      const uint8_t* p = buffer_.data() + offset;
      const uint32_t length = uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) |
                              (uint32_t(p[3]) << 24);
      if (length < 1 || length > 4096) { failed_ = true; return false; }
      if (buffer_.size() - offset < length + 4) break;
      const auto type = static_cast<MsgType>(p[4]);
      const std::string body(reinterpret_cast<const char*>(p + 5), length - 1);
      offset += length + 4;
      if (type == MsgType::Shutdown) {
        releaseEverythingLocked();
        shutdownRequested_ = true;
        return false;
      }
      if (type == MsgType::Input) handleInput(body);
      else if (type == MsgType::Control) handleControl(body);
    }
    buffer_.erase(buffer_.begin(), buffer_.begin() + static_cast<std::ptrdiff_t>(offset));
    return true;
  }

  void handleInput(const std::string& body) {
    InputEvent e;
    if (!parseInputEvent(body, e)) return;
    if (e.kind == InputKind::ReleaseAll) { releaseEverythingLocked(); return; }
    if (isPadEvent(e)) {
      if (!padAllowed_ || !ensurePads()) return;
      gamepads_->handle(e);
      const int count = gamepads_->connectedCount();
      if (count != lastPadCount_) { lastPadCount_ = count; reportStatus(false); }
      return;
    }
    if (kbmAllowed_) source_.input(e);
  }

  void handleControl(const std::string& body) {
    std::string t;
    if (!jsonGetString(body, "t", t)) return;
    if (t == "keyframe") {
      encoder_.requestKeyframe();
    } else if (t == "bitrate") {
      double kbps = 0;
      if (jsonGetNumber(body, "kbps", kbps) && kbps >= 100 && kbps <= 200000) {
        encoder_.setBitrate(static_cast<int>(kbps));
      }
    } else if (t == "permissions") {
      bool kbm = kbmAllowed_, pad = padAllowed_;
      jsonGetBool(body, "kbm", kbm);
      jsonGetBool(body, "pad", pad);
      if (kbmAllowed_ && !kbm) source_.input(releaseAllEvent());
      if (padAllowed_ && !pad && gamepads_) gamepads_->unplugAll();
      kbmAllowed_ = kbm;
      padAllowed_ = pad;
      if (!pad) lastPadCount_ = 0;
      reportStatus(false);
    }
  }

  bool ensurePads() {
    if (gamepads_) return true;
    if (padUnavailable_) return false;
    std::string why;
    gamepads_ = createVirtualGamepads(
        [this](int slot, double low, double high) {
          // Never write to stdout here: a congested pipe would stall the
          // driver thread that games wait on. Record; flushRumble() sends.
          if (slot < 0 || slot >= kMaxPads) return;
          std::lock_guard<std::mutex> lock(rumbleMu_);
          rumble_[slot] = {low, high};
          rumbleDirty_[slot] = true;
        },
        why);
    if (!gamepads_) {
      padUnavailable_ = true;
      padError_ = why;
      writeLog(stdout, "controller forwarding unavailable on this host: " + why);
      reportStatus(false);
      return false;
    }
    return true;
  }

  static InputEvent releaseAllEvent() {
    InputEvent e;
    e.kind = InputKind::ReleaseAll;
    return e;
  }

  void releaseEverything() {
    std::lock_guard<std::mutex> lock(mu_);
    releaseEverythingLocked();
  }

  void releaseEverythingLocked() {
    source_.input(releaseAllEvent());
    if (gamepads_) gamepads_->unplugAll();
    lastPadCount_ = 0;
  }

  // Tells Node what actually works, so the UI never claims more than the host
  // can deliver (e.g. ViGEmBus missing, Wayland input permission refused).
  void reportStatus(bool initial) {
    std::string padBackend, padWhy;
    bool padOk = false;
    if (initial) {
      padOk = probeVirtualGamepads(padBackend, padWhy);
      if (!padOk) { padUnavailable_ = true; padError_ = padWhy; }
      padBackendName_ = padBackend;
    } else {
      padOk = !padUnavailable_;
    }
    const std::string status =
        std::string("{\"t\":\"input-status\",\"kbm\":") + (kbmAllowed_ ? "true" : "false") +
        ",\"kbmReady\":" + (source_.inputReady() ? "true" : "false") +
        ",\"pad\":" + (padAllowed_ ? "true" : "false") +
        ",\"padReady\":" + (padOk ? "true" : "false") +
        ",\"padBackend\":\"" + jsonEscape(padBackendName_) + "\"" +
        ",\"padError\":\"" + jsonEscape(padError_) + "\"" +
        ",\"pads\":" + std::to_string(lastPadCount_) + "}";
    writeJson(stdout, MsgType::Control, status);
  }

  CaptureSource& source_;
  Encoder& encoder_;
  std::mutex mu_;
  bool running_ = true;
  bool kbmAllowed_ = false;
  bool padAllowed_ = false;
  bool padUnavailable_ = false;
  std::string padError_, padBackendName_;
  int lastPadCount_ = 0;
  std::unique_ptr<VirtualGamepads> gamepads_;
  std::mutex rumbleMu_;
  std::pair<double, double> rumble_[kMaxPads] = {};
  bool rumbleDirty_[kMaxPads] = {};
  std::vector<uint8_t> buffer_;
  std::atomic<bool> failed_{false};
  std::atomic<bool> shutdownRequested_{false};
#ifdef _WIN32
  std::atomic<DWORD> readerThreadId_{0};
  std::atomic<bool> readerDone_{false};
#endif
  std::thread thread_;
};

bool hasFlag(int argc, char** argv, const char* flag) {
  for (int i = 2; i < argc; ++i) if (std::string(argv[i]) == flag) return true;
  return false;
}

int runCapture(int argc, char** argv) {
#ifdef _WIN32
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stdin), _O_BINARY);
#endif

  std::signal(SIGTERM, stopSignal);
  std::signal(SIGINT, stopSignal);
#ifndef _WIN32
  std::signal(SIGPIPE, SIG_IGN);
#endif
  const bool allowKbm = hasFlag(argc, argv, "--allow-input");
  const bool allowPad = hasFlag(argc, argv, "--allow-gamepad");
  // Wayland asks for remote-control permission once, when sharing starts.
  // Hosts that may enable keyboard/mouse later must request it up front.
  const bool kbmCapable = allowKbm || hasFlag(argc, argv, "--input-capable");
  const std::string backend = getArg(argc, argv, "--source", "");
  const int fps = intArg(argc, argv, "--fps", 60);
  const int bitrate = intArg(argc, argv, "--bitrate", 15000);
  const int maxFrames = intArg(argc, argv, "--max-frames", 0);
  const std::string preferred = getArg(argc, argv, "--encoder", "auto");

  std::string chosen;
  auto source = makeCaptureSource(backend, chosen);
  if (!source) {
    const std::string message = "no real capture backend available for '" + backend +
        "'; run from an interactive desktop (Windows, Wayland portal/PipeWire or X11); "
        "use --source synthetic explicitly only for tests";
    writeLog(stdout, message);
    fprintf(stderr, "%s\n", message.c_str());
    return 1;
  }

  CaptureOptions copts;
  copts.fps = fps;
  // --width/--height are the stream size box; capture itself stays native and
  // the encoder scales (the X11 grabber would otherwise crop, not scale).
  const int boxW = std::clamp(intArg(argc, argv, "--width", 0), 0, 8192);
  const int boxH = std::clamp(intArg(argc, argv, "--height", 0), 0, 8192);
  copts.display = getArg(argc, argv, "--display", "");
  copts.monitor = rectArg(argc, argv, "--monitor");
  copts.workspace = rectArg(argc, argv, "--workspace");
  copts.restoreToken = getArg(argc, argv, "--restore-token", "");
  if (copts.restoreToken.size() > 512) copts.restoreToken.clear();
  copts.allowInput = kbmCapable && (chosen == "portal" || chosen == "dxgi" || chosen == "gdi");
  if (kbmCapable && !copts.allowInput) {
    writeLog(stdout, "keyboard/mouse control is not available with the '" + chosen +
                     "' capture backend (supported: Windows, Wayland portal)");
  }

  std::string err;
  bool sourceStarted = source->start(copts, err);
#ifdef PS_HAVE_DXGI
  if (!sourceStarted && chosen == "dxgi" && backend.empty()) {
    writeLog(stdout, "DXGI desktop duplication unavailable (" + err + "); falling back to GDI capture");
    source = makeGdiSource();
    chosen = "gdi";
    sourceStarted = source->start(copts, err);
  }
#endif
  if (!sourceStarted) {
    writeJson(stdout, MsgType::Log, "capture start failed: " + err);
    fprintf(stderr, "capture start failed: %s\n", err.c_str());
    return 1;
  }

  if (!source->captureNote().empty()) writeLog(stdout, source->captureNote());
  if (!source->restoreToken().empty()) {
    writeJson(stdout, MsgType::Control,
              "{\"t\":\"restore-token\",\"token\":\"" + jsonEscape(source->restoreToken()) + "\"}");
  }

  Encoder enc;
  EncoderConfig ecfg;
  ecfg.srcWidth = source->width();
  ecfg.srcHeight = source->height();
  fitStreamSize(ecfg.srcWidth, ecfg.srcHeight, boxW, boxH, ecfg.width, ecfg.height);
  ecfg.fps = fps;
  ecfg.bitrateKbps = bitrate;
  ecfg.preferred = preferred;
  if (!enc.open(ecfg, err)) {
    writeJson(stdout, MsgType::Log, "encoder open failed: " + err);
    fprintf(stderr, "encoder open failed: %s\n", err.c_str());
    return 1;
  }

  // Tell the peer what it is about to receive.
  std::string extraHex;
  for (uint8_t byte : enc.extradata()) {
    char buf[3];
    snprintf(buf, sizeof(buf), "%02x", byte);
    extraHex += buf;
  }
  const std::string config =
      "{\"codec\":\"h264\",\"width\":" + std::to_string(enc.width()) +
      ",\"height\":" + std::to_string(enc.height()) +
      ",\"now\":" + std::to_string(nowMicros()) +
      ",\"sourceWidth\":" + std::to_string(ecfg.srcWidth) +
      ",\"sourceHeight\":" + std::to_string(ecfg.srcHeight) +
      ",\"fps\":" + std::to_string(fps) +
      ",\"encoder\":\"" + jsonEscape(enc.backendName()) + "\"" +
      ",\"intraRefresh\":" + (enc.intraRefreshActive() ? "true" : "false") +
      ",\"capture\":\"" + jsonEscape(source->name()) + "\"" +
      ",\"extradata\":\"" + extraHex + "\"}";
  if (!writeJson(stdout, MsgType::Config, config)) return 1;

  uint64_t frames = 0, bytes = 0, windowFrames = 0, windowBytes = 0;
  const uint64_t started = nowMicros();
  uint64_t lastStats = started;
  Timing tCapture, tEncode;  // capture->encoder input, encoder input->packet out
  uint64_t lastPts = 0;
  uint64_t maxFrameBytes = 0;

  auto controls = std::make_unique<CaptureControls>(*source, enc, allowKbm && copts.allowInput, allowPad);
  bool failed = false, writeFailed = false;
  const auto sink = [&](const EncodedPacket& p) {
    bytes += p.size;
    windowBytes += p.size;
    maxFrameBytes = std::max<uint64_t>(maxFrameBytes, p.size);
    if (!writeFailed && !writeVideoPacket(stdout, p.pts_us,
        p.keyframe ? kFlagKeyframe : 0, p.data, p.size)) writeFailed = true;
  };
  while (g_running && !g_stopRequested) {
    if (controls->failed()) {
      writeLog(stdout, "invalid or failed capture stdin framing");
      failed = true; break;
    }
    if (controls->shutdownRequested()) break;
    CaptureFrame cf;
    if (!source->nextFrame(cf, err)) {
      writeJson(stdout, MsgType::Log, "capture ended: " + err);
      failed = true; break;
    }

    if (cf.width != ecfg.srcWidth || cf.height != ecfg.srcHeight || !cf.bgra || cf.stride < cf.width * 4) {
      writeLog(stdout, "capture dimensions changed or invalid frame");
      failed = true; break;
    }
    // pts is the capture timestamp on the steady clock: the viewer uses it,
    // with a clock offset from ping/pong, to measure glass-to-glass latency.
    const uint64_t encStart = nowMicros();
    if (cf.captured_us && cf.captured_us <= encStart) tCapture.add((encStart - cf.captured_us) / 1000.0);
    // Backends without a grab timestamp (X11, test pattern) use "now".
    // Encoders require strictly increasing timestamps.
    lastPts = std::max(lastPts + 1, cf.captured_us ? cf.captured_us : encStart);
    if (!enc.encodeBGRA(cf.bgra, cf.stride, lastPts, sink, err)) {
      writeJson(stdout, MsgType::Log, "encode failed: " + err);
      failed = true; break;
    }
    tEncode.add((nowMicros() - encStart) / 1000.0);
    if (writeFailed) break;  // peer closed the pipe
    controls->flushRumble();

    ++frames;
    ++windowFrames;
    const uint64_t now = nowMicros();
    if (now - lastStats > 1000000) {
      const double secs = double(now - lastStats) / 1e6;
      const std::string stats =
          "{\"frames\":" + std::to_string(frames) +
          ",\"bytes\":" + std::to_string(bytes) +
          ",\"fps\":" + std::to_string(secs > 0 ? windowFrames / secs : 0) +
          ",\"kbps\":" + std::to_string(secs > 0 ? (windowBytes * 8.0 / 1000.0) / secs : 0) +
          ",\"targetKbps\":" + std::to_string(enc.bitrateKbps()) +
          ",\"maxFrameBytes\":" + std::to_string(maxFrameBytes) +
          ",\"now\":" + std::to_string(nowMicros()) +
          "," + tCapture.json("captureMs") + "," + tEncode.json("encodeMs") + "}";
      writeJson(stdout, MsgType::Stats, stats);
      lastStats = now;
      windowFrames = windowBytes = maxFrameBytes = 0;
    }

    if (maxFrames > 0 && frames >= static_cast<uint64_t>(maxFrames)) break;
  }

  // Stop the input thread first: it releases held keys/buttons and unplugs
  // virtual controllers, and must not race with the source shutting down.
  controls.reset();
  source->stop();
  enc.flush(sink);
  return (failed || writeFailed) ? 1 : 0;
}

}  // namespace
}  // namespace ps

#ifdef PS_HAVE_SDL
namespace ps { int runView(int argc, char** argv); }
#endif

int main(int argc, char** argv) {
  av_log_set_level(AV_LOG_ERROR);
#ifdef _WIN32
  // Windows sleeps in 15.6 ms steps by default, which made capture pacing
  // (and therefore latency) jitter by up to a whole frame. Ask for 1 ms for
  // the life of this process, and tell the scheduler this is real-time-ish
  // media work so it is not starved by a busy game.
  timeBeginPeriod(1);
  SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS);
  PROCESS_POWER_THROTTLING_STATE throttle{};
  throttle.Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION;
  throttle.ControlMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
  throttle.StateMask = 0;  // never run this process in efficiency mode
  SetProcessInformation(GetCurrentProcess(), ProcessPowerThrottling, &throttle, sizeof(throttle));
#endif

  if (argc < 2) {
    fprintf(stderr,
            "usage: ps-media <probe|selftest|capture|view> [options]\n"
            "  probe                       list available encoders/backends as JSON\n"
            "  selftest [--frames N]       synthetic encode/decode verification\n"
            "  capture  [--source dxgi|portal|x11|synthetic] [--display N] [--fps N] [--bitrate Kbps]\n"
            "           [--encoder auto|nvenc|amf|qsv|vaapi|mf|x264] [--allow-input] [--allow-gamepad]\n"
            "           [--input-capable]\n"
            "  view                        decode stdin, render in a window\n"
            "  audio-capture [--exclude-voice] [--exclude app,app] [--only app]\n"
            "                              desktop audio to stdout (s16le 48 kHz stereo)\n"
            "  audio-play [--buffer-ms N] [--max-ms N]  play stdin PCM\n");
    return 2;
  }

  const std::string mode = argv[1];
  if (mode == "--version" || mode == "version") { printf("%s\n", PS_VERSION); return 0; }
  if (mode == "probe") return ps::runProbe();
  if (mode == "list-monitors") {
#ifdef PS_HAVE_DXGI
    printf("%s\n", ps::listWindowsMonitorsJson().c_str());
#else
    printf("[]\n");  // Linux: the app asks the compositor (kscreen/xrandr) directly
#endif
    return 0;
  }
  if (mode == "selftest") return ps::runSelftest(argc, argv);
  if (mode == "capture") return ps::runCapture(argc, argv);
#ifdef PS_HAVE_AUDIO_CAPTURE
  if (mode == "audio-capture") return ps::runAudioCapture(argc, argv);
#endif
#ifdef PS_HAVE_SDL
  if (mode == "audio-play") return ps::runAudioPlay(argc, argv);
#endif
#ifdef PS_HAVE_SDL
  if (mode == "view") return ps::runView(argc, argv);
#else
  if (mode == "view") {
    fprintf(stderr, "view mode requires SDL2, which was not found at build time\n");
    return 3;
  }
#endif

  fprintf(stderr, "unknown mode: %s\n", mode.c_str());
  return 2;
}
