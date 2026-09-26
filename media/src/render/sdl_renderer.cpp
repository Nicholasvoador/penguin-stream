// Viewer: decode framed H.264 from stdin, render in an SDL window, and send
// keyboard/mouse/controller events back out on stdout.
//
// Coordinates are normalised to 0..1 of the picture (letterboxing excluded),
// so the host maps them onto its own resolution without the viewer knowing it.
//
// Hotkeys (never forwarded), all with Ctrl+Alt+Shift held, as in Moonlight:
//   Q  disconnect            X  fullscreen on/off
//   M  keyboard+mouse on/off G  controllers on/off
//   Z  game mode: capture the mouse (relative motion) and system keys
#include "capture/source.h"
#include "codec/decoder.h"
#include "ipc/framing.h"

#include <SDL2/SDL.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <set>
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
  bool yuv = false;
  std::vector<uint8_t> pixels;       // BGRA, or Y|U|V tightly packed when yuv
  int width = 0;
  int height = 0;
  bool dirty = false;
  // Latency accounting (steady-clock microseconds) for the newest frame.
  uint64_t recvUs = 0;      // packet arrived from Node
  uint64_t decodedUs = 0;   // decoder produced the picture
  uint64_t pts = 0;         // host capture timestamp (host clock), echoed back
  uint64_t replaced = 0;    // decoded frames overwritten before they could be shown
  double decodeMsSum = 0;   // accumulated by the reader thread
  uint64_t decoded = 0;
};

uint64_t nowUs() {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
}

// Control messages from Node, forwarded to the SDL thread as user events.
Uint32 g_controlEvent = 0;

std::vector<uint8_t> hexToBytes(const std::string& hex) {
  std::vector<uint8_t> out;
  out.reserve(hex.size() / 2);
  for (size_t i = 0; i + 1 < hex.size(); i += 2) {
    out.push_back(static_cast<uint8_t>(std::stoul(hex.substr(i, 2), nullptr, 16)));
  }
  return out;
}

void emit(const std::string& json) { writeJson(stdout, MsgType::Input, json); }
void emitControl(const std::string& json) { writeJson(stdout, MsgType::Control, json); }

std::string num(double v) {
  char buf[32];
  std::snprintf(buf, sizeof(buf), "%.5f", v);
  return buf;
}

const char* controllerButtonName(Uint8 button) {
  switch (button) {
    case SDL_CONTROLLER_BUTTON_A: return "a";
    case SDL_CONTROLLER_BUTTON_B: return "b";
    case SDL_CONTROLLER_BUTTON_X: return "x";
    case SDL_CONTROLLER_BUTTON_Y: return "y";
    case SDL_CONTROLLER_BUTTON_BACK: return "back";
    case SDL_CONTROLLER_BUTTON_GUIDE: return "guide";
    case SDL_CONTROLLER_BUTTON_START: return "start";
    case SDL_CONTROLLER_BUTTON_LEFTSTICK: return "ls";
    case SDL_CONTROLLER_BUTTON_RIGHTSTICK: return "rs";
    case SDL_CONTROLLER_BUTTON_LEFTSHOULDER: return "lb";
    case SDL_CONTROLLER_BUTTON_RIGHTSHOULDER: return "rb";
    case SDL_CONTROLLER_BUTTON_DPAD_UP: return "dpad_up";
    case SDL_CONTROLLER_BUTTON_DPAD_DOWN: return "dpad_down";
    case SDL_CONTROLLER_BUTTON_DPAD_LEFT: return "dpad_left";
    case SDL_CONTROLLER_BUTTON_DPAD_RIGHT: return "dpad_right";
    default: return nullptr;
  }
}

const char* controllerAxisName(Uint8 axis) {
  switch (axis) {
    case SDL_CONTROLLER_AXIS_LEFTX: return "ls_x";
    case SDL_CONTROLLER_AXIS_LEFTY: return "ls_y";
    case SDL_CONTROLLER_AXIS_RIGHTX: return "rs_x";
    case SDL_CONTROLLER_AXIS_RIGHTY: return "rs_y";
    case SDL_CONTROLLER_AXIS_TRIGGERLEFT: return "lt";
    case SDL_CONTROLLER_AXIS_TRIGGERRIGHT: return "rt";
    default: return nullptr;
  }
}

