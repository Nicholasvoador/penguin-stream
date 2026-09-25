// Host desktop audio on Linux (PipeWire), with per-app exclusion.
//
// Instead of recording a sink's monitor (which mixes every app together and
// cannot leave one out), we create our own capture stream that is NOT
// auto-connected, and link each app's playback ports to it ourselves. An
// output port can feed several inputs, so apps keep playing to the user's
// speakers untouched; excluded apps (e.g. Discord) are simply never linked.
// PipeWire mixes everything linked into our input and converts to 48 kHz s16.
// Our links are owned by this client and vanish when it exits.

#include "audio/audio.h"

#include <pipewire/pipewire.h>
#include <spa/param/audio/format-utils.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <condition_variable>
#include <csignal>
#include <cstdio>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace ps {

namespace {

std::atomic<bool> g_stop{false};
void onSignal(int) { g_stop = true; }

struct NodeInfo {
  std::string cls, app, name, role;
  std::string label() const { return !app.empty() ? app : name; }
};
struct PortInfo {
  uint32_t node = 0;
  bool out = false;
  std::string channel;
};

struct Capture {
  AppFilter filter;
  pw_thread_loop* loop = nullptr;
  pw_context* context = nullptr;
  pw_core* core = nullptr;
  pw_registry* registry = nullptr;
  pw_stream* stream = nullptr;
  spa_hook registryListener{}, streamListener{};

  std::map<uint32_t, NodeInfo> nodes;
  std::map<uint32_t, PortInfo> ports;
  std::map<std::pair<uint32_t, uint32_t>, pw_proxy*> links;   // (out port, our in port)
  std::set<uint32_t> reported;                                  // nodes already logged

  // PCM handed from the PipeWire thread to the writer (main) thread.
  std::mutex mu;
  std::condition_variable cv;
  std::vector<uint8_t> pending;

  uint32_t ourNode() const { return stream ? pw_stream_get_node_id(stream) : SPA_ID_INVALID; }

  // Which of our two inputs an app channel should feed.
  static std::vector<std::string> targetsFor(const std::string& ch) {
    if (ch == "FL" || ch == "RL" || ch == "SL" || ch == "FLC") return {"FL"};
    if (ch == "FR" || ch == "RR" || ch == "SR" || ch == "FRC") return {"FR"};
    if (ch == "LFE") return {};
    return {"FL", "FR"};   // MONO, FC, unknown
  }

  bool wanted(uint32_t nodeId, const NodeInfo& n) {
    bool ok;
    if (!filter.only.empty()) ok = filter.matchesOnly(n.app) || filter.matchesOnly(n.name);
    // Never re-capture our own viewer playback: that would be a feedback loop.
    else ok = n.app != "Penguin Stream" && !(filter.matchesExclude(n.app, n.role) || filter.matchesExclude(n.name));
    if (reported.insert(nodeId).second) {
      fprintf(stderr, "audio: %s \"%s\"\n", ok ? "streaming" : "leaving out", n.label().c_str());
    }
    return ok;
  }

  void relink() {
    const uint32_t self = ourNode();
    if (self == SPA_ID_INVALID) return;
    std::map<std::string, uint32_t> inputs;
    for (const auto& [id, p] : ports) {
      if (p.node == self && !p.out) inputs[p.channel] = id;
    }
    if (inputs.empty()) return;
    for (const auto& [portId, p] : ports) {
      if (!p.out || p.node == self) continue;
      auto n = nodes.find(p.node);
      if (n == nodes.end() || n->second.cls != "Stream/Output/Audio") continue;
      if (!wanted(p.node, n->second)) continue;
      for (const auto& ch : targetsFor(p.channel)) {
        auto in = inputs.find(ch);
        if (in == inputs.end()) continue;
        const auto key = std::make_pair(portId, in->second);
        if (links.count(key)) continue;
        const std::string outStr = std::to_string(portId), inStr = std::to_string(in->second);
        pw_properties* props = pw_properties_new(
            PW_KEY_LINK_OUTPUT_PORT, outStr.c_str(), PW_KEY_LINK_INPUT_PORT, inStr.c_str(),
            PW_KEY_OBJECT_LINGER, "false", nullptr);
        auto* proxy = static_cast<pw_proxy*>(pw_core_create_object(
            core, "link-factory", PW_TYPE_INTERFACE_Link, PW_VERSION_LINK, &props->dict, 0));
        pw_properties_free(props);
        if (proxy) links[key] = proxy;
      }
    }
  }

