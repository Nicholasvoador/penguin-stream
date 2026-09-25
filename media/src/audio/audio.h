#pragma once
// Desktop audio for the host (capture) and the viewer (playback).
//
// Wire format on stdio: raw interleaved signed 16-bit little-endian PCM,
// 48 kHz, stereo. Node frames it into authenticated AUDIO packets.
//
// App filtering is what makes voice chat usable: if host and viewer are in
// the same Discord call, streaming the host's Discord output would make the
// viewer hear everyone twice (and themselves). So capture can leave apps out.

#include <string>
#include <vector>

namespace ps {

constexpr int kAudioRate = 48000;
constexpr int kAudioChannels = 2;
constexpr int kAudioFrameBytes = 4;   // s16 stereo

struct AppFilter {
  bool excludeVoice = false;              // voice-chat apps and "Communication" streams
  std::vector<std::string> exclude;       // lower-case substrings of app/process names
  std::string only;                       // if set: capture just this app

  // name: any identifying string (app name, node name, process exe), any case.
  bool matchesExclude(const std::string& name, const std::string& role = "") const;
  bool matchesOnly(const std::string& name) const;
  static AppFilter fromArgs(int argc, char** argv);
  std::string describe() const;
};

std::string lowerAscii(std::string s);

int runAudioCapture(int argc, char** argv);   // platform specific
int runAudioPlay(int argc, char** argv);      // SDL, all platforms
// Short JSON object describing audio support, for `ps-media probe`.
std::string audioProbeJson();

}  // namespace ps
