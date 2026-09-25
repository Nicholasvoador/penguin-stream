// Length-prefixed message framing between the Node process and this engine.
//
// stdio is used rather than a unix socket so the exact same code path works on
// Windows, where AF_UNIX support is inconsistent across versions.
//
// Wire format (little-endian):
//   u32 payload_length        // does not include these 4 bytes
//   u8  type
//   u8[payload_length - 1] payload
#pragma once

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace ps {

enum class MsgType : uint8_t {
  VideoPacket = 0x01,  // engine -> node
  Config      = 0x02,  // engine -> node (JSON: codec, width, height, extradata)
  Control     = 0x03,  // both directions (JSON: keyframe, bitrate, permissions, rumble, viewer state)
  Input       = 0x04,  // both directions (JSON input event)
  Log         = 0x05,  // engine -> node (UTF-8 text)
  Stats       = 0x06,  // engine -> node (JSON)
  Shutdown    = 0x07,
};

// Guards against a corrupt or hostile length prefix allocating unbounded memory.
constexpr uint32_t kMaxMessageBytes = 16u * 1024u * 1024u;

struct Message {
  MsgType type{};
  std::vector<uint8_t> payload;
};

// Video packet payload: u64 pts (microseconds), u32 flags, then the bitstream.
struct VideoPacketHeader {
  uint64_t pts_us;
  uint32_t flags;
};
constexpr uint32_t kFlagKeyframe = 1u << 0;

// Blocking write of one framed message. Returns false on a broken pipe.
bool writeMessage(FILE* out, MsgType type, const uint8_t* data, size_t len);
bool writeJson(FILE* out, MsgType type, const std::string& json);
bool writeLog(FILE* out, const std::string& text);
bool writeVideoPacket(FILE* out, uint64_t pts_us, uint32_t flags,
                      const uint8_t* data, size_t len);

// Blocking read of one framed message.
// Returns false on clean EOF or on a malformed frame (err is set for the latter).
bool readMessage(FILE* in, Message& out, std::string* err);

// Helpers for the video packet payload.
bool parseVideoPacket(const std::vector<uint8_t>& payload, VideoPacketHeader& hdr,
                      const uint8_t** data, size_t* len);

// Minimal JSON string escaping; we only ever emit flat objects of our own making.
std::string jsonEscape(const std::string& in);

// Extremely small JSON field readers, sufficient for the flat control messages
// we exchange. Not a general parser - returns false if the key is absent.
bool jsonGetString(const std::string& json, const std::string& key, std::string& out);
bool jsonGetNumber(const std::string& json, const std::string& key, double& out);
bool jsonGetBool(const std::string& json, const std::string& key, bool& out);

}  // namespace ps