const char* mouseButtonName(Uint8 button) {
  switch (button) {
    case SDL_BUTTON_LEFT: return "left";
    case SDL_BUTTON_RIGHT: return "right";
    case SDL_BUTTON_MIDDLE: return "middle";
    case SDL_BUTTON_X1: return "x1";
    case SDL_BUTTON_X2: return "x2";
    default: return nullptr;
  }
}

struct Pad {
  SDL_GameController* controller = nullptr;
  SDL_JoystickID instance = -1;
  bool buttons[SDL_CONTROLLER_BUTTON_MAX] = {};
  double axes[SDL_CONTROLLER_AXIS_MAX] = {};
};

class Viewer {
 public:
  Viewer(bool kbm, bool pad, std::string title) : kbm_(kbm), pad_(pad), baseTitle_(std::move(title)) {}

  int run(std::shared_ptr<SharedFrame> shared, bool vsync);

 private:
  // ---------------------------------------------------------------- input
  void setKbm(bool on) {
    if (on == kbm_) return;
    if (!on) releaseKeysAndButtons();
    kbm_ = on;
    if (!on && capture_) setCapture(false);
    stateChanged();
  }

  void setPad(bool on) {
    if (on == pad_) return;
    if (!on) {
      for (int slot = 0; slot < 4; ++slot) {
        if (!pads_[slot].controller) continue;
        neutralisePad(slot);
        emit("{\"t\":\"pad\",\"slot\":" + std::to_string(slot) + ",\"connected\":false}");
      }
    }
    pad_ = on;
    if (on) {
      for (int slot = 0; slot < 4; ++slot) {
        if (pads_[slot].controller)
          emit("{\"t\":\"pad\",\"slot\":" + std::to_string(slot) + ",\"connected\":true}");
      }
    }
    stateChanged();
  }

  // Game mode: the viewer owns the pointer (relative motion, hidden cursor)
  // and system shortcuts like Alt+Tab or the Windows key go to the host.
  void setCapture(bool on) {
    if ((on && !kbm_) || !window_) return;
    capture_ = on;
    SDL_SetRelativeMouseMode(on ? SDL_TRUE : SDL_FALSE);
    SDL_SetWindowKeyboardGrab(window_, on ? SDL_TRUE : SDL_FALSE);
    relX_ = relY_ = 0;
    stateChanged();
  }

  void releaseKeysAndButtons() {
    flushMotion();
    for (int code : heldKeys_) emit("{\"t\":\"key\",\"code\":" + std::to_string(code) + ",\"down\":false}");
    heldKeys_.clear();
    for (const std::string& b : heldButtons_) emit("{\"t\":\"mousebutton\",\"button\":\"" + b + "\",\"down\":false}");
    heldButtons_.clear();
  }

  void neutralisePad(int slot) {
    Pad& p = pads_[slot];
    for (int b = 0; b < SDL_CONTROLLER_BUTTON_MAX; ++b) {
      if (!p.buttons[b]) continue;
      p.buttons[b] = false;
      if (const char* name = controllerButtonName(static_cast<Uint8>(b)))
        emit("{\"t\":\"pad_button\",\"slot\":" + std::to_string(slot) + ",\"button\":\"" + name + "\",\"down\":false}");
    }
    for (int a = 0; a < SDL_CONTROLLER_AXIS_MAX; ++a) {
      if (p.axes[a] == 0) continue;
      p.axes[a] = 0;
      if (const char* name = controllerAxisName(static_cast<Uint8>(a)))
        emit("{\"t\":\"pad_axis\",\"slot\":" + std::to_string(slot) + ",\"axis\":\"" + name + "\",\"value\":0}");
    }
  }

  int slotFor(SDL_JoystickID instance) const {
    for (int i = 0; i < 4; ++i) if (pads_[i].controller && pads_[i].instance == instance) return i;
    return -1;
  }

