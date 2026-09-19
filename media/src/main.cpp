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
#include "codec/encoder.h"
#include "ipc/framing.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/log.h>
}

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace ps {

std::unique_ptr<CaptureSource> makeCaptureSource(const std::string& forced, std::string& chosen) {
  if (forced == "synthetic") { chosen = "synthetic"; return makeSyntheticSource(); }

#ifdef PS_HAVE_DXGI
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

  if (forced.empty()) { chosen = "synthetic"; return makeSyntheticSource(); }
  chosen.clear();
  return nullptr;
}

namespace {

std::atomic<bool> g_running{true};

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

/* ------------------------------- probe -------------------------------- */

int runProbe() {
  std::string out = "{\"encoders\":[";
  bool first = true;
  for (const char* name : {"h264_vaapi", "h264_nvenc", "h264_qsv", "h264_amf",
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
  out += ",\"dxgi\"";
#endif
  out += "],\"render\":[";
#ifdef PS_HAVE_SDL
  out += "\"sdl\"";
#endif
  out += "]}";
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

int runCapture(int argc, char** argv) {
#ifdef _WIN32
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stdin), _O_BINARY);
#endif

  const std::string backend = getArg(argc, argv, "--source", "");
  const int fps = intArg(argc, argv, "--fps", 60);
  const int bitrate = intArg(argc, argv, "--bitrate", 15000);
  const int maxFrames = intArg(argc, argv, "--max-frames", 0);
  const std::string preferred = getArg(argc, argv, "--encoder", "auto");

  std::string chosen;
  auto source = makeCaptureSource(backend, chosen);
  if (!source) {
    writeLog(stdout, "no capture backend available for '" + backend + "'");
    return 1;
  }

  CaptureOptions copts;
  copts.fps = fps;
  copts.width = intArg(argc, argv, "--width", 0);
  copts.height = intArg(argc, argv, "--height", 0);
  copts.display = getArg(argc, argv, "--display", "");

  std::string err;
  if (!source->start(copts, err)) {
    writeJson(stdout, MsgType::Log, "capture start failed: " + err);
    fprintf(stderr, "capture start failed: %s\n", err.c_str());
    return 1;
  }

  Encoder enc;
  EncoderConfig ecfg;
  ecfg.width = source->width();
  ecfg.height = source->height();
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
      ",\"fps\":" + std::to_string(fps) +
      ",\"encoder\":\"" + jsonEscape(enc.backendName()) + "\"" +
      ",\"capture\":\"" + jsonEscape(source->name()) + "\"" +
      ",\"extradata\":\"" + extraHex + "\"}";
  writeJson(stdout, MsgType::Config, config);

  uint64_t frames = 0, bytes = 0;
  const uint64_t started = nowMicros();
  uint64_t lastStats = started;

  while (g_running) {
    CaptureFrame cf;
    if (!source->nextFrame(cf, err)) {
      writeJson(stdout, MsgType::Log, "capture ended: " + err);
      break;
    }

    bool writeFailed = false;
    if (!enc.encodeBGRA(cf.bgra, cf.stride, cf.pts_us,
                        [&](const EncodedPacket& p) {
                          bytes += p.size;
                          if (!writeVideoPacket(stdout, p.pts_us,
                                                p.keyframe ? kFlagKeyframe : 0,
                                                p.data, p.size)) {
                            writeFailed = true;
                          }
                        },
                        err)) {
      writeJson(stdout, MsgType::Log, "encode failed: " + err);
      break;
    }
    if (writeFailed) break;  // peer closed the pipe

    ++frames;
    const uint64_t now = nowMicros();
    if (now - lastStats > 2000000) {
      const double secs = double(now - started) / 1e6;
      const std::string stats =
          "{\"frames\":" + std::to_string(frames) +
          ",\"bytes\":" + std::to_string(bytes) +
          ",\"fps\":" + std::to_string(secs > 0 ? frames / secs : 0) +
          ",\"kbps\":" + std::to_string(secs > 0 ? (bytes * 8.0 / 1000.0) / secs : 0) + "}";
      writeJson(stdout, MsgType::Stats, stats);
      lastStats = now;
    }

    if (maxFrames > 0 && frames >= static_cast<uint64_t>(maxFrames)) break;
  }

  source->stop();
  return 0;
}

}  // namespace
}  // namespace ps

#ifdef PS_HAVE_SDL
namespace ps { int runView(int argc, char** argv); }
#endif

int main(int argc, char** argv) {
  av_log_set_level(AV_LOG_ERROR);

  if (argc < 2) {
    fprintf(stderr,
            "usage: ps-media <probe|selftest|capture|view> [options]\n"
            "  probe                       list available encoders/backends as JSON\n"
            "  selftest [--frames N]       synthetic encode/decode verification\n"
            "  capture  [--source x11|portal|synthetic] [--fps N] [--bitrate Kbps]\n"
            "  view                        decode stdin, render in a window\n");
    return 2;
  }

  const std::string mode = argv[1];
  if (mode == "probe") return ps::runProbe();
  if (mode == "selftest") return ps::runSelftest(argc, argv);
  if (mode == "capture") return ps::runCapture(argc, argv);
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
