// Linux virtual Xbox 360 controllers through /dev/uinput.
//
// The device advertises the Xbox 360 USB ids and the same button/axis layout
// as the kernel xpad driver, so SDL, Steam and Proton recognise it as an
// ordinary XInput pad. Rumble effects uploaded by games are reported back so
// the viewer's physical controller can vibrate.
//
// Needs write access to /dev/uinput. Fedora's `steam-devices` package (and
// most gaming distros) grant it to the active seat user through udev.
#include "input/gamepad.h"

#include <fcntl.h>
#include <linux/input.h>
#include <linux/uinput.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace ps {
namespace {

using Clock = std::chrono::steady_clock;

int buttonCode(PadButton b) {
  switch (b) {
    case PadButton::A: return BTN_SOUTH;
    case PadButton::B: return BTN_EAST;
    case PadButton::X: return BTN_NORTH;   // xpad reports X as BTN_X == BTN_NORTH
    case PadButton::Y: return BTN_WEST;    // and Y as BTN_Y == BTN_WEST
    case PadButton::Back: return BTN_SELECT;
    case PadButton::Guide: return BTN_MODE;
    case PadButton::Start: return BTN_START;
    case PadButton::LeftStick: return BTN_THUMBL;
    case PadButton::RightStick: return BTN_THUMBR;
    case PadButton::LeftShoulder: return BTN_TL;
    case PadButton::RightShoulder: return BTN_TR;
    default: return -1;  // d-pad is a hat, handled separately
  }
}

struct Effect {
  bool used = false;
  double strong = 0, weak = 0;
  int lengthMs = 0;
};

struct Slot {
  int fd = -1;
  bool dpad[4] = {};  // up, down, left, right
  Effect effects[16];
  int playing = -1;
  Clock::time_point stopAt{};
};

bool emit(int fd, int type, int code, int value) {
  input_event ev{};
  ev.type = static_cast<__u16>(type);
  ev.code = static_cast<__u16>(code);
  ev.value = value;
  return write(fd, &ev, sizeof(ev)) == static_cast<ssize_t>(sizeof(ev));
}

bool absSetup(int fd, int code, int min, int max, int fuzz, int flat) {
  uinput_abs_setup a{};
  a.code = static_cast<__u16>(code);
  a.absinfo.minimum = min;
  a.absinfo.maximum = max;
  a.absinfo.fuzz = fuzz;
  a.absinfo.flat = flat;
  return ioctl(fd, UI_ABS_SETUP, &a) == 0;
}

int createDevice(int index, std::string& why) {
  const int fd = open("/dev/uinput", O_RDWR | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) {
    why = errno == EACCES || errno == EPERM
        ? "no permission to open /dev/uinput (install the steam-devices package or add a udev uaccess rule)"
        : std::string("cannot open /dev/uinput: ") + std::strerror(errno);
    return -1;
  }
  bool ok = ioctl(fd, UI_SET_EVBIT, EV_KEY) == 0 && ioctl(fd, UI_SET_EVBIT, EV_ABS) == 0 &&
            ioctl(fd, UI_SET_EVBIT, EV_SYN) == 0 && ioctl(fd, UI_SET_EVBIT, EV_FF) == 0 &&
            ioctl(fd, UI_SET_FFBIT, FF_RUMBLE) == 0;
  for (int code : {BTN_SOUTH, BTN_EAST, BTN_NORTH, BTN_WEST, BTN_TL, BTN_TR, BTN_SELECT,
                   BTN_START, BTN_MODE, BTN_THUMBL, BTN_THUMBR}) {
    ok = ok && ioctl(fd, UI_SET_KEYBIT, code) == 0;
  }
  for (int code : {ABS_X, ABS_Y, ABS_RX, ABS_RY, ABS_Z, ABS_RZ, ABS_HAT0X, ABS_HAT0Y}) {
    ok = ok && ioctl(fd, UI_SET_ABSBIT, code) == 0;
  }
  ok = ok && absSetup(fd, ABS_X, -32768, 32767, 16, 128) && absSetup(fd, ABS_Y, -32768, 32767, 16, 128) &&
       absSetup(fd, ABS_RX, -32768, 32767, 16, 128) && absSetup(fd, ABS_RY, -32768, 32767, 16, 128) &&
       absSetup(fd, ABS_Z, 0, 255, 0, 0) && absSetup(fd, ABS_RZ, 0, 255, 0, 0) &&
       absSetup(fd, ABS_HAT0X, -1, 1, 0, 0) && absSetup(fd, ABS_HAT0Y, -1, 1, 0, 0);

  uinput_setup setup{};
  std::snprintf(setup.name, sizeof(setup.name), "Penguin Stream X-Box 360 pad %d", index + 1);
  setup.id.bustype = BUS_USB;
  setup.id.vendor = 0x045e;   // Microsoft
  setup.id.product = 0x028e;  // Xbox 360 controller
  setup.id.version = 0x0114;
  setup.ff_effects_max = 16;
  ok = ok && ioctl(fd, UI_DEV_SETUP, &setup) == 0 && ioctl(fd, UI_DEV_CREATE) == 0;
  if (!ok) {
    why = std::string("uinput device setup failed: ") + std::strerror(errno);
    close(fd);
    return -1;
  }
  return fd;
}

class UinputPads final : public VirtualGamepads {
 public:
  explicit UinputPads(RumbleFn rumble) : rumble_(std::move(rumble)) {
    thread_ = std::thread([this] { runFeedback(); });
  }