  // ---- registry ----
  static void onGlobal(void* data, uint32_t id, uint32_t, const char* type, uint32_t, const spa_dict* props) {
    auto* self = static_cast<Capture*>(data);
    if (!props) return;
    auto get = [&](const char* k) { const char* v = spa_dict_lookup(props, k); return std::string(v ? v : ""); };
    if (strcmp(type, PW_TYPE_INTERFACE_Node) == 0) {
      self->nodes[id] = NodeInfo{get(PW_KEY_MEDIA_CLASS), get(PW_KEY_APP_NAME), get(PW_KEY_NODE_NAME), get(PW_KEY_MEDIA_ROLE)};
    } else if (strcmp(type, PW_TYPE_INTERFACE_Port) == 0) {
      const std::string node = get(PW_KEY_NODE_ID);
      if (node.empty()) return;
      self->ports[id] = PortInfo{uint32_t(std::stoul(node)), get(PW_KEY_PORT_DIRECTION) == "out", get(PW_KEY_AUDIO_CHANNEL)};
    } else {
      return;
    }
    self->relink();
  }

  static void onGlobalRemove(void* data, uint32_t id) {
    auto* self = static_cast<Capture*>(data);
    self->nodes.erase(id);
    self->reported.erase(id);
    if (self->ports.erase(id)) {
      for (auto it = self->links.begin(); it != self->links.end();) {
        if (it->first.first == id || it->first.second == id) {
          pw_proxy_destroy(it->second);
          it = self->links.erase(it);
        } else {
          ++it;
        }
      }
    }
  }

  // ---- stream ----
  static void onProcess(void* data) {
    auto* self = static_cast<Capture*>(data);
    pw_buffer* b = pw_stream_dequeue_buffer(self->stream);
    if (!b) return;
    spa_buffer* buf = b->buffer;
    if (buf->datas[0].data && buf->datas[0].chunk) {
      const auto* p = static_cast<const uint8_t*>(buf->datas[0].data) + buf->datas[0].chunk->offset;
      const uint32_t size = buf->datas[0].chunk->size;
      std::lock_guard<std::mutex> lock(self->mu);
      // Never let a stalled reader turn into latency: keep at most ~200 ms.
      if (self->pending.size() + size > size_t(kAudioRate / 5 * kAudioFrameBytes)) self->pending.clear();
      self->pending.insert(self->pending.end(), p, p + size);
      self->cv.notify_one();
    }
    pw_stream_queue_buffer(self->stream, b);
  }

  static void onStateChanged(void* data, pw_stream_state, pw_stream_state state, const char* error) {
    auto* self = static_cast<Capture*>(data);
    if (state == PW_STREAM_STATE_ERROR) {
      fprintf(stderr, "audio: stream error: %s\n", error ? error : "unknown");
      g_stop = true;
      self->cv.notify_one();
    }
    // Our ports may have appeared before the node id was known.
    self->relink();
  }
};

const pw_registry_events kRegistryEvents = [] {
  pw_registry_events e{};
  e.version = PW_VERSION_REGISTRY_EVENTS;
  e.global = Capture::onGlobal;
  e.global_remove = Capture::onGlobalRemove;
  return e;
}();

const pw_stream_events kStreamEvents = [] {
  pw_stream_events e{};
  e.version = PW_VERSION_STREAM_EVENTS;
  e.process = Capture::onProcess;
  e.state_changed = Capture::onStateChanged;
  return e;
}();

}  // namespace