  void addController(int deviceIndex) {
    if (!SDL_IsGameController(deviceIndex)) return;
    const SDL_JoystickID instance = SDL_JoystickGetDeviceInstanceID(deviceIndex);
    if (slotFor(instance) >= 0) return;
    for (int slot = 0; slot < 4; ++slot) {
      if (pads_[slot].controller) continue;
      SDL_GameController* c = SDL_GameControllerOpen(deviceIndex);
      if (!c) return;
      pads_[slot] = Pad{};
      pads_[slot].controller = c;
      pads_[slot].instance = instance;
      SDL_GameControllerSetPlayerIndex(c, slot);
      if (pad_) emit("{\"t\":\"pad\",\"slot\":" + std::to_string(slot) + ",\"connected\":true}");
      stateChanged();
      return;
    }
  }

  void removeController(SDL_JoystickID instance) {
    const int slot = slotFor(instance);
    if (slot < 0) return;
    if (pad_) {
      neutralisePad(slot);
      emit("{\"t\":\"pad\",\"slot\":" + std::to_string(slot) + ",\"connected\":false}");
    }
    SDL_GameControllerClose(pads_[slot].controller);
    pads_[slot] = Pad{};
    stateChanged();
  }

  int controllerCount() const {
    int n = 0;
    for (const Pad& p : pads_) n += p.controller ? 1 : 0;
    return n;
  }

  // Absolute motion is coalesced per event batch: a 1000 Hz mouse would
  // otherwise send far more updates than the host can display.
  void flushMotion() {
    if (hasAbs_) {
      emit("{\"t\":\"mousemove\",\"x\":" + num(absX_) + ",\"y\":" + num(absY_) + "}");
      hasAbs_ = false;
    }
    const int dx = static_cast<int>(relX_), dy = static_cast<int>(relY_);
    if (dx || dy) {
      emit("{\"t\":\"mouserel\",\"dx\":" + std::to_string(dx) + ",\"dy\":" + std::to_string(dy) + "}");
      relX_ -= dx;
      relY_ -= dy;
    }
  }

  // Maps window coordinates to 0..1 of the letterboxed picture.
  bool normalise(int x, int y, double& nx, double& ny) const {
    if (!renderer_ || texW_ <= 0 || texH_ <= 0) return false;
    // With a logical size set, SDL already reports mouse positions in picture
    // pixels; letterbox bars come out as negative or > size and are clamped.
    nx = std::clamp(double(x) / double(texW_ - 1 > 0 ? texW_ - 1 : 1), 0.0, 1.0);
    ny = std::clamp(double(y) / double(texH_ - 1 > 0 ? texH_ - 1 : 1), 0.0, 1.0);
    return true;
  }

  bool handleHotkey(const SDL_KeyboardEvent& k) {
    const Uint16 mods = k.keysym.mod;
    if (!((mods & KMOD_CTRL) && (mods & KMOD_ALT) && (mods & KMOD_SHIFT))) return false;
    switch (k.keysym.scancode) {
      case SDL_SCANCODE_Q: if (k.type == SDL_KEYDOWN) g_quit = true; return true;
      case SDL_SCANCODE_X:
        if (k.type == SDL_KEYDOWN && !k.repeat) {
          fullscreen_ = !fullscreen_;
          SDL_SetWindowFullscreen(window_, fullscreen_ ? SDL_WINDOW_FULLSCREEN_DESKTOP : 0);
          stateChanged();
        }
        return true;
      case SDL_SCANCODE_M: if (k.type == SDL_KEYDOWN && !k.repeat) setKbm(!kbm_); return true;
      case SDL_SCANCODE_G: if (k.type == SDL_KEYDOWN && !k.repeat) setPad(!pad_); return true;
      case SDL_SCANCODE_Z: if (k.type == SDL_KEYDOWN && !k.repeat) setCapture(!capture_); return true;
      default: return false;
    }
  }