  ~UinputPads() override {
    running_ = false;
    if (thread_.joinable()) thread_.join();
    unplugAll();
  }

  bool handle(const InputEvent& e) override {
    std::lock_guard<std::mutex> lock(mu_);
    if (e.slot < 0 || e.slot >= kMaxPads) return false;
    Slot& s = slots_[e.slot];
    if (e.kind == InputKind::PadState) {
      if (!e.connected) { unplug(e.slot); return true; }
      return plug(e.slot);
    }
    if (!plug(e.slot)) return false;
    bool ok = true;
    if (e.kind == InputKind::PadButton) {
      const int code = buttonCode(e.padButton);
      if (code >= 0) {
        ok = emit(s.fd, EV_KEY, code, e.down ? 1 : 0);
      } else {
        const int dir = static_cast<int>(e.padButton) - static_cast<int>(PadButton::DpadUp);
        if (dir < 0 || dir > 3) return false;
        s.dpad[dir] = e.down;
        ok = emit(s.fd, EV_ABS, ABS_HAT0Y, s.dpad[0] ? -1 : s.dpad[1] ? 1 : 0) &&
             emit(s.fd, EV_ABS, ABS_HAT0X, s.dpad[2] ? -1 : s.dpad[3] ? 1 : 0);
      }
    } else if (e.kind == InputKind::PadAxis) {
      const auto stick = [](double v) {
        const double c = std::clamp(v, -1.0, 1.0);
        return static_cast<int>(std::lround(c < 0 ? c * 32768.0 : c * 32767.0));
      };
      const auto trig = [](double v) { return static_cast<int>(std::lround(std::clamp(v, 0.0, 1.0) * 255.0)); };
      switch (e.padAxis) {
        case PadAxis::LeftX: ok = emit(s.fd, EV_ABS, ABS_X, stick(e.value)); break;
        case PadAxis::LeftY: ok = emit(s.fd, EV_ABS, ABS_Y, stick(e.value)); break;   // evdev: up is -
        case PadAxis::RightX: ok = emit(s.fd, EV_ABS, ABS_RX, stick(e.value)); break;
        case PadAxis::RightY: ok = emit(s.fd, EV_ABS, ABS_RY, stick(e.value)); break;
        case PadAxis::LeftTrigger: ok = emit(s.fd, EV_ABS, ABS_Z, trig(e.value)); break;
        case PadAxis::RightTrigger: ok = emit(s.fd, EV_ABS, ABS_RZ, trig(e.value)); break;
      }
    } else {
      return false;
    }
    return ok && emit(s.fd, EV_SYN, SYN_REPORT, 0);
  }

  void unplugAll() override {
    std::lock_guard<std::mutex> lock(mu_);
    for (int i = 0; i < kMaxPads; ++i) unplug(i);
  }

  int connectedCount() const override {
    std::lock_guard<std::mutex> lock(mu_);
    int n = 0;
    for (const Slot& s : slots_) n += s.fd >= 0 ? 1 : 0;
    return n;
  }

  const char* backend() const override { return "uinput"; }

  // Probe used by the factory: proves permission without leaving a device.
  static bool canOpen(std::string& why) {
    const int fd = open("/dev/uinput", O_RDWR | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) {
      why = errno == EACCES || errno == EPERM
          ? "no permission to open /dev/uinput (install the steam-devices package or add a udev uaccess rule)"
          : std::string("cannot open /dev/uinput: ") + std::strerror(errno);
      return false;
    }
    close(fd);
    return true;
  }

 private:
  bool plug(int i) {
    Slot& s = slots_[i];
    if (s.fd >= 0) return true;
    std::string why;
    s.fd = createDevice(i, why);
    return s.fd >= 0;
  }