int runAudioCapture(int argc, char** argv) {
  std::signal(SIGINT, onSignal);
  std::signal(SIGTERM, onSignal);
  std::signal(SIGPIPE, SIG_IGN);

  Capture cap;
  cap.filter = AppFilter::fromArgs(argc, argv);

  pw_init(nullptr, nullptr);
  cap.loop = pw_thread_loop_new("ps-audio", nullptr);
  if (!cap.loop) { fprintf(stderr, "audio: pw_thread_loop_new failed\n"); return 1; }
  pw_thread_loop_lock(cap.loop);
  cap.context = pw_context_new(pw_thread_loop_get_loop(cap.loop), nullptr, 0);
  cap.core = cap.context ? pw_context_connect(cap.context, nullptr, 0) : nullptr;
  if (!cap.core) {
    pw_thread_loop_unlock(cap.loop);
    fprintf(stderr, "audio: cannot connect to PipeWire\n");
    return 1;
  }

  cap.stream = pw_stream_new(cap.core, "Penguin Stream",
      pw_properties_new(PW_KEY_MEDIA_TYPE, "Audio", PW_KEY_MEDIA_CATEGORY, "Capture",
                        PW_KEY_MEDIA_ROLE, "Screen", PW_KEY_APP_NAME, "Penguin Stream",
                        PW_KEY_NODE_NAME, "penguin-stream-audio",
                        PW_KEY_NODE_DESCRIPTION, "Penguin Stream (streamed desktop audio)",
                        PW_KEY_NODE_AUTOCONNECT, "false", PW_KEY_NODE_LATENCY, "240/48000", nullptr));
  pw_stream_add_listener(cap.stream, &cap.streamListener, &kStreamEvents, &cap);

  uint8_t podBuf[1024];
  spa_pod_builder builder = SPA_POD_BUILDER_INIT(podBuf, sizeof(podBuf));
  spa_audio_info_raw info{};
  info.format = SPA_AUDIO_FORMAT_S16_LE;
  info.rate = kAudioRate;
  info.channels = kAudioChannels;
  info.position[0] = SPA_AUDIO_CHANNEL_FL;
  info.position[1] = SPA_AUDIO_CHANNEL_FR;
  const spa_pod* params[1] = {spa_format_audio_raw_build(&builder, SPA_PARAM_EnumFormat, &info)};
  if (pw_stream_connect(cap.stream, PW_DIRECTION_INPUT, PW_ID_ANY,
                        static_cast<pw_stream_flags>(PW_STREAM_FLAG_MAP_BUFFERS), params, 1) < 0) {
    pw_thread_loop_unlock(cap.loop);
    fprintf(stderr, "audio: pw_stream_connect failed\n");
    return 1;
  }

  cap.registry = pw_core_get_registry(cap.core, PW_VERSION_REGISTRY, 0);
  pw_registry_add_listener(cap.registry, &cap.registryListener, &kRegistryEvents, &cap);
  pw_thread_loop_start(cap.loop);
  pw_thread_loop_unlock(cap.loop);
  fprintf(stderr, "audio: capturing %s via PipeWire\n", cap.filter.describe().c_str());

  std::vector<uint8_t> out;
  bool ok = true;
  while (!g_stop && ok) {
    {
      std::unique_lock<std::mutex> lock(cap.mu);
      cap.cv.wait_for(lock, std::chrono::milliseconds(200), [&] { return !cap.pending.empty() || g_stop.load(); });
      out.swap(cap.pending);
      cap.pending.clear();
    }
    if (!out.empty()) {
      ok = fwrite(out.data(), 1, out.size(), stdout) == out.size() && fflush(stdout) == 0;
      out.clear();
    }
  }

  pw_thread_loop_lock(cap.loop);
  for (auto& [key, proxy] : cap.links) pw_proxy_destroy(proxy);
  cap.links.clear();
  pw_stream_destroy(cap.stream);
  pw_proxy_destroy(reinterpret_cast<pw_proxy*>(cap.registry));
  pw_core_disconnect(cap.core);
  pw_thread_loop_unlock(cap.loop);
  pw_thread_loop_stop(cap.loop);
  pw_context_destroy(cap.context);
  pw_thread_loop_destroy(cap.loop);
  pw_deinit();
  return 0;
}

std::string audioProbeJson() {
  return "{\"capture\":\"pipewire\",\"appFilter\":true,\"play\":\"sdl\"}";
}

}  // namespace ps