  void handleEvent(const SDL_Event& ev) {
    switch (ev.type) {
      case SDL_QUIT:
        g_quit = true;
        break;
      case SDL_WINDOWEVENT:
        if (ev.window.event == SDL_WINDOWEVENT_FOCUS_LOST) {
          // Alt+Tab away must not leave keys or buttons held down on the host.
          releaseKeysAndButtons();
          if (pad_) for (int slot = 0; slot < 4; ++slot) if (pads_[slot].controller) neutralisePad(slot);
          if (capture_) setCapture(false);
        }
        break;
      case SDL_MOUSEMOTION: {
        if (!kbm_ || ev.motion.which == SDL_TOUCH_MOUSEID) break;
        if (capture_) {
          // Raw, unscaled mouse counts (SDL_HINT_MOUSE_RELATIVE_SCALING=0), so
          // in-game sensitivity matches a local mouse regardless of window size.
          relX_ += ev.motion.xrel;
          relY_ += ev.motion.yrel;
        } else if (normalise(ev.motion.x, ev.motion.y, absX_, absY_)) {
          hasAbs_ = true;
        }
        break;
      }
      case SDL_MOUSEBUTTONDOWN:
      case SDL_MOUSEBUTTONUP: {
        if (!kbm_) break;
        const char* name = mouseButtonName(ev.button.button);
        if (!name) break;
        const bool down = ev.type == SDL_MOUSEBUTTONDOWN;
        flushMotion();
        if (down) heldButtons_.insert(name); else if (!heldButtons_.erase(name)) break;
        double nx = 0, ny = 0;
        if (!capture_ && normalise(ev.button.x, ev.button.y, nx, ny)) {
          emit(std::string("{\"t\":\"mousebutton\",\"button\":\"") + name + "\",\"down\":" +
               (down ? "true" : "false") + ",\"x\":" + num(nx) + ",\"y\":" + num(ny) + "}");
        } else {
          emit(std::string("{\"t\":\"mousebutton\",\"button\":\"") + name + "\",\"down\":" +
               (down ? "true" : "false") + "}");
        }
        break;
      }
      case SDL_MOUSEWHEEL: {
        if (!kbm_) break;
        flushMotion();
#if SDL_VERSION_ATLEAST(2, 0, 18)
        double dx = ev.wheel.preciseX, dy = ev.wheel.preciseY;
#else
        double dx = ev.wheel.x, dy = ev.wheel.y;
#endif
        if (ev.wheel.direction == SDL_MOUSEWHEEL_FLIPPED) { dx = -dx; dy = -dy; }
        dx = std::clamp(dx, -100.0, 100.0);
        dy = std::clamp(dy, -100.0, 100.0);
        if (dx == 0 && dy == 0) break;
        emit("{\"t\":\"wheel\",\"dx\":" + num(dx) + ",\"dy\":" + num(dy) + "}");
        break;
      }
      case SDL_KEYDOWN:
      case SDL_KEYUP: {
        if (handleHotkey(ev.key)) break;
        if (!kbm_) break;
        const int code = static_cast<int>(ev.key.keysym.scancode);
        if (code <= 0 || code > 511) break;
        flushMotion();
        if (ev.type == SDL_KEYDOWN) {
          if (ev.key.repeat) {
            emit("{\"t\":\"keyrepeat\",\"code\":" + std::to_string(code) + "}");
            break;
          }
          heldKeys_.insert(code);
          emit("{\"t\":\"key\",\"code\":" + std::to_string(code) + ",\"down\":true}");
        } else if (heldKeys_.erase(code)) {
          emit("{\"t\":\"key\",\"code\":" + std::to_string(code) + ",\"down\":false}");
        }
        break;
      }
      case SDL_CONTROLLERDEVICEADDED:
        // Automated tests inject controller events themselves; a pad that
        // happens to be plugged into the test machine must not interfere.
        if (!std::getenv("PS_IGNORE_LOCAL_CONTROLLERS")) addController(ev.cdevice.which);
        break;
      case SDL_CONTROLLERDEVICEREMOVED:
        removeController(ev.cdevice.which);
        break;
      case SDL_CONTROLLERBUTTONDOWN:
      case SDL_CONTROLLERBUTTONUP: {
        const int slot = slotFor(ev.cbutton.which);
        const char* name = controllerButtonName(ev.cbutton.button);
        if (slot < 0 || !name || !pad_) break;
        const bool down = ev.type == SDL_CONTROLLERBUTTONDOWN;
        pads_[slot].buttons[ev.cbutton.button] = down;
        emit("{\"t\":\"pad_button\",\"slot\":" + std::to_string(slot) + ",\"button\":\"" + name +
             "\",\"down\":" + (down ? "true" : "false") + "}");
        break;
      }
      case SDL_CONTROLLERAXISMOTION: {
        const int slot = slotFor(ev.caxis.which);
        const char* name = controllerAxisName(ev.caxis.axis);
        if (slot < 0 || !name || !pad_) break;
        const bool trigger = ev.caxis.axis == SDL_CONTROLLER_AXIS_TRIGGERLEFT ||
                             ev.caxis.axis == SDL_CONTROLLER_AXIS_TRIGGERRIGHT;
        const double v = trigger ? std::clamp(ev.caxis.value / 32767.0, 0.0, 1.0)
                                 : std::clamp(ev.caxis.value / (ev.caxis.value < 0 ? 32768.0 : 32767.0), -1.0, 1.0);
        double& last = pads_[slot].axes[ev.caxis.axis];
        // Games apply their own dead zones; only drop changes too small to matter.
        if (std::fabs(v - last) < 1.0 / 2048 && !(v == 0 && last != 0)) break;
        last = v;
        emit("{\"t\":\"pad_axis\",\"slot\":" + std::to_string(slot) + ",\"axis\":\"" + name +
             "\",\"value\":" + num(v) + "}");
        break;
      }
      default:
        if (ev.type == g_controlEvent) {
          std::unique_ptr<std::string> json(static_cast<std::string*>(ev.user.data1));
          if (json) handleControl(*json);
        }
        break;
    }
  }

