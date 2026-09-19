// Viewer: decode framed H.264 from stdin, render in an SDL window, and send
// keyboard/mouse events back out on stdout.
//
// Coordinates are normalised to 0..1 before leaving this process, so the host
// can map them onto its own resolution without the viewer needing to know it,
// and so a resized or scaled window still points at the right pixel.

#include "capture/source.h"
#include "codec/decoder.h"
#include "ipc/framing.h"

#include <SDL2/SDL.h>

#include <algorithm>
#include <cmath>
#include <memory>
#include <atomic>
#include <condition_variable>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace ps {
namespace {

std::atomic<bool> g_quit{false};

// Decoded frame handed from the reader thread to the render loop.
struct SharedFrame {
  std::mutex mu;
  std::condition_variable cv;
  std::vector<uint8_t> pixels;
  int width = 0;
  int height = 0;
  bool dirty = false;
  uint64_t framesShown = 0;
};

std::vector<uint8_t> hexToBytes(const std::string& hex) {
  std::vector<uint8_t> out;
  out.reserve(hex.size() / 2);
  for (size_t i = 0; i + 1 < hex.size(); i += 2) {
    out.push_back(static_cast<uint8_t>(std::stoul(hex.substr(i, 2), nullptr, 16)));
  }
  return out;
}

void emitInput(const std::string& json) {
  writeJson(stdout, MsgType::Input, json);
}

const char* mouseButtonName(Uint8 button) {
  switch (button) {
    case SDL_BUTTON_LEFT: return "left";
    case SDL_BUTTON_RIGHT: return "right";
    case SDL_BUTTON_MIDDLE: return "middle";
    case SDL_BUTTON_X1: return "x1";
    case SDL_BUTTON_X2: return "x2";
    default: return "unknown";
  }
}

}  // namespace

