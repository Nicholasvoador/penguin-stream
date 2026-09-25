// Virtual game controllers on the host.
//
// Each viewer controller slot (0..3) becomes a real virtual Xbox 360 pad on the
// host, so games see an ordinary XInput/evdev controller rather than keyboard
// emulation. Windows uses the ViGEmBus driver; Linux uses /dev/uinput.
// Pads are plugged in lazily on first use and unplugged when the viewer
// disconnects the controller, turns controller forwarding off, or leaves.
#pragma once

#include "input/event.h"

#include <functional>
#include <memory>
#include <string>

namespace ps {

class VirtualGamepads {
 public:
  // (slot, low-frequency motor 0..1, high-frequency motor 0..1). Called from a
  // backend thread; the callee must be thread-safe and MUST NOT block: the
  // kernel/driver waits on this thread while a game uploads an effect.
  using RumbleFn = std::function<void(int, double, double)>;

  virtual ~VirtualGamepads() = default;

  // Accepts PadButton / PadAxis / PadState. Returns false if rejected.
  virtual bool handle(const InputEvent& event) = 0;
  // Neutral state + unplug every pad. Safe to call repeatedly.
  virtual void unplugAll() = 0;
  virtual int connectedCount() const = 0;
  virtual const char* backend() const = 0;
};

// Returns nullptr and a human-readable reason when this host cannot create
// virtual controllers (driver missing, no /dev/uinput permission, ...).
std::unique_ptr<VirtualGamepads> createVirtualGamepads(VirtualGamepads::RumbleFn rumble,
                                                       std::string& why);

// Cheap availability check for `ps-media probe` / doctor (creates no pads).
bool probeVirtualGamepads(std::string& backend, std::string& why);

}  // namespace ps