  // Messages from Node: live toggles from the UI, host permissions, rumble.
  void handleControl(const std::string& json) {
    std::string t;
    if (!jsonGetString(json, "t", t)) return;
    if (t == "viewer-set") {
      bool v = false;
      if (jsonGetBool(json, "kbm", v)) setKbm(v);
      if (jsonGetBool(json, "pad", v)) setPad(v);
      if (jsonGetBool(json, "capture", v)) setCapture(v);
    } else if (t == "host-permissions") {
      bool v = false;
      if (jsonGetBool(json, "kbm", v)) hostKbm_ = v;
      if (jsonGetBool(json, "pad", v)) hostPad_ = v;
      updateTitle();
    } else if (t == "rumble") {
      double slot = -1, lo = 0, hi = 0;
      if (!jsonGetNumber(json, "slot", slot) || slot < 0 || slot > 3) return;
      jsonGetNumber(json, "lo", lo);
      jsonGetNumber(json, "hi", hi);
      if (SDL_GameController* c = pads_[static_cast<int>(slot)].controller) {
        const auto m = [](double v) { return static_cast<Uint16>(std::clamp(v, 0.0, 1.0) * 65535.0); };
        // Long duration; the host sends an explicit stop (0,0).
        SDL_GameControllerRumble(c, m(lo), m(hi), (lo > 0 || hi > 0) ? 10000 : 0);
      }
    }
  }

  void stateChanged() {
    updateTitle();
    emitControl(std::string("{\"t\":\"viewer-state\",\"kbm\":") + (kbm_ ? "true" : "false") +
                ",\"pad\":" + (pad_ ? "true" : "false") + ",\"pads\":" + std::to_string(controllerCount()) +
                ",\"capture\":" + (capture_ ? "true" : "false") +
                ",\"fullscreen\":" + (fullscreen_ ? "true" : "false") + "}");
  }

  void updateTitle() {
    if (!window_) return;
    std::string title = baseTitle_ + "  |  keyboard+mouse " + (kbm_ ? "ON" : "off");
    if (kbm_ && !hostKbm_) title += " (host blocked)";
    title += "  |  controllers " + std::string(pad_ ? "ON" : "off");
    if (controllerCount()) title += " (" + std::to_string(controllerCount()) + ")";
    if (pad_ && !hostPad_) title += " (host blocked)";
    if (capture_) title += "  |  GAME MODE";
    title += "  |  Ctrl+Alt+Shift: Q quit, M/G toggle, Z game mode, X fullscreen";
    SDL_SetWindowTitle(window_, title.c_str());
  }

  bool kbm_, pad_;
  bool hostKbm_ = true, hostPad_ = true;
  bool capture_ = false, fullscreen_ = false;
  std::string baseTitle_;
  SDL_Window* window_ = nullptr;
  SDL_Renderer* renderer_ = nullptr;
  int texW_ = 0, texH_ = 0;
  std::set<int> heldKeys_;
  std::set<std::string> heldButtons_;
  Pad pads_[4];
  bool hasAbs_ = false;
  double absX_ = 0, absY_ = 0;
  double relX_ = 0, relY_ = 0;
};

