// Physical key mapping: USB HID keyboard usage (identical to SDL scancodes)
// to each host OS's native physical key code.
//
// Physical keys, not characters: games bind to positions, and the host's own
// keyboard layout then decides which character a key produces. With matching
// layouts on both machines (e.g. ABNT2 <-> ABNT2) every key types exactly what
// is printed on it, including the extra ABNT2 "/?" key and keypad ".".
#pragma once

#include <cstdint>

namespace ps {

struct NativeKey {
  uint16_t evdev = 0;      // Linux input-event-codes KEY_*; 0 = unmapped
  uint16_t winScan = 0;    // Windows scan code set 1 make code; 0 = use winVk
  bool winExtended = false;// needs the E0 prefix (KEYEVENTF_EXTENDEDKEY)
  uint16_t winVk = 0;      // only for keys whose scan code is not injectable
};

// Returns false for usages this build does not map.
bool lookupHidKey(int hidUsage, NativeKey& out);

}  // namespace ps
