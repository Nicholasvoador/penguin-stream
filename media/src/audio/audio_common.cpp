#include "audio/audio.h"

#include <algorithm>
#include <cstring>

namespace ps {

namespace {
// Voice/meeting apps whose output must not be echoed back to a participant.
const char* const kVoiceApps[] = {
  "discord", "vesktop", "webcord", "armcord", "legcord", "teamspeak", "ts3client", "mumble",
  "zoom", "teams", "skype", "slack", "whatsapp", "telegram", "signal", "element", "guilded",
};

std::vector<std::string> splitList(const std::string& s) {
  std::vector<std::string> out;
  size_t start = 0;
  while (start <= s.size()) {
    size_t end = s.find(',', start);
    if (end == std::string::npos) end = s.size();
    std::string item = s.substr(start, end - start);
    item.erase(0, item.find_first_not_of(" \t"));
    item.erase(item.find_last_not_of(" \t") + 1);
    if (!item.empty() && item.size() <= 64) out.push_back(lowerAscii(item));
    start = end + 1;
  }
  return out;
}
}  // namespace

std::string lowerAscii(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return c >= 'A' && c <= 'Z' ? c + 32 : c; });
  return s;
}

bool AppFilter::matchesExclude(const std::string& name, const std::string& role) const {
  const std::string n = lowerAscii(name);
  if (excludeVoice) {
    if (role == "Communication") return true;
    for (const char* v : kVoiceApps) if (n.find(v) != std::string::npos) return true;
  }
  for (const auto& e : exclude) if (n.find(e) != std::string::npos) return true;
  return false;
}

bool AppFilter::matchesOnly(const std::string& name) const {
  return !only.empty() && lowerAscii(name).find(only) != std::string::npos;
}

AppFilter AppFilter::fromArgs(int argc, char** argv) {
  AppFilter f;
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    if (a == "--exclude-voice") f.excludeVoice = true;
    else if (a == "--exclude" && i + 1 < argc) {
      for (auto& e : splitList(argv[++i])) if (f.exclude.size() < 32) f.exclude.push_back(e);
    } else if (a == "--only" && i + 1 < argc) {
      auto list = splitList(argv[++i]);
      if (!list.empty()) f.only = list.front();
    }
  }
  return f;
}

std::string AppFilter::describe() const {
  if (!only.empty()) return "only \"" + only + "\"";
  std::string d = "all apps";
  if (excludeVoice) d += " except voice chat";
  for (const auto& e : exclude) d += (excludeVoice || &e != &exclude.front() ? ", " : " except ") + e;
  return d;
}

}  // namespace ps