int Viewer::run(std::shared_ptr<SharedFrame> sharedOwner, bool vsync) {
  SharedFrame& shared = *sharedOwner;

  // Wait for the first frame so the window opens at the right size. Keep
  // pumping events meanwhile so the OS never considers us hung.
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
  while (!g_quit) {
    {
      std::lock_guard<std::mutex> lock(shared.mu);
      if (shared.dirty) break;
    }
    SDL_Event ev;
    while (SDL_PollEvent(&ev)) handleEvent(ev);  // e.g. controllers already plugged in
    if (std::chrono::steady_clock::now() > deadline) {
      fprintf(stderr, "no video received within 30s\n");
      g_quit = true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }

  SDL_Texture* texture = nullptr;
  bool textureYuv = false;
  if (!g_quit) {
    int w, h;
    {
      std::lock_guard<std::mutex> lock(shared.mu);
      w = shared.width;
      h = shared.height;
    }
    // Open at the stream size, shrunk to fit the current display if needed.
    SDL_Rect usable{0, 0, w, h};
    SDL_GetDisplayUsableBounds(0, &usable);
    const double fit = std::min({1.0, usable.w * 0.9 / w, usable.h * 0.9 / h});
    window_ = SDL_CreateWindow(baseTitle_.c_str(), SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
                               std::max(320, int(w * fit)), std::max(180, int(h * fit)),
                               SDL_WINDOW_RESIZABLE | SDL_WINDOW_ALLOW_HIGHDPI);
    if (!window_) {
      fprintf(stderr, "SDL_CreateWindow failed: %s\n", SDL_GetError());
      g_quit = true;
    } else {
      Uint32 rflags = SDL_RENDERER_ACCELERATED;
      if (vsync) rflags |= SDL_RENDERER_PRESENTVSYNC;
      renderer_ = SDL_CreateRenderer(window_, -1, rflags);
      if (!renderer_) renderer_ = SDL_CreateRenderer(window_, -1, SDL_RENDERER_SOFTWARE);
      if (!renderer_) {
        fprintf(stderr, "SDL_CreateRenderer failed: %s\n", SDL_GetError());
        g_quit = true;
      }
    }
    if (window_) SDL_RaiseWindow(window_);  // the UI starts us from a browser; come to the front
    updateTitle();
    stateChanged();
    // Controllers already plugged in arrive as CONTROLLERDEVICEADDED events.
  }

  uint64_t statsAt = nowUs(), presented = 0, lastPts = 0;
  double displaySum = 0, displayMax = 0, pipeSum = 0;
  while (!g_quit) {
    SDL_Event ev;
    while (SDL_PollEvent(&ev)) handleEvent(ev);
    flushMotion();

    bool present = false;
    uint64_t frameRecv = 0, frameDecoded = 0, framePts = 0;
    {
      std::unique_lock<std::mutex> lock(shared.mu);
      if (!shared.dirty && !g_quit) {
        shared.cv.wait_for(lock, std::chrono::milliseconds(2), [&] { return shared.dirty || g_quit.load(); });
      }
      if (shared.dirty && renderer_) {
        if (!texture || texW_ != shared.width || texH_ != shared.height || textureYuv != shared.yuv) {
          if (texture) SDL_DestroyTexture(texture);
          texture = SDL_CreateTexture(renderer_, shared.yuv ? SDL_PIXELFORMAT_IYUV : SDL_PIXELFORMAT_ARGB8888,
                                      SDL_TEXTUREACCESS_STREAMING, shared.width, shared.height);
          texW_ = shared.width;
          texH_ = shared.height;
          textureYuv = shared.yuv;
          SDL_RenderSetLogicalSize(renderer_, texW_, texH_);  // letterbox, keep aspect ratio
        }
        frameRecv = shared.recvUs;
        frameDecoded = shared.decodedUs;
        framePts = shared.pts;
        if (texture) {
          if (shared.yuv) {
            const size_t ySize = size_t(texW_) * texH_;
            const int cw = (texW_ + 1) / 2, ch = (texH_ + 1) / 2;
            const size_t cSize = size_t(cw) * ch;
            SDL_UpdateYUVTexture(texture, nullptr, shared.pixels.data(), texW_,
                                 shared.pixels.data() + ySize, cw, shared.pixels.data() + ySize + cSize, cw);
          } else {
            SDL_UpdateTexture(texture, nullptr, shared.pixels.data(), shared.width * 4);
          }
          present = true;
        }
        shared.dirty = false;
      }
    }

    if (present) {
      SDL_SetRenderDrawColor(renderer_, 0, 0, 0, 255);
      SDL_RenderClear(renderer_);
      SDL_RenderCopy(renderer_, texture, nullptr, nullptr);
      SDL_RenderPresent(renderer_);
      const uint64_t shown = nowUs();
      if (frameDecoded && shown >= frameDecoded) {
        const double ms = (shown - frameDecoded) / 1000.0;
        displaySum += ms;
        displayMax = std::max(displayMax, ms);
      }
      if (frameRecv && shown >= frameRecv) pipeSum += (shown - frameRecv) / 1000.0;
      lastPts = framePts;
      ++presented;
    }

    // Once a second: how long frames spend here (decode, then waiting for and
    // doing the upload + present). Node adds network and host timings.
    const uint64_t now = nowUs();
    if (now - statsAt >= 1000000) {
      double decodeAvg = 0;
      uint64_t replaced = 0;
      {
        std::lock_guard<std::mutex> lock(shared.mu);
        decodeAvg = shared.decoded ? shared.decodeMsSum / shared.decoded : 0;
        replaced = shared.replaced;
        shared.decodeMsSum = 0;
        shared.decoded = 0;
        shared.replaced = 0;
      }
      char buf[320];
      std::snprintf(buf, sizeof(buf),
                    "{\"t\":\"view-stats\",\"presented\":%llu,\"replaced\":%llu,\"decodeMs\":%.2f,"
                    "\"displayMs\":%.2f,\"displayMaxMs\":%.2f,\"viewerMs\":%.2f,\"vsync\":%s,\"pts\":%llu,\"now\":%llu}",
                    static_cast<unsigned long long>(presented), static_cast<unsigned long long>(replaced), decodeAvg,
                    presented ? displaySum / presented : 0.0, displayMax, presented ? pipeSum / presented : 0.0,
                    vsync ? "true" : "false", static_cast<unsigned long long>(lastPts),
                    static_cast<unsigned long long>(now));
      emitControl(buf);
      statsAt = now;
      presented = 0;
      displaySum = displayMax = pipeSum = 0;
    }
  }

  // Leave nothing held on the host when the window closes.
  releaseKeysAndButtons();
  for (int slot = 0; slot < 4; ++slot) {
    if (!pads_[slot].controller) continue;
    if (pad_) {
      neutralisePad(slot);
      emit("{\"t\":\"pad\",\"slot\":" + std::to_string(slot) + ",\"connected\":false}");
    }
    SDL_GameControllerClose(pads_[slot].controller);
  }
  if (texture) SDL_DestroyTexture(texture);
  if (renderer_) SDL_DestroyRenderer(renderer_);
  if (window_) SDL_DestroyWindow(window_);
  return 0;
}

}  // namespace

