#include "input/keymap.h"

namespace ps {
namespace {

struct Row {
  uint16_t hid;
  uint16_t evdev;
  uint16_t winScan;
  bool ext;
  uint16_t winVk;
};

// Windows virtual keys used where a set-1 scan code cannot be injected
// unambiguously (Pause is an E1 sequence; NumLock shares 0x45 with it).
constexpr uint16_t kVkPause = 0x13;
constexpr uint16_t kVkNumLock = 0x90;
constexpr uint16_t kVkSnapshot = 0x2C;

// Sources: USB HID Usage Tables 1.4 (page 0x07), Linux input-event-codes.h,
// and the scan code set 1 table used by Windows (and SDL's windows_scancode_table).
constexpr Row kRows[] = {
    {4, 30, 0x1E, false, 0},   {5, 48, 0x30, false, 0},   {6, 46, 0x2E, false, 0},   // A B C
    {7, 32, 0x20, false, 0},   {8, 18, 0x12, false, 0},   {9, 33, 0x21, false, 0},   // D E F
    {10, 34, 0x22, false, 0},  {11, 35, 0x23, false, 0},  {12, 23, 0x17, false, 0},  // G H I
    {13, 36, 0x24, false, 0},  {14, 37, 0x25, false, 0},  {15, 38, 0x26, false, 0},  // J K L
    {16, 50, 0x32, false, 0},  {17, 49, 0x31, false, 0},  {18, 24, 0x18, false, 0},  // M N O
    {19, 25, 0x19, false, 0},  {20, 16, 0x10, false, 0},  {21, 19, 0x13, false, 0},  // P Q R
    {22, 31, 0x1F, false, 0},  {23, 20, 0x14, false, 0},  {24, 22, 0x16, false, 0},  // S T U
    {25, 47, 0x2F, false, 0},  {26, 17, 0x11, false, 0},  {27, 45, 0x2D, false, 0},  // V W X
    {28, 21, 0x15, false, 0},  {29, 44, 0x2C, false, 0},                             // Y Z
    {30, 2, 0x02, false, 0},   {31, 3, 0x03, false, 0},   {32, 4, 0x04, false, 0},   // 1 2 3
    {33, 5, 0x05, false, 0},   {34, 6, 0x06, false, 0},   {35, 7, 0x07, false, 0},   // 4 5 6
    {36, 8, 0x08, false, 0},   {37, 9, 0x09, false, 0},   {38, 10, 0x0A, false, 0},  // 7 8 9
    {39, 11, 0x0B, false, 0},                                                        // 0
    {40, 28, 0x1C, false, 0},  // Return
    {41, 1, 0x01, false, 0},   // Escape
    {42, 14, 0x0E, false, 0},  // Backspace
    {43, 15, 0x0F, false, 0},  // Tab
    {44, 57, 0x39, false, 0},  // Space
    {45, 12, 0x0C, false, 0},  // - _
    {46, 13, 0x0D, false, 0},  // = +
    {47, 26, 0x1A, false, 0},  // [ {   (ABNT2: ´ `)
    {48, 27, 0x1B, false, 0},  // ] }   (ABNT2: [ {)
    {49, 43, 0x2B, false, 0},  // \ |
    {50, 43, 0x2B, false, 0},  // ISO non-US # ~ (ABNT2: ] })
    {51, 39, 0x27, false, 0},  // ; :   (ABNT2: ç)
    {52, 40, 0x28, false, 0},  // ' "   (ABNT2: ~ ^)
    {53, 41, 0x29, false, 0},  // ` ~   (ABNT2: ' ")
    {54, 51, 0x33, false, 0},  // , <
    {55, 52, 0x34, false, 0},  // . >
    {56, 53, 0x35, false, 0},  // / ?   (ABNT2: ; :)
    {57, 58, 0x3A, false, 0},  // Caps Lock
    {58, 59, 0x3B, false, 0},  {59, 60, 0x3C, false, 0},  {60, 61, 0x3D, false, 0},  // F1-F3
    {61, 62, 0x3E, false, 0},  {62, 63, 0x3F, false, 0},  {63, 64, 0x40, false, 0},  // F4-F6
    {64, 65, 0x41, false, 0},  {65, 66, 0x42, false, 0},  {66, 67, 0x43, false, 0},  // F7-F9
    {67, 68, 0x44, false, 0},  {68, 87, 0x57, false, 0},  {69, 88, 0x58, false, 0},  // F10-F12
    {70, 99, 0, false, kVkSnapshot},   // Print Screen
    {71, 70, 0x46, false, 0},          // Scroll Lock
    {72, 119, 0, false, kVkPause},     // Pause
    {73, 110, 0x52, true, 0},  // Insert
    {74, 102, 0x47, true, 0},  // Home
    {75, 104, 0x49, true, 0},  // Page Up
    {76, 111, 0x53, true, 0},  // Delete
    {77, 107, 0x4F, true, 0},  // End
    {78, 109, 0x51, true, 0},  // Page Down
    {79, 106, 0x4D, true, 0},  // Right
    {80, 105, 0x4B, true, 0},  // Left
    {81, 108, 0x50, true, 0},  // Down
    {82, 103, 0x48, true, 0},  // Up
    {83, 69, 0, false, kVkNumLock},    // Num Lock
    {84, 98, 0x35, true, 0},   // KP /
    {85, 55, 0x37, false, 0},  // KP *
    {86, 74, 0x4A, false, 0},  // KP -
    {87, 78, 0x4E, false, 0},  // KP +
    {88, 96, 0x1C, true, 0},   // KP Enter
    {89, 79, 0x4F, false, 0},  {90, 80, 0x50, false, 0},  {91, 81, 0x51, false, 0},  // KP 1-3
    {92, 75, 0x4B, false, 0},  {93, 76, 0x4C, false, 0},  {94, 77, 0x4D, false, 0},  // KP 4-6
    {95, 71, 0x47, false, 0},  {96, 72, 0x48, false, 0},  {97, 73, 0x49, false, 0},  // KP 7-9
    {98, 82, 0x52, false, 0},  // KP 0
    {99, 83, 0x53, false, 0},  // KP . (ABNT2: KP ,)
    {100, 86, 0x56, false, 0}, // ISO \ | (ABNT2: \ |, left of Z)
    {101, 127, 0x5D, true, 0}, // Application / Menu
    {103, 117, 0x59, false, 0},// KP =
    {104, 183, 0x64, false, 0}, {105, 184, 0x65, false, 0}, {106, 185, 0x66, false, 0},  // F13-F15
    {107, 186, 0x67, false, 0}, {108, 187, 0x68, false, 0}, {109, 188, 0x69, false, 0},  // F16-F18
    {110, 189, 0x6A, false, 0}, {111, 190, 0x6B, false, 0}, {112, 191, 0x6C, false, 0},  // F19-F21
    {113, 192, 0x6D, false, 0}, {114, 193, 0x6E, false, 0}, {115, 194, 0x76, false, 0},  // F22-F24
    {127, 113, 0x20, true, 0}, // Mute
    {128, 115, 0x30, true, 0}, // Volume Up
    {129, 114, 0x2E, true, 0}, // Volume Down
    {133, 121, 0x7E, false, 0},// KP , (ABNT2 keypad ".")
    {135, 89, 0x73, false, 0}, // International1: ABNT2 "/ ?" key, JIS "ro"
    {136, 93, 0x70, false, 0}, // International2: Katakana/Hiragana
    {137, 124, 0x7D, false, 0},// International3: Yen
    {138, 92, 0x79, false, 0}, // International4: Henkan
    {139, 94, 0x7B, false, 0}, // International5: Muhenkan
    {224, 29, 0x1D, false, 0}, // Left Ctrl
    {225, 42, 0x2A, false, 0}, // Left Shift
    {226, 56, 0x38, false, 0}, // Left Alt
    {227, 125, 0x5B, true, 0}, // Left GUI (Windows / Super)
    {228, 97, 0x1D, true, 0},  // Right Ctrl
    {229, 54, 0x36, false, 0}, // Right Shift
    {230, 100, 0x38, true, 0}, // Right Alt / AltGr
    {231, 126, 0x5C, true, 0}, // Right GUI
    // SDL2 media-key scancodes (outside the HID keyboard page proper).
    {258, 163, 0x19, true, 0}, // Next track
    {259, 165, 0x10, true, 0}, // Previous track
    {260, 166, 0x24, true, 0}, // Stop
    {261, 164, 0x22, true, 0}, // Play/Pause
    {262, 113, 0x20, true, 0}, // Mute (SDL_SCANCODE_AUDIOMUTE)
};

}  // namespace

bool lookupHidKey(int hid, NativeKey& out) {
  for (const Row& r : kRows) {
    if (r.hid == hid) {
      out.evdev = r.evdev;
      out.winScan = r.winScan;
      out.winExtended = r.ext;
      out.winVk = r.winVk;
      return true;
    }
  }
  return false;
}

}  // namespace ps
