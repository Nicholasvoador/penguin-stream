// Canonical remote-input events.
//
// Node validates everything a viewer sends and re-serialises it as a small flat
// JSON object. The engine parses that again with a deliberately strict reader
// (no nesting, no escapes, ASCII identifiers only) so a bug on the Node side
// still cannot smuggle anything unexpected into an OS input API.
#pragma once

#include <cstdint>
#include <string>

namespace ps {

enum class InputKind {
  MouseAbs,     // x,y in 0..1 of the captured output
  MouseRel,     // dx,dy in host pixels (game / pointer-lock mode)
  MouseButton,  // button + down, optional absolute position
  Wheel,        // wheelX/wheelY in notches (fractions allowed)
  Key,          // USB HID usage (== SDL scancode) + down
  PadButton,    // slot + padButton + down
  PadAxis,      // slot + padAxis + value
  PadState,     // slot + connected
  ReleaseAll,   // internal only: never accepted from a peer (Node strips it)
};

enum class MouseButton { Left, Middle, Right, X1, X2 };

enum class PadButton {
  A, B, X, Y, Back, Guide, Start, LeftStick, RightStick,
  LeftShoulder, RightShoulder, DpadUp, DpadDown, DpadLeft, DpadRight,
};
constexpr int kPadButtonCount = 15;

enum class PadAxis { LeftX, LeftY, RightX, RightY, LeftTrigger, RightTrigger };
constexpr int kPadAxisCount = 6;
constexpr int kMaxPads = 4;

struct InputEvent {
  InputKind kind = InputKind::ReleaseAll;
  bool hasPosition = false;
  double x = 0, y = 0;         // MouseAbs / MouseButton(hasPosition)
  int dx = 0, dy = 0;          // MouseRel
  double wheelX = 0, wheelY = 0;
  MouseButton button = MouseButton::Left;
  bool down = false;
  int hid = 0;                 // Key
  bool repeat = false;         // Key: viewer auto-repeat (hosts that repeat themselves ignore it)
  int slot = 0;                // Pad*
  PadButton padButton = PadButton::A;
  PadAxis padAxis = PadAxis::LeftX;
  double value = 0;            // PadAxis: sticks -1..1, triggers 0..1
  bool connected = false;      // PadState
};

// Returns false for anything that is not exactly one of the canonical shapes.
bool parseInputEvent(const std::string& json, InputEvent& out);

inline bool isPadEvent(const InputEvent& e) {
  return e.kind == InputKind::PadButton || e.kind == InputKind::PadAxis ||
         e.kind == InputKind::PadState;
}

}  // namespace ps