int runView(int argc, char** argv) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  bool kbm = true, pad = true, vsync = true;
  std::string title = "Penguin Stream";
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    if (a == "--no-input") kbm = pad = false;
    else if (a == "--no-kbm") kbm = false;
    else if (a == "--no-gamepad") pad = false;
    else if (a == "--title" && i + 1 < argc) title = argv[++i];
    else if (a == "--no-vsync" || a == "--low-latency") vsync = false;
  }

  SDL_SetHint(SDL_HINT_RENDER_VSYNC, vsync ? "1" : "0");
  SDL_SetHint(SDL_HINT_RENDER_SCALE_QUALITY, "linear");
  SDL_SetHint(SDL_HINT_VIDEO_MINIMIZE_ON_FOCUS_LOSS, "0");
  SDL_SetHint(SDL_HINT_WINDOWS_DPI_AWARENESS, "permonitorv2");
  SDL_SetHint(SDL_HINT_MOUSE_FOCUS_CLICKTHROUGH, "1");
  SDL_SetHint(SDL_HINT_GRAB_KEYBOARD, "1");  // keyboard grab includes system keys in game mode
  SDL_SetHint(SDL_HINT_MOUSE_RELATIVE_SCALING, "0");
  SDL_SetHint(SDL_HINT_JOYSTICK_HIDAPI_PS4_RUMBLE, "1");
  SDL_SetHint(SDL_HINT_JOYSTICK_HIDAPI_PS5_RUMBLE, "1");
  SDL_SetHint(SDL_HINT_ENABLE_SCREEN_KEYBOARD, "0");
