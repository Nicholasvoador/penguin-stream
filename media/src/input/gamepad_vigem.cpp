// Windows virtual Xbox 360 controllers through the ViGEmBus driver.
#include "input/gamepad.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <ViGEm/Client.h>

#include <algorithm>
#include <cmath>
#include <mutex>

namespace ps {
namespace {

SHORT stick(double v, bool invert) {
  const double c = std::clamp(invert ? -v : v, -1.0, 1.0);
  return static_cast<SHORT>(std::lround(c < 0 ? c * 32768.0 : c * 32767.0));
}

BYTE trigger(double v) {
  return static_cast<BYTE>(std::lround(std::clamp(v, 0.0, 1.0) * 255.0));
}

USHORT buttonBit(PadButton b) {
  switch (b) {
    case PadButton::A: return XUSB_GAMEPAD_A;
    case PadButton::B: return XUSB_GAMEPAD_B;
    case PadButton::X: return XUSB_GAMEPAD_X;
    case PadButton::Y: return XUSB_GAMEPAD_Y;
    case PadButton::Back: return XUSB_GAMEPAD_BACK;
    case PadButton::Guide: return XUSB_GAMEPAD_GUIDE;
    case PadButton::Start: return XUSB_GAMEPAD_START;
    case PadButton::LeftStick: return XUSB_GAMEPAD_LEFT_THUMB;
    case PadButton::RightStick: return XUSB_GAMEPAD_RIGHT_THUMB;
    case PadButton::LeftShoulder: return XUSB_GAMEPAD_LEFT_SHOULDER;
    case PadButton::RightShoulder: return XUSB_GAMEPAD_RIGHT_SHOULDER;
    case PadButton::DpadUp: return XUSB_GAMEPAD_DPAD_UP;
    case PadButton::DpadDown: return XUSB_GAMEPAD_DPAD_DOWN;
    case PadButton::DpadLeft: return XUSB_GAMEPAD_DPAD_LEFT;
    case PadButton::DpadRight: return XUSB_GAMEPAD_DPAD_RIGHT;
  }
  return 0;
}

class VigemPads;

struct Slot {
  VigemPads* owner = nullptr;
  int index = 0;
  PVIGEM_TARGET target = nullptr;
  XUSB_REPORT report{};
};

class VigemPads final : public VirtualGamepads {
 public:
  VigemPads(PVIGEM_CLIENT client, RumbleFn rumble) : client_(client), rumble_(std::move(rumble)) {
    for (int i = 0; i < kMaxPads; ++i) { slots_[i].owner = this; slots_[i].index = i; }
  }

  ~VigemPads() override {
    unplugAll();
    vigem_disconnect(client_);
    vigem_free(client_);
  }

  bool handle(const InputEvent& e) override {
    std::lock_guard<std::mutex> lock(mu_);
    if (e.slot < 0 || e.slot >= kMaxPads) return false;
    Slot& s = slots_[e.slot];
    if (e.kind == InputKind::PadState) {
      if (!e.connected) { unplug(s); return true; }
      return plug(s);
    }
    if (!plug(s)) return false;
    if (e.kind == InputKind::PadButton) {
      const USHORT bit = buttonBit(e.padButton);
      if (e.down) s.report.wButtons |= bit; else s.report.wButtons &= static_cast<USHORT>(~bit);
    } else if (e.kind == InputKind::PadAxis) {
      switch (e.padAxis) {
        case PadAxis::LeftX: s.report.sThumbLX = stick(e.value, false); break;
        case PadAxis::LeftY: s.report.sThumbLY = stick(e.value, true); break;   // XInput: up is +
        case PadAxis::RightX: s.report.sThumbRX = stick(e.value, false); break;
        case PadAxis::RightY: s.report.sThumbRY = stick(e.value, true); break;
        case PadAxis::LeftTrigger: s.report.bLeftTrigger = trigger(e.value); break;
        case PadAxis::RightTrigger: s.report.bRightTrigger = trigger(e.value); break;
      }
    } else {
      return false;
    }
    return VIGEM_SUCCESS(vigem_target_x360_update(client_, s.target, s.report));
  }

  void unplugAll() override {
    std::lock_guard<std::mutex> lock(mu_);
    for (Slot& s : slots_) unplug(s);
  }

  int connectedCount() const override {
    std::lock_guard<std::mutex> lock(mu_);
    int n = 0;
    for (const Slot& s : slots_) n += s.target ? 1 : 0;
    return n;
  }

  const char* backend() const override { return "vigem"; }

 private:
  static VOID CALLBACK onNotification(PVIGEM_CLIENT, PVIGEM_TARGET, UCHAR large, UCHAR small,
                                      UCHAR /*led*/, LPVOID user) {
    auto* slot = static_cast<Slot*>(user);
    if (slot && slot->owner && slot->owner->rumble_) {
      slot->owner->rumble_(slot->index, large / 255.0, small / 255.0);
    }
  }

  bool plug(Slot& s) {
    if (s.target) return true;
    PVIGEM_TARGET t = vigem_target_x360_alloc();
    if (!t) return false;
    if (!VIGEM_SUCCESS(vigem_target_add(client_, t))) { vigem_target_free(t); return false; }
    s.target = t;
    XUSB_REPORT_INIT(&s.report);
    vigem_target_x360_register_notification(client_, t, &VigemPads::onNotification, &s);
    return true;
  }

  void unplug(Slot& s) {
    if (!s.target) return;
    XUSB_REPORT_INIT(&s.report);
    vigem_target_x360_update(client_, s.target, s.report);  // neutral before removal
    vigem_target_x360_unregister_notification(s.target);
    vigem_target_remove(client_, s.target);
    vigem_target_free(s.target);
    s.target = nullptr;
    if (rumble_) rumble_(s.index, 0, 0);
  }

  PVIGEM_CLIENT client_;
  RumbleFn rumble_;
  mutable std::mutex mu_;
  Slot slots_[kMaxPads];
};

}  // namespace

std::unique_ptr<VirtualGamepads> createVirtualGamepads(VirtualGamepads::RumbleFn rumble, std::string& why) {
  PVIGEM_CLIENT client = vigem_alloc();
  if (!client) { why = "out of memory"; return nullptr; }
  const VIGEM_ERROR err = vigem_connect(client);
  if (!VIGEM_SUCCESS(err)) {
    vigem_free(client);
    why = err == VIGEM_ERROR_BUS_NOT_FOUND
        ? "the ViGEmBus driver is not installed (get it from https://github.com/nefarius/ViGEmBus/releases)"
        : "could not connect to the ViGEmBus driver (error " + std::to_string(static_cast<unsigned>(err)) + ")";
    return nullptr;
  }
  return std::make_unique<VigemPads>(client, std::move(rumble));
}

bool probeVirtualGamepads(std::string& backend, std::string& why) {
  backend = "vigem";
  auto pads = createVirtualGamepads(nullptr, why);
  return pads != nullptr;
}

}  // namespace ps
