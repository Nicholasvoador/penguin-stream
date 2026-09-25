#include "input/event.h"

#include <cmath>
#include <cstdlib>
#include <map>

namespace ps {
namespace {

struct Value {
  enum Kind { String, Number, Boolean } kind = String;
  std::string text;
  double number = 0;
};
using Fields = std::map<std::string, Value>;

// Small, strict flat-JSON subset: no nesting, escapes, duplicate fields,
// non-finite numbers or trailing junk. Strings are [a-z0-9_]+ only.
bool parseFlat(const std::string& json, Fields& fields) {
  if (json.empty() || json.size() > 1024) return false;
  size_t p = 0;
  auto ws = [&] {
    while (p < json.size() && (json[p] == ' ' || json[p] == '\t' || json[p] == '\r' || json[p] == '\n')) ++p;
  };
  auto take = [&](char c) {
    ws();
    if (p == json.size() || json[p] != c) return false;
    ++p;
    return true;
  };
  auto word = [&](std::string& s) {
    if (!take('"')) return false;
    const size_t begin = p;
    while (p < json.size() && ((json[p] >= 'a' && json[p] <= 'z') ||
                               (json[p] >= '0' && json[p] <= '9') || json[p] == '_')) ++p;
    s = json.substr(begin, p - begin);
    return !s.empty() && p < json.size() && json[p++] == '"';
  };
  if (!take('{')) return false;
  for (;;) {
    std::string key;
    if (fields.size() >= 8 || !word(key) || !take(':')) return false;
    ws();
    if (p == json.size()) return false;
    Value value;
    if (json[p] == '"') {
      value.kind = Value::String;
      if (!word(value.text)) return false;
    } else if (json.compare(p, 4, "true") == 0) {
      value.kind = Value::Boolean; value.number = 1; p += 4;
    } else if (json.compare(p, 5, "false") == 0) {
      value.kind = Value::Boolean; value.number = 0; p += 5;
    } else {
      value.kind = Value::Number;
      const size_t begin = p;
      auto digit = [&] { return p < json.size() && json[p] >= '0' && json[p] <= '9'; };
      if (p < json.size() && json[p] == '-') ++p;
      if (!digit()) return false;
      if (json[p] == '0') ++p; else while (digit()) ++p;
      if (p < json.size() && json[p] == '.') {
        ++p;
        if (!digit()) return false;
        while (digit()) ++p;
      }
      if (p < json.size() && (json[p] == 'e' || json[p] == 'E')) {
        ++p;
        if (p < json.size() && (json[p] == '+' || json[p] == '-')) ++p;
        if (!digit()) return false;
        while (digit()) ++p;
      }
      // from_chars for double is missing from some MinGW/libstdc++ builds;
      // strtod on a bounded, already-validated copy is equivalent here.
      const std::string text = json.substr(begin, p - begin);
      char* end = nullptr;
      value.number = std::strtod(text.c_str(), &end);
      if (end != text.c_str() + text.size() || !std::isfinite(value.number)) return false;
    }
    if (!fields.emplace(key, value).second) return false;
    ws();
    if (take('}')) { ws(); return p == json.size(); }
    if (!take(',')) return false;
  }
}

bool exactly(const Fields& f, std::initializer_list<const char*> keys) {
  if (f.size() != keys.size()) return false;
  for (const char* k : keys) if (!f.count(k)) return false;
  return true;
}

bool number(const Fields& f, const char* key, double lo, double hi, double& out) {
  const auto it = f.find(key);
  if (it == f.end() || it->second.kind != Value::Number) return false;
  out = it->second.number;
  return out >= lo && out <= hi;
}

bool integer(const Fields& f, const char* key, int lo, int hi, int& out) {
  double d = 0;
  if (!number(f, key, lo, hi, d) || std::floor(d) != d) return false;
  out = static_cast<int>(d);
  return true;
}

bool boolean(const Fields& f, const char* key, bool& out) {
  const auto it = f.find(key);
  if (it == f.end() || it->second.kind != Value::Boolean) return false;
  out = it->second.number == 1;
  return true;
}

bool string(const Fields& f, const char* key, std::string& out) {
  const auto it = f.find(key);
  if (it == f.end() || it->second.kind != Value::String) return false;
  out = it->second.text;
  return true;
}

bool mouseButton(const std::string& s, MouseButton& out) {
  static const std::map<std::string, MouseButton> m{
      {"left", MouseButton::Left}, {"middle", MouseButton::Middle}, {"right", MouseButton::Right},
      {"x1", MouseButton::X1}, {"x2", MouseButton::X2}};
  const auto it = m.find(s);
  if (it == m.end()) return false;
  out = it->second;
  return true;
}

bool padButton(const std::string& s, PadButton& out) {
  static const std::map<std::string, PadButton> m{
      {"a", PadButton::A}, {"b", PadButton::B}, {"x", PadButton::X}, {"y", PadButton::Y},
      {"back", PadButton::Back}, {"guide", PadButton::Guide}, {"start", PadButton::Start},
      {"ls", PadButton::LeftStick}, {"rs", PadButton::RightStick},
      {"lb", PadButton::LeftShoulder}, {"rb", PadButton::RightShoulder},
      {"dpad_up", PadButton::DpadUp}, {"dpad_down", PadButton::DpadDown},
      {"dpad_left", PadButton::DpadLeft}, {"dpad_right", PadButton::DpadRight}};
  const auto it = m.find(s);
  if (it == m.end()) return false;
  out = it->second;
  return true;
}

bool padAxis(const std::string& s, PadAxis& out) {
  static const std::map<std::string, PadAxis> m{
      {"ls_x", PadAxis::LeftX}, {"ls_y", PadAxis::LeftY}, {"rs_x", PadAxis::RightX},
      {"rs_y", PadAxis::RightY}, {"lt", PadAxis::LeftTrigger}, {"rt", PadAxis::RightTrigger}};
  const auto it = m.find(s);
  if (it == m.end()) return false;
  out = it->second;
  return true;
}

}  // namespace

bool parseInputEvent(const std::string& json, InputEvent& e) {
  e = InputEvent{};
  Fields f;
  if (!parseFlat(json, f)) return false;
  std::string t;
  if (!string(f, "t", t)) return false;

  if (t == "mousemove") {
    e.kind = InputKind::MouseAbs;
    e.hasPosition = true;
    return exactly(f, {"t", "x", "y"}) && number(f, "x", 0, 1, e.x) && number(f, "y", 0, 1, e.y);
  }
  if (t == "mouserel") {
    e.kind = InputKind::MouseRel;
    return exactly(f, {"t", "dx", "dy"}) && integer(f, "dx", -4096, 4096, e.dx) &&
           integer(f, "dy", -4096, 4096, e.dy);
  }
  if (t == "mousebutton") {
    e.kind = InputKind::MouseButton;
    std::string b;
    if (f.count("x") || f.count("y")) {
      if (!exactly(f, {"t", "button", "down", "x", "y"}) || !number(f, "x", 0, 1, e.x) ||
          !number(f, "y", 0, 1, e.y)) return false;
      e.hasPosition = true;
    } else if (!exactly(f, {"t", "button", "down"})) {
      return false;
    }
    return string(f, "button", b) && mouseButton(b, e.button) && boolean(f, "down", e.down);
  }
  if (t == "wheel") {
    e.kind = InputKind::Wheel;
    return exactly(f, {"t", "dx", "dy"}) && number(f, "dx", -100, 100, e.wheelX) &&
           number(f, "dy", -100, 100, e.wheelY);
  }
  if (t == "key") {
    e.kind = InputKind::Key;
    return exactly(f, {"t", "code", "down"}) && integer(f, "code", 1, 511, e.hid) &&
           boolean(f, "down", e.down);
  }
  if (t == "keyrepeat") {
    e.kind = InputKind::Key;
    e.down = true;
    e.repeat = true;
    return exactly(f, {"t", "code"}) && integer(f, "code", 1, 511, e.hid);
  }
  if (t == "pad_button") {
    e.kind = InputKind::PadButton;
    std::string b;
    return exactly(f, {"t", "slot", "button", "down"}) && integer(f, "slot", 0, kMaxPads - 1, e.slot) &&
           string(f, "button", b) && padButton(b, e.padButton) && boolean(f, "down", e.down);
  }
  if (t == "pad_axis") {
    e.kind = InputKind::PadAxis;
    std::string a;
    if (!exactly(f, {"t", "slot", "axis", "value"}) || !integer(f, "slot", 0, kMaxPads - 1, e.slot) ||
        !string(f, "axis", a) || !padAxis(a, e.padAxis)) return false;
    const bool trigger = e.padAxis == PadAxis::LeftTrigger || e.padAxis == PadAxis::RightTrigger;
    return number(f, "value", trigger ? 0 : -1, 1, e.value);
  }
  if (t == "pad") {
    e.kind = InputKind::PadState;
    return exactly(f, {"t", "slot", "connected"}) && integer(f, "slot", 0, kMaxPads - 1, e.slot) &&
           boolean(f, "connected", e.connected);
  }
  if (t == "release_all") {
    e.kind = InputKind::ReleaseAll;
    return exactly(f, {"t"});
  }
  return false;
}

}  // namespace ps