int runView(int argc, char** argv) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  bool sendInput = true;
  bool vsync = true;
  std::string title = "penguin-stream";
  for (int i = 1; i < argc; ++i) {
    if (std::string(argv[i]) == "--no-input") sendInput = false;
    if (std::string(argv[i]) == "--title" && i + 1 < argc) title = argv[i + 1];
    if (std::string(argv[i]) == "--no-vsync" || std::string(argv[i]) == "--low-latency") vsync = false;
  }
  if (!vsync) {
    SDL_SetHint(SDL_HINT_RENDER_VSYNC, "0");
  }

  if (SDL_Init(SDL_INIT_VIDEO) != 0) {
    fprintf(stderr, "SDL_Init failed: %s\n", SDL_GetError());
    return 1;
  }

  auto sharedOwner = std::make_shared<SharedFrame>();
  SharedFrame& shared = *sharedOwner;

  // The reader may outlive the SDL loop while stdin blocks. Own all of its
  // state by value, never capture the returning runView stack by reference.
  std::thread reader([sharedOwner] {
    SharedFrame& shared = *sharedOwner;
    Decoder decoder;
    bool decoderOpen = false;
    Message msg;
    std::string err;
    while (!g_quit && readMessage(stdin, msg, &err)) {
      if (msg.type == MsgType::Config) {
        const std::string json(msg.payload.begin(), msg.payload.end());
        double w = 0, h = 0;
        std::string extraHex;
        jsonGetNumber(json, "width", w);
        jsonGetNumber(json, "height", h);
        jsonGetString(json, "extradata", extraHex);
        if (!std::isfinite(w) || !std::isfinite(h) || w < 2 || h < 2 || w > 8192 || h > 8192 ||
            extraHex.size() > 1024 * 1024 || extraHex.size() % 2 ||
            extraHex.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos) {
          fprintf(stderr, "invalid media configuration\n"); g_quit = true; return;
        }

        std::string derr;
        if (!decoder.open(hexToBytes(extraHex), derr)) {
          fprintf(stderr, "decoder open failed: %s\n", derr.c_str());
          g_quit = true;
          return;
        }
        decoderOpen = true;
      } else if (msg.type == MsgType::VideoPacket) {
        if (!decoderOpen) {
          // Config should always arrive first; if it did not, open with no
          // extradata and rely on in-band SPS/PPS.
          std::string derr;
          if (!decoder.open({}, derr)) { g_quit = true; return; }
          decoderOpen = true;
        }
        VideoPacketHeader hdr{};
        const uint8_t* data = nullptr;
        size_t len = 0;
        if (!parseVideoPacket(msg.payload, hdr, &data, &len)) continue;

        std::string derr;
        decoder.decode(data, len, hdr.pts_us, [&](const DecodedFrame& f) {
          std::lock_guard<std::mutex> lock(shared.mu);
          const size_t need = static_cast<size_t>(f.width) * f.height * 4;
          if (shared.pixels.size() != need) shared.pixels.resize(need);
          for (int y = 0; y < f.height; ++y) {
            memcpy(shared.pixels.data() + static_cast<size_t>(y) * f.width * 4,
                   f.bgra + static_cast<size_t>(y) * f.stride,
                   static_cast<size_t>(f.width) * 4);
          }
          shared.width = f.width;
          shared.height = f.height;
          shared.dirty = true;
          shared.cv.notify_one();
        }, derr);
      } else if (msg.type == MsgType::Shutdown) {
        g_quit = true;
        return;
      }
    }
    g_quit = true;  // pipe closed
  });

  // Wait for the first frame so the window opens at the right size.
  SDL_Window* window = nullptr;
  SDL_Renderer* renderer = nullptr;
  SDL_Texture* texture = nullptr;
  int texW = 0, texH = 0;

  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
  while (!g_quit) {
    {
      std::lock_guard<std::mutex> lock(shared.mu);
      if (shared.dirty) break;
    }
    if (std::chrono::steady_clock::now() > deadline) {
      fprintf(stderr, "no video received within 30s\n");
      g_quit = true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }

  if (!g_quit) {
    std::lock_guard<std::mutex> lock(shared.mu);
    window = SDL_CreateWindow(title.c_str(), SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
                              shared.width, shared.height,
                              SDL_WINDOW_RESIZABLE | SDL_WINDOW_ALLOW_HIGHDPI);
    if (!window) {
      fprintf(stderr, "SDL_CreateWindow failed: %s\n", SDL_GetError());
      g_quit = true;
    } else {
      Uint32 rflags = SDL_RENDERER_ACCELERATED;
      if (vsync) rflags |= SDL_RENDERER_PRESENTVSYNC;
      renderer = SDL_CreateRenderer(window, -1, rflags);
      if (!renderer) renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);
    }
  }

  auto normalise = [&](int x, int y, double& nx, double& ny) {
    int w = 1, h = 1;
    SDL_GetWindowSize(window, &w, &h);
    nx = w > 0 ? double(x) / double(w) : 0.0;
    ny = h > 0 ? double(y) / double(h) : 0.0;
    nx = std::min(1.0, std::max(0.0, nx));
    ny = std::min(1.0, std::max(0.0, ny));
  };

  while (!g_quit) {
    SDL_Event ev;
    while (SDL_PollEvent(&ev)) {
      switch (ev.type) {
        case SDL_QUIT:
          g_quit = true;
          break;
        case SDL_MOUSEMOTION: {
          if (!sendInput) break;
          double nx, ny;
          normalise(ev.motion.x, ev.motion.y, nx, ny);
          emitInput("{\"t\":\"mousemove\",\"x\":" + std::to_string(nx) +
                    ",\"y\":" + std::to_string(ny) + "}");
          break;
        }
        case SDL_MOUSEBUTTONDOWN:
        case SDL_MOUSEBUTTONUP: {
          if (!sendInput) break;
          double nx, ny;
          normalise(ev.button.x, ev.button.y, nx, ny);
          emitInput(std::string("{\"t\":\"mousebutton\",\"button\":\"") +
                    mouseButtonName(ev.button.button) + "\",\"down\":" +
                    (ev.type == SDL_MOUSEBUTTONDOWN ? "true" : "false") +
                    ",\"x\":" + std::to_string(nx) + ",\"y\":" + std::to_string(ny) + "}");
          break;
        }
        case SDL_MOUSEWHEEL: {
          if (!sendInput) break;
          emitInput("{\"t\":\"wheel\",\"dx\":" + std::to_string(ev.wheel.x) +
                    ",\"dy\":" + std::to_string(ev.wheel.y) + "}");
          break;
        }
        case SDL_KEYDOWN:
        case SDL_KEYUP: {
          if (!sendInput) break;
          // Ctrl+Shift+Q is the local escape hatch; never forwarded.
          if (ev.type == SDL_KEYDOWN && ev.key.keysym.sym == SDLK_q &&
              (ev.key.keysym.mod & KMOD_CTRL) && (ev.key.keysym.mod & KMOD_SHIFT)) {
            g_quit = true;
            break;
          }
          emitInput(std::string("{\"t\":\"key\",\"scancode\":") +
                    std::to_string(int(ev.key.keysym.scancode)) +
                    ",\"keycode\":" + std::to_string(int(ev.key.keysym.sym)) +
                    ",\"mod\":" + std::to_string(int(ev.key.keysym.mod)) +
                    ",\"down\":" + (ev.type == SDL_KEYDOWN ? "true" : "false") + "}");
          break;
        }
        default:
          break;
      }
    }

    bool present = false;
    {
      std::unique_lock<std::mutex> lock(shared.mu);
      if (!shared.dirty && !g_quit) {
        shared.cv.wait_for(lock, std::chrono::milliseconds(4), [&] { return shared.dirty || g_quit; });
      }
      if (shared.dirty && renderer) {
        if (!texture || texW != shared.width || texH != shared.height) {
          if (texture) SDL_DestroyTexture(texture);
          texture = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_ARGB8888,
                                      SDL_TEXTUREACCESS_STREAMING,
                                      shared.width, shared.height);
          texW = shared.width;
          texH = shared.height;
        }
        if (texture) {
          SDL_UpdateTexture(texture, nullptr, shared.pixels.data(), shared.width * 4);
          present = true;
        }
        shared.dirty = false;
        ++shared.framesShown;
      }
    }

    if (present) {
      SDL_RenderClear(renderer);
      SDL_RenderCopy(renderer, texture, nullptr, nullptr);
      SDL_RenderPresent(renderer);
    }
  }

  g_quit = true;
  if (reader.joinable()) reader.detach();  // blocked on stdin; process exit reaps it

  if (texture) SDL_DestroyTexture(texture);
  if (renderer) SDL_DestroyRenderer(renderer);
  if (window) SDL_DestroyWindow(window);
  SDL_Quit();
  return 0;
}

}  // namespace ps