#ifdef _WIN32
  SDL_SetMainReady();
#endif
  if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMECONTROLLER | SDL_INIT_JOYSTICK) != 0) {
    fprintf(stderr, "SDL_Init failed: %s\n", SDL_GetError());
    return 1;
  }
  SDL_SetYUVConversionMode(SDL_YUV_CONVERSION_BT601);  // matches the host's BGRA->YUV conversion
  g_controlEvent = SDL_RegisterEvents(1);

  auto shared = std::make_shared<SharedFrame>();

  // The reader may outlive the SDL loop while stdin blocks. Own all of its
  // state by value, never capture the returning runView stack by reference.
  std::thread reader([shared] {
    Decoder decoder;
    decoder.setYuvOutput(true);
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
          fprintf(stderr, "invalid media configuration\n");
          g_quit = true;
          return;
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
        const uint64_t recv = nowUs();
        decoder.decode(data, len, hdr.pts_us, [&](const DecodedFrame& f) {
          const uint64_t decoded = nowUs();
          std::lock_guard<std::mutex> lock(shared->mu);
          if (shared->dirty) ++shared->replaced;  // renderer had not shown the previous one yet
          shared->recvUs = recv;
          shared->decodedUs = decoded;
          shared->pts = f.pts_us;
          shared->decodeMsSum += (decoded - recv) / 1000.0;
          ++shared->decoded;
          if (f.bgra) {
            shared->yuv = false;
            shared->pixels.resize(size_t(f.width) * f.height * 4);
            for (int y = 0; y < f.height; ++y)
              memcpy(shared->pixels.data() + size_t(y) * f.width * 4, f.bgra + size_t(y) * f.stride,
                     size_t(f.width) * 4);
          } else {
            // Tightly pack Y, U, V for SDL_UpdateYUVTexture.
            const int cw = (f.width + 1) / 2, ch = (f.height + 1) / 2;
            const size_t ySize = size_t(f.width) * f.height, cSize = size_t(cw) * ch;
            shared->yuv = true;
            shared->pixels.resize(ySize + 2 * cSize);
            uint8_t* dst = shared->pixels.data();
            for (int y = 0; y < f.height; ++y)
              memcpy(dst + size_t(y) * f.width, f.planes[0] + size_t(y) * f.linesize[0], size_t(f.width));
            for (int p = 1; p < 3; ++p) {
              uint8_t* plane = dst + ySize + (p - 1) * cSize;
              for (int y = 0; y < ch; ++y)
                memcpy(plane + size_t(y) * cw, f.planes[p] + size_t(y) * f.linesize[p], size_t(cw));
            }
          }
          shared->width = f.width;
          shared->height = f.height;
          shared->dirty = true;
          shared->cv.notify_one();
        }, derr);
      } else if (msg.type == MsgType::Control) {
        SDL_Event ev{};
        ev.type = g_controlEvent;
        ev.user.data1 = new std::string(msg.payload.begin(), msg.payload.end());
        if (SDL_PushEvent(&ev) <= 0) delete static_cast<std::string*>(ev.user.data1);
      } else if (msg.type == MsgType::Shutdown) {
        g_quit = true;
        return;
      }
    }
    g_quit = true;  // pipe closed
  });

  Viewer viewer(kbm, pad, title);
  viewer.run(shared, vsync);

  g_quit = true;
  if (reader.joinable()) reader.detach();  // blocked on stdin; process exit reaps it
  SDL_Quit();
  return 0;
}

}  // namespace ps
