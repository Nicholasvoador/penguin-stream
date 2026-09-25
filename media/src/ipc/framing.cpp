#include "ipc/framing.h"

#include <cstring>
#include <mutex>

namespace ps {
namespace {

void putU32(uint8_t* p, uint32_t v) {
  p[0] = static_cast<uint8_t>(v & 0xff);
  p[1] = static_cast<uint8_t>((v >> 8) & 0xff);
  p[2] = static_cast<uint8_t>((v >> 16) & 0xff);
  p[3] = static_cast<uint8_t>((v >> 24) & 0xff);
}

uint32_t getU32(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

void putU64(uint8_t* p, uint64_t v) {
  for (int i = 0; i < 8; ++i) p[i] = static_cast<uint8_t>((v >> (8 * i)) & 0xff);
}

uint64_t getU64(const uint8_t* p) {
  uint64_t v = 0;
  for (int i = 0; i < 8; ++i) v |= static_cast<uint64_t>(p[i]) << (8 * i);
  return v;
}

// Messages may be produced by several threads (video, input feedback, rumble);
// each framed message must reach the pipe contiguously.
std::mutex& outputMutex() {
  static std::mutex mu;
  return mu;
}

}  // namespace

bool writeMessage(FILE* out, MsgType type, const uint8_t* data, size_t len) {
  const uint64_t payload = static_cast<uint64_t>(len) + 1;  // +1 for the type byte
  if (payload > kMaxMessageBytes) return false;

  uint8_t header[5];
  putU32(header, static_cast<uint32_t>(payload));
  header[4] = static_cast<uint8_t>(type);

  std::lock_guard<std::mutex> lock(outputMutex());
  if (fwrite(header, 1, sizeof(header), out) != sizeof(header)) return false;
  if (len > 0 && fwrite(data, 1, len, out) != len) return false;
  return fflush(out) == 0;
}

bool writeJson(FILE* out, MsgType type, const std::string& json) {
  return writeMessage(out, type, reinterpret_cast<const uint8_t*>(json.data()), json.size());
}

bool writeLog(FILE* out, const std::string& text) {
  return writeMessage(out, MsgType::Log, reinterpret_cast<const uint8_t*>(text.data()), text.size());
}

bool writeVideoPacket(FILE* out, uint64_t pts_us, uint32_t flags,
                      const uint8_t* data, size_t len) {
  const uint64_t payload = static_cast<uint64_t>(len) + 1 + 12;
  if (payload > kMaxMessageBytes) return false;

  uint8_t header[5 + 12];
  putU32(header, static_cast<uint32_t>(payload));
  header[4] = static_cast<uint8_t>(MsgType::VideoPacket);
  putU64(header + 5, pts_us);
  putU32(header + 13, flags);

  std::lock_guard<std::mutex> lock(outputMutex());
  if (fwrite(header, 1, sizeof(header), out) != sizeof(header)) return false;
  if (len > 0 && fwrite(data, 1, len, out) != len) return false;
  return fflush(out) == 0;
}

bool readMessage(FILE* in, Message& out, std::string* err) {
  uint8_t header[5];
  const size_t got = fread(header, 1, sizeof(header), in);
  if (got == 0) return false;  // clean EOF
  if (got != sizeof(header)) {
    if (err) *err = "truncated message header";
    return false;
  }

  const uint32_t payloadLen = getU32(header);
  if (payloadLen < 1 || payloadLen > kMaxMessageBytes) {
    if (err) *err = "message length out of range";
    return false;
  }

  out.type = static_cast<MsgType>(header[4]);
  out.payload.resize(payloadLen - 1);
  if (!out.payload.empty() &&
      fread(out.payload.data(), 1, out.payload.size(), in) != out.payload.size()) {
    if (err) *err = "truncated message payload";
    return false;
  }
  return true;
}

bool parseVideoPacket(const std::vector<uint8_t>& payload, VideoPacketHeader& hdr,
                      const uint8_t** data, size_t* len) {
  if (payload.size() < 12) return false;
  hdr.pts_us = getU64(payload.data());
  hdr.flags = getU32(payload.data() + 8);
  *data = payload.data() + 12;
  *len = payload.size() - 12;
  return true;
}

std::string jsonEscape(const std::string& in) {
  std::string out;
  out.reserve(in.size() + 8);
  for (char c : in) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += c;
        }
    }
  }
  return out;
}

bool jsonGetString(const std::string& json, const std::string& key, std::string& out) {
  const std::string needle = "\"" + key + "\"";
  size_t p = json.find(needle);
  if (p == std::string::npos) return false;
  p = json.find(':', p + needle.size());
  if (p == std::string::npos) return false;
  p = json.find('"', p);
  if (p == std::string::npos) return false;
  ++p;
  std::string val;
  while (p < json.size() && json[p] != '"') {
    if (json[p] == '\\' && p + 1 < json.size()) {
      ++p;
      switch (json[p]) {
        case 'n': val += '\n'; break;
        case 't': val += '\t'; break;
        case 'r': val += '\r'; break;
        default: val += json[p];
      }
    } else {
      val += json[p];
    }
    ++p;
  }
  out = val;
  return true;
}

bool jsonGetNumber(const std::string& json, const std::string& key, double& out) {
  const std::string needle = "\"" + key + "\"";
  size_t p = json.find(needle);
  if (p == std::string::npos) return false;
  p = json.find(':', p + needle.size());
  if (p == std::string::npos) return false;
  ++p;
  try {
    out = std::stod(json.substr(p, 64));
  } catch (...) {
    return false;
  }
  return true;
}

bool jsonGetBool(const std::string& json, const std::string& key, bool& out) {
  const std::string needle = "\"" + key + "\"";
  size_t p = json.find(needle);
  if (p == std::string::npos) return false;
  p = json.find(':', p + needle.size());
  if (p == std::string::npos) return false;
  p = json.find_first_not_of(" \t", p + 1);
  if (p == std::string::npos) return false;
  if (json.compare(p, 4, "true") == 0) { out = true; return true; }
  if (json.compare(p, 5, "false") == 0) { out = false; return true; }
  return false;
}

}  // namespace ps