  void unplug(int i) {
    Slot& s = slots_[i];
    if (s.fd < 0) return;
    for (int code : {ABS_X, ABS_Y, ABS_RX, ABS_RY, ABS_Z, ABS_RZ, ABS_HAT0X, ABS_HAT0Y}) emit(s.fd, EV_ABS, code, 0);
    for (int code : {BTN_SOUTH, BTN_EAST, BTN_NORTH, BTN_WEST, BTN_TL, BTN_TR, BTN_SELECT,
                     BTN_START, BTN_MODE, BTN_THUMBL, BTN_THUMBR}) emit(s.fd, EV_KEY, code, 0);
    emit(s.fd, EV_SYN, SYN_REPORT, 0);
    ioctl(s.fd, UI_DEV_DESTROY);
    close(s.fd);
    const bool wasPlaying = s.playing >= 0;
    s = Slot{};
    if (wasPlaying && rumble_) rumble_(i, 0, 0);
  }

  // Services force-feedback uploads/erases and play/stop requests.
  void runFeedback() {
    while (running_) {
      std::vector<pollfd> fds;
      {
        std::lock_guard<std::mutex> lock(mu_);
        for (const Slot& s : slots_) if (s.fd >= 0) fds.push_back(pollfd{s.fd, POLLIN, 0});
      }
      if (fds.empty()) { std::this_thread::sleep_for(std::chrono::milliseconds(20)); }
      else poll(fds.data(), fds.size(), 20);

      std::lock_guard<std::mutex> lock(mu_);
      const auto now = Clock::now();
      for (int i = 0; i < kMaxPads; ++i) {
        Slot& s = slots_[i];
        if (s.fd < 0) continue;
        input_event ev{};
        while (read(s.fd, &ev, sizeof(ev)) == static_cast<ssize_t>(sizeof(ev))) serviceEvent(i, ev);
        if (s.playing >= 0 && s.stopAt != Clock::time_point{} && now >= s.stopAt) {
          s.playing = -1;
          s.stopAt = {};
          if (rumble_) rumble_(i, 0, 0);
        }
      }
    }
  }

  void serviceEvent(int i, const input_event& ev) {
    Slot& s = slots_[i];
    if (ev.type == EV_UINPUT && ev.code == UI_FF_UPLOAD) {
      uinput_ff_upload up{};
      up.request_id = static_cast<__u32>(ev.value);
      if (ioctl(s.fd, UI_BEGIN_FF_UPLOAD, &up) != 0) return;
      const int id = up.effect.id;
      if (id >= 0 && id < 16) {
        Effect& fx = s.effects[id];
        fx.used = true;
        fx.lengthMs = up.effect.replay.length;
        if (up.effect.type == FF_RUMBLE) {
          fx.strong = up.effect.u.rumble.strong_magnitude / 65535.0;
          fx.weak = up.effect.u.rumble.weak_magnitude / 65535.0;
        } else {
          fx.strong = fx.weak = 0;
        }
        up.retval = 0;
      } else {
        up.retval = -EINVAL;
      }
      ioctl(s.fd, UI_END_FF_UPLOAD, &up);
    } else if (ev.type == EV_UINPUT && ev.code == UI_FF_ERASE) {
      uinput_ff_erase er{};
      er.request_id = static_cast<__u32>(ev.value);
      if (ioctl(s.fd, UI_BEGIN_FF_ERASE, &er) != 0) return;
      if (er.effect_id < 16) s.effects[er.effect_id] = Effect{};
      er.retval = 0;
      ioctl(s.fd, UI_END_FF_ERASE, &er);
    } else if (ev.type == EV_FF && ev.code < 16) {
      const Effect& fx = s.effects[ev.code];
      if (ev.value > 0 && fx.used) {
        s.playing = ev.code;
        s.stopAt = fx.lengthMs > 0 ? Clock::now() + std::chrono::milliseconds(fx.lengthMs) : Clock::time_point{};
        if (rumble_) rumble_(i, fx.strong, fx.weak);
      } else if (s.playing == ev.code) {
        s.playing = -1;
        s.stopAt = {};
        if (rumble_) rumble_(i, 0, 0);
      }
    }
  }

  RumbleFn rumble_;
  mutable std::mutex mu_;
  Slot slots_[kMaxPads];
  std::atomic<bool> running_{true};
  std::thread thread_;
};

}  // namespace

std::unique_ptr<VirtualGamepads> createVirtualGamepads(VirtualGamepads::RumbleFn rumble, std::string& why) {
  if (!UinputPads::canOpen(why)) return nullptr;
  return std::make_unique<UinputPads>(std::move(rumble));
}

bool probeVirtualGamepads(std::string& backend, std::string& why) {
  backend = "uinput";
  return UinputPads::canOpen(why);
}

}  // namespace ps
