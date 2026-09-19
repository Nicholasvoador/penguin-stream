// Wayland screen capture via xdg-desktop-portal ScreenCast + PipeWire.
//
// This is the only sanctioned way to capture a Wayland desktop, and it is what
// KDE and GNOME actually implement. There is no way around the consent dialog,
// and that is a feature: the user explicitly picks what gets shared, every
// time, in a prompt the compositor controls rather than us.
//
// Flow (all of it is required, in this order):
//   CreateSession -> SelectSources -> Start  (each returns a Request object
//   whose Response signal carries the real result)
//   -> OpenPipeWireRemote gives a file descriptor
//   -> connect a PipeWire stream to the node id from Start's results
//
// Buffers are requested as MemPtr/MemFd. DMA-BUF would avoid a copy but needs
// an EGL import path; that is a worthwhile optimisation later, not a
// correctness requirement now.

#include "capture/source.h"

#include <gio/gio.h>
#include <gio/gunixfdlist.h>

#include <pipewire/pipewire.h>
#include <spa/param/video/format-utils.h>
#include <spa/param/props.h>
#include <spa/utils/result.h>

#include <condition_variable>
#include <charconv>
#include <cmath>
#include <map>
#include <set>
#include <unistd.h>
#include <cstring>
#include <mutex>
#include <random>
#include <string>
#include <vector>

namespace ps {
namespace {

constexpr const char* kPortalBus = "org.freedesktop.portal.Desktop";
constexpr const char* kPortalPath = "/org/freedesktop/portal/desktop";
constexpr const char* kScreenCastIface = "org.freedesktop.portal.ScreenCast";
constexpr const char* kRequestIface = "org.freedesktop.portal.Request";
constexpr const char* kRemoteDesktopIface = "org.freedesktop.portal.RemoteDesktop";

// Deliberately small, strict flat JSON subset: no nesting, escapes, duplicate
// fields, non-finite numbers or trailing junk. Never use substring/stod readers
// on untrusted input. Node emits only these ASCII tokens.
struct InputValue {
  enum Kind { String, Number, Boolean } kind;
  std::string text;
  double number = 0;
};
using InputFields = std::map<std::string, InputValue>;
bool parseInput(const std::string& json, InputFields& fields) {
  if (json.empty() || json.size() > 1024) return false;
  size_t p = 0;
  auto ws = [&] { while (p < json.size() && (json[p] == ' ' || json[p] == '\t' ||
                       json[p] == '\r' || json[p] == '\n')) ++p; };
  auto take = [&](char c) { ws(); if (p == json.size() || json[p] != c) return false; ++p; return true; };
  auto word = [&](std::string& s) {
    if (!take('"')) return false;
    size_t begin = p;
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
    InputValue value{};
    if (json[p] == '"') {
      value.kind = InputValue::String;
      if (!word(value.text)) return false;
    } else if (json.compare(p, 4, "true") == 0 || json.compare(p, 5, "false") == 0) {
      value.kind = InputValue::Boolean;
      value.number = json[p] == 't' ? 1 : 0;
      p += value.number == 1 ? 4 : 5;
    } else {
      value.kind = InputValue::Number;
      const size_t begin = p;
      if (json[p] == '-') ++p;
      auto digit = [&] { return p < json.size() && json[p] >= '0' && json[p] <= '9'; };
      if (!digit()) return false;
      if (json[p] == '0') ++p;
      else while (digit()) ++p;
      if (p < json.size() && json[p] == '.') {
        ++p; if (!digit()) return false; while (digit()) ++p;
      }
      if (p < json.size() && (json[p] == 'e' || json[p] == 'E')) {
        ++p;
        if (p < json.size() && (json[p] == '+' || json[p] == '-')) ++p;
        if (!digit()) return false;
        while (digit()) ++p;
      }
      const auto result = std::from_chars(json.data() + begin, json.data() + p, value.number);
      if (result.ec != std::errc{} || result.ptr != json.data() + p || !std::isfinite(value.number)) return false;
    }
    if (!fields.emplace(key, value).second) return false;
    ws();
    if (take('}')) { ws(); return p == json.size(); }
    if (!take(',')) return false;
  }
}

bool inputNumber(const InputFields& fields, const char* key, double low, double high, double& out) {
  const auto it = fields.find(key);
  if (it == fields.end() || it->second.kind != InputValue::Number) return false;
  out = it->second.number;
  return out >= low && out <= high;
}

std::string randomToken(const char* prefix) {
  static std::mt19937 rng{std::random_device{}()};
  return std::string(prefix) + std::to_string(rng() & 0x7fffffff);
}

/** The Request object path is predictable, so we can subscribe before calling. */
std::string requestPathFor(GDBusConnection* conn, const std::string& token) {
  std::string sender = g_dbus_connection_get_unique_name(conn);
  if (!sender.empty() && sender[0] == ':') sender.erase(0, 1);
  for (char& c : sender) {
    if (c == '.') c = '_';
  }
  return std::string("/org/freedesktop/portal/desktop/request/") + sender + "/" + token;
}

/** Blocks on a portal Request's Response signal. */
struct RequestWaiter {
  GMainLoop* loop = nullptr;
  guint subscription = 0;
  GDBusConnection* conn = nullptr;
  guint32 response = 2;      // default: "ended"
  GVariant* results = nullptr;
  bool fired = false;
  guint timeoutId = 0;

  ~RequestWaiter() {
    if (subscription && conn) g_dbus_connection_signal_unsubscribe(conn, subscription);
    if (timeoutId) g_source_remove(timeoutId);
    if (results) g_variant_unref(results);
    if (loop) g_main_loop_unref(loop);
  }
};

void onResponse(GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar*,
                GVariant* parameters, gpointer user_data) {
  auto* w = static_cast<RequestWaiter*>(user_data);
  guint32 code = 2;
  GVariant* results = nullptr;
  g_variant_get(parameters, "(u@a{sv})", &code, &results);
  w->response = code;
  w->results = results;  // transfer
  w->fired = true;
  g_main_loop_quit(w->loop);
}

gboolean onTimeout(gpointer user_data) {
  auto* w = static_cast<RequestWaiter*>(user_data);
  w->timeoutId = 0;
  w->fired = false;
  g_main_loop_quit(w->loop);
  return G_SOURCE_REMOVE;
}

class PortalSource : public CaptureSource {
 public:
  ~PortalSource() override { stop(); }

  bool start(const CaptureOptions& opts, std::string& error) override {
    stop();
    allowInput_ = opts.allowInput;
    fps_ = opts.fps > 0 ? opts.fps : 60;
    frameReady_ = false;
    formatWidth_ = formatHeight_ = 0;
    width_ = height_ = 0;
    frameCount_ = 0;
    captureError_.clear();

    if (!openPortalSession(error)) { stop(); return false; }
    if (!connectPipeWire(error)) { stop(); return false; }
    std::unique_lock<std::mutex> lock(mu_);
    if (!cv_.wait_for(lock, std::chrono::seconds(15), [&] { return frameReady_ || !running_; })) {
      lock.unlock(); error = "no mapped frame from PipeWire within 15s"; stop(); return false;
    }
    if (!running_) {
      error = captureError_.empty() ? "capture stopped during startup" : captureError_;
      lock.unlock(); stop(); return false;
    }
    return true;
  }

  void stop() override {
    releaseHeld();
    inputGranted_ = false;
    if (threadLoop_) {
      pw_thread_loop_stop(threadLoop_);
    }
    if (stream_) { pw_stream_destroy(stream_); stream_ = nullptr; }
    if (core_) { pw_core_disconnect(core_); core_ = nullptr; }
    if (context_) { pw_context_destroy(context_); context_ = nullptr; }
    if (threadLoop_) { pw_thread_loop_destroy(threadLoop_); threadLoop_ = nullptr; }
    if (pwFd_ >= 0) { close(pwFd_); pwFd_ = -1; }
    closePortal();
    {
      std::lock_guard<std::mutex> lock(mu_);
      running_ = false;
    }
    cv_.notify_all();
  }

  bool nextFrame(CaptureFrame& out, std::string& error) override {
    pumpPortal();
    std::unique_lock<std::mutex> lock(mu_);
    // Compositors may send only damaged frames. Repeat the last owned frame
    // on idle desktops, with bounded waits so stdin input remains responsive.
    const auto now = std::chrono::steady_clock::now();
    if (nextDue_ > now) cv_.wait_until(lock, nextDue_, [&] { return !running_; });
    if (!running_) { error = captureError_.empty() ? "capture stopped" : captureError_; return false; }
    nextDue_ = std::chrono::steady_clock::now() + std::chrono::microseconds(1000000 / fps_);
    if (frontBuffer_.empty() && consumerBuffer_.empty()) { error = "no mapped compositor frame"; return false; }
    if (frameReady_) {
      // O(1) buffer swap: eliminates copying full-resolution frame (~15 MB) on every frame.
      consumerBuffer_.swap(frontBuffer_);
      frameReady_ = false;
    }
    out.bgra = consumerBuffer_.data();
    out.stride = width_ * 4;
    out.width = width_;
    out.height = height_;
    out.pts_us = emitted_++ * 1000000ull / static_cast<uint64_t>(fps_);
    return true;
  }

  bool input(const std::string& json) override {
    pumpPortal();
    if (!allowInput_ || !inputGranted_ || !remoteProxy_ || sessionHandle_.empty()) return false;
    InputFields fields;
    if (!parseInput(json, fields)) return false;
    const auto type = fields.find("t");
    if (type == fields.end() || type->second.kind != InputValue::String) return false;
    const auto& t = type->second.text;
    if (t == "release_all" && fields.size() == 1) { releaseHeld(); return inputGranted_; }
    double x = 0, y = 0;
    if (t == "mousemove" || t == "mousebutton") {
      if (!inputNumber(fields, "x", 0, 1, x) || !inputNumber(fields, "y", 0, 1, y)) return false;
      x *= inputWidth_ - 1;
      y *= inputHeight_ - 1;
    }
    bool ok = false;
    if (t == "mousemove" && fields.size() == 3) {
      ok = motion(x, y);
    } else if ((t == "mousebutton" && fields.size() == 5) || (t == "key" && fields.size() == 3)) {
      const auto down = fields.find("down");
      if (down == fields.end() || down->second.kind != InputValue::Boolean) return false;
      const bool pressed = down->second.number == 1;
      if (t == "key") {
        double keysym = 0;
        if (!inputNumber(fields, "keysym", 1, 0x1fffffff, keysym) || std::floor(keysym) != keysym) return false;
        const int key = static_cast<int>(keysym);
        if (pressed && !heldKeys_.count(key) && heldKeys_.size() >= 64) return false;
        // Track before delivery: a timed-out request may still have taken effect.
        if (pressed) heldKeys_.insert(key);
        ok = keyEvent(key, pressed);
        if (ok && !pressed) heldKeys_.erase(key);
      } else {
        const auto button = fields.find("button");
        if (button == fields.end() || button->second.kind != InputValue::String) return false;
        static const std::map<std::string, int> buttons{{"left", 0x110}, {"right", 0x111},
          {"middle", 0x112}, {"x1", 0x113}, {"x2", 0x114}};
        const auto code = buttons.find(button->second.text);
        if (code == buttons.end()) return false;
        ok = motion(x, y);
        if (ok) {
          if (pressed) heldButtons_.insert(code->second);
          ok = buttonEvent(code->second, pressed);
          if (ok && !pressed) heldButtons_.erase(code->second);
        }
      }
    } else if (t == "wheel" && fields.size() == 3) {
      if (!inputNumber(fields, "dx", -100, 100, x) || !inputNumber(fields, "dy", -100, 100, y)) return false;
      GVariantBuilder options;
      g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
      g_variant_builder_add(&options, "{sv}", "finish", g_variant_new_boolean(TRUE));
      // SDL wheel up/right is positive; portal axes describe scroll down/right.
      ok = notify("NotifyPointerAxis", g_variant_new("(oa{sv}dd)", sessionHandle_.c_str(), &options, x, -y));
    } else return false;
    if (!ok) { inputGranted_ = false; releaseHeld(); }
    return ok;
  }

  int width() const override { std::lock_guard<std::mutex> lock(mu_); return width_; }
  int height() const override { std::lock_guard<std::mutex> lock(mu_); return height_; }
  const char* name() const override { return "portal"; }

 private:
  /* ------------------------------ portal ------------------------------ */

  void pumpPortal() {
    for (int i = 0; i < 8 && g_main_context_pending(nullptr); ++i)
      g_main_context_iteration(nullptr, FALSE);
  }

  bool notify(const char* method, GVariant* parameters) {
    GError* error = nullptr;
    GVariant* reply = g_dbus_proxy_call_sync(remoteProxy_, method, parameters,
        G_DBUS_CALL_FLAGS_NONE, 250, nullptr, &error);
    if (error) g_error_free(error);
    if (!reply) return false;
    g_variant_unref(reply);
    return true;
  }
  bool motion(double x, double y) {
    return notify("NotifyPointerMotionAbsolute", g_variant_new("(o@a{sv}udd)",
        sessionHandle_.c_str(), g_variant_new_array(G_VARIANT_TYPE("{sv}"), nullptr, 0), nodeId_, x, y));
  }
  bool keyEvent(int key, bool down) {
    return notify("NotifyKeyboardKeysym", g_variant_new("(o@a{sv}iu)",
        sessionHandle_.c_str(), g_variant_new_array(G_VARIANT_TYPE("{sv}"), nullptr, 0), key, down ? 1u : 0u));
  }
  bool buttonEvent(int button, bool down) {
    return notify("NotifyPointerButton", g_variant_new("(o@a{sv}iu)",
        sessionHandle_.c_str(), g_variant_new_array(G_VARIANT_TYPE("{sv}"), nullptr, 0), button, down ? 1u : 0u));
  }
  void releaseHeld() {
    if (remoteProxy_ && !sessionHandle_.empty()) {
      for (int key : heldKeys_) if (!keyEvent(key, false)) inputGranted_ = false;
      for (int button : heldButtons_) if (!buttonEvent(button, false)) inputGranted_ = false;
    }
    heldKeys_.clear();
    heldButtons_.clear();
  }
  static void onClosed(GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar*,
                       GVariant*, gpointer data) {
    auto* self = static_cast<PortalSource*>(data);
    self->inputGranted_ = false;
    self->heldKeys_.clear();
    self->heldButtons_.clear();
    { std::lock_guard<std::mutex> lock(self->mu_);
      self->running_ = false;
      self->captureError_ = "portal session closed";
    }
    self->cv_.notify_all();
  }

  bool callAndWait(const char* method, GVariant* params, const std::string& token,
                   GVariant** resultsOut, std::string& error, int timeoutSeconds = 120) {
    RequestWaiter waiter;
    waiter.conn = conn_;
    waiter.loop = g_main_loop_new(nullptr, FALSE);

    const std::string path = requestPathFor(conn_, token);
    waiter.subscription = g_dbus_connection_signal_subscribe(
        conn_, kPortalBus, kRequestIface, "Response", path.c_str(), nullptr,
        G_DBUS_SIGNAL_FLAGS_NONE, onResponse, &waiter, nullptr);

    GError* gerr = nullptr;
    GVariant* reply = g_dbus_proxy_call_sync(
        (allowInput_ && std::strcmp(method, "SelectSources") != 0) ? remoteProxy_ : proxy_,
        method, params, G_DBUS_CALL_FLAGS_NONE, timeoutSeconds * 1000, nullptr, &gerr);
    if (!reply) {
      error = std::string(method) + " failed: " + (gerr ? gerr->message : "unknown");
      if (gerr) g_error_free(gerr);
      return false;
    }
    g_variant_unref(reply);

    // The consent dialog can sit there for a long time; allow for it.
    waiter.timeoutId = g_timeout_add_seconds(timeoutSeconds, onTimeout, &waiter);
    if (!waiter.fired) g_main_loop_run(waiter.loop);

    if (!waiter.fired) {
      error = std::string(method) + ": no response from the portal (timed out)";
      return false;
    }
    if (waiter.response == 1) {
      error = "the screen-share request was cancelled";
      return false;
    }
    if (waiter.response != 0) {
      error = std::string(method) + ": portal returned response code " + std::to_string(waiter.response);
      return false;
    }

    if (resultsOut) {
      *resultsOut = waiter.results;
      waiter.results = nullptr;  // caller owns it now
    }
    return true;
  }

  bool openPortalSession(std::string& error) {
    GError* gerr = nullptr;
    conn_ = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &gerr);
    if (!conn_) {
      error = std::string("cannot reach the session bus: ") + (gerr ? gerr->message : "?");
      if (gerr) g_error_free(gerr);
      return false;
    }

    proxy_ = g_dbus_proxy_new_sync(conn_, G_DBUS_PROXY_FLAGS_NONE, nullptr,
                                   kPortalBus, kPortalPath, kScreenCastIface, nullptr, &gerr);
    if (!proxy_) {
      error = std::string("xdg-desktop-portal ScreenCast unavailable: ") + (gerr ? gerr->message : "?");
      if (gerr) g_error_free(gerr);
      return false;
    }

    if (allowInput_) {
      remoteProxy_ = g_dbus_proxy_new_sync(conn_, G_DBUS_PROXY_FLAGS_NONE, nullptr,
          kPortalBus, kPortalPath, kRemoteDesktopIface, nullptr, &gerr);
      if (!remoteProxy_) {
        error = std::string("RemoteDesktop portal unavailable: ") + (gerr ? gerr->message : "?");
        if (gerr) g_error_free(gerr);
        return false;
      }
    }

    // --- CreateSession (RemoteDesktop for opt-in input; ScreenCast otherwise) ---
    const std::string createToken = randomToken("ps_create_");
    const std::string sessionToken = randomToken("ps_session_");
    {
      GVariantBuilder opts;
      g_variant_builder_init(&opts, G_VARIANT_TYPE_VARDICT);
      g_variant_builder_add(&opts, "{sv}", "handle_token", g_variant_new_string(createToken.c_str()));
      g_variant_builder_add(&opts, "{sv}", "session_handle_token", g_variant_new_string(sessionToken.c_str()));

      GVariant* results = nullptr;
      if (!callAndWait("CreateSession", g_variant_new("(a{sv})", &opts), createToken, &results, error, 30)) {
        return false;
      }
      const char* handle = nullptr;
      g_variant_lookup(results, "session_handle", "&s", &handle);
      if (!handle) {
        g_variant_unref(results);
        error = "portal did not return a session handle";
        return false;
      }
      sessionHandle_ = handle;
      g_variant_unref(results);
      if (!g_variant_is_object_path(sessionHandle_.c_str())) {
        sessionHandle_.clear(); error = "invalid portal session handle"; return false;
      }
      closedSubscription_ = g_dbus_connection_signal_subscribe(conn_, kPortalBus,
          "org.freedesktop.portal.Session", "Closed", sessionHandle_.c_str(), nullptr,
          G_DBUS_SIGNAL_FLAGS_NONE, onClosed, this, nullptr);
    }

    if (allowInput_) {
      const std::string token = randomToken("ps_devices_");
      GVariantBuilder opts;
      g_variant_builder_init(&opts, G_VARIANT_TYPE_VARDICT);
      g_variant_builder_add(&opts, "{sv}", "handle_token", g_variant_new_string(token.c_str()));
      g_variant_builder_add(&opts, "{sv}", "types", g_variant_new_uint32(3)); // keyboard + pointer
      if (!callAndWait("SelectDevices", g_variant_new("(oa{sv})", sessionHandle_.c_str(), &opts),
                       token, nullptr, error, 30)) return false;
    }

    // --- SelectSources: ScreenCast on the SAME RemoteDesktop session ---
    {
      const std::string token = randomToken("ps_select_");
      GVariantBuilder opts;
      g_variant_builder_init(&opts, G_VARIANT_TYPE_VARDICT);
      g_variant_builder_add(&opts, "{sv}", "handle_token", g_variant_new_string(token.c_str()));
      g_variant_builder_add(&opts, "{sv}", "types", g_variant_new_uint32(1));        // monitors
      g_variant_builder_add(&opts, "{sv}", "multiple", g_variant_new_boolean(FALSE));
      // Cursor must be drawn into the frame, or the remote user cannot aim.
      g_variant_builder_add(&opts, "{sv}", "cursor_mode", g_variant_new_uint32(2));

      GVariant* results = nullptr;
      if (!callAndWait("SelectSources",
                       g_variant_new("(oa{sv})", sessionHandle_.c_str(), &opts),
                       token, &results, error, 30)) {
        return false;
      }
      if (results) g_variant_unref(results);
    }

    // --- Start (this is what raises the consent dialog) ---
    {
      const std::string token = randomToken("ps_start_");
      GVariantBuilder opts;
      g_variant_builder_init(&opts, G_VARIANT_TYPE_VARDICT);
      g_variant_builder_add(&opts, "{sv}", "handle_token", g_variant_new_string(token.c_str()));

      GVariant* results = nullptr;
      if (!callAndWait("Start",
                       g_variant_new("(osa{sv})", sessionHandle_.c_str(), "", &opts),
                       token, &results, error, 300)) {
        return false;
      }

      if (allowInput_) {
        guint32 devices = 0;
        if (!g_variant_lookup(results, "devices", "u", &devices) || (devices & 3u) != 3u) {
          g_variant_unref(results);
          error = "portal did not grant both keyboard and pointer permission";
          return false;
        }
        inputGranted_ = true;
      }
      GVariant* streams = g_variant_lookup_value(results, "streams", G_VARIANT_TYPE("a(ua{sv})"));
      if (!streams || g_variant_n_children(streams) == 0) {
        if (streams) g_variant_unref(streams);
        g_variant_unref(results);
        error = "the portal returned no streams (nothing was shared)";
        return false;
      }

      GVariant* first = g_variant_get_child_value(streams, 0);
      GVariant* props = nullptr;
      g_variant_get(first, "(u@a{sv})", &nodeId_, &props);
      if (props) {
        gint32 w = 0, h = 0;
        GVariant* size = g_variant_lookup_value(props, "size", G_VARIANT_TYPE("(ii)"));
        if (size) {
          g_variant_get(size, "(ii)", &w, &h);
          g_variant_unref(size);
          if (w > 0 && h > 0 && w <= 8192 && h <= 8192) {
            width_ = w & ~1; height_ = h & ~1;
            inputWidth_ = w; inputHeight_ = h;
          }
        }
        g_variant_unref(props);
      }
      g_variant_unref(first);
      g_variant_unref(streams);
      g_variant_unref(results);
    }

    if (allowInput_ && (inputWidth_ <= 0 || inputHeight_ <= 0)) {
      error = "portal did not supply safe logical stream dimensions for input";
      return false;
    }

    // --- OpenPipeWireRemote ---
    {
      GVariantBuilder opts;
      g_variant_builder_init(&opts, G_VARIANT_TYPE_VARDICT);
      GUnixFDList* fdList = nullptr;
      GError* err2 = nullptr;
      GVariant* reply = g_dbus_proxy_call_with_unix_fd_list_sync(
          proxy_, "OpenPipeWireRemote",
          g_variant_new("(oa{sv})", sessionHandle_.c_str(), &opts),
          G_DBUS_CALL_FLAGS_NONE, 30000, nullptr, &fdList, nullptr, &err2);
      if (!reply) {
        error = std::string("OpenPipeWireRemote failed: ") + (err2 ? err2->message : "?");
        if (err2) g_error_free(err2);
        return false;
      }
      gint32 handle = -1;
      g_variant_get(reply, "(h)", &handle);
      g_variant_unref(reply);

      if (!fdList || handle < 0) {
        error = "portal did not return a PipeWire file descriptor";
        if (fdList) g_object_unref(fdList);
        return false;
      }
      pwFd_ = g_unix_fd_list_get(fdList, handle, &err2);
      g_object_unref(fdList);
      if (pwFd_ < 0) {
        error = std::string("could not take the PipeWire fd: ") + (err2 ? err2->message : "?");
        if (err2) g_error_free(err2);
        return false;
      }
    }

    return true;
  }

  void closePortal() {
    if (closedSubscription_ && conn_) g_dbus_connection_signal_unsubscribe(conn_, closedSubscription_);
    closedSubscription_ = 0;
    inputWidth_ = inputHeight_ = 0;
    if (!sessionHandle_.empty() && conn_) {
      // Closing the session tells the compositor to stop capturing immediately
      // rather than waiting for us to exit.
      g_dbus_connection_call(conn_, kPortalBus, sessionHandle_.c_str(),
                             "org.freedesktop.portal.Session", "Close",
                             nullptr, nullptr, G_DBUS_CALL_FLAGS_NONE, -1,
                             nullptr, nullptr, nullptr);
      sessionHandle_.clear();
    }
    if (remoteProxy_) { g_object_unref(remoteProxy_); remoteProxy_ = nullptr; }
    if (proxy_) { g_object_unref(proxy_); proxy_ = nullptr; }
    if (conn_) { g_object_unref(conn_); conn_ = nullptr; }
  }

  /* ----------------------------- pipewire ----------------------------- */

  static void onStreamParamChanged(void* data, uint32_t id, const struct spa_pod* param) {
    auto* self = static_cast<PortalSource*>(data);
    if (!param || id != SPA_PARAM_Format) return;

    uint32_t mediaType = 0, mediaSubtype = 0;
    if (spa_format_parse(param, &mediaType, &mediaSubtype) < 0) return;
    if (mediaType != SPA_MEDIA_TYPE_video || mediaSubtype != SPA_MEDIA_SUBTYPE_raw) return;

    spa_video_info_raw info{};
    if (spa_format_video_raw_parse(param, &info) < 0) return;

    std::lock_guard<std::mutex> lock(self->mu_);
    if (info.size.width < 2 || info.size.height < 2 || info.size.width > 8192 || info.size.height > 8192 ||
        (self->formatWidth_ && (self->formatWidth_ != info.size.width || self->formatHeight_ != info.size.height))) {
      self->captureError_ = "invalid or changed PipeWire dimensions";
      self->running_ = false;
      self->cv_.notify_all();
      return;
    }
    self->formatWidth_ = info.size.width;
    self->formatHeight_ = info.size.height;
    self->format_ = info.format;
    if (info.size.width > 0 && info.size.height > 0) {
      self->width_ = static_cast<int>(info.size.width) & ~1;
      self->height_ = static_cast<int>(info.size.height) & ~1;
      self->backBuffer_.assign(static_cast<size_t>(self->width_) * self->height_ * 4, 0);
      self->frontBuffer_.assign(self->backBuffer_.size(), 0);
    }
  }

  static void onStreamProcess(void* data) {
    auto* self = static_cast<PortalSource*>(data);
    struct pw_buffer* b = pw_stream_dequeue_buffer(self->stream_);
    if (!b) return;

    struct spa_buffer* buf = b->buffer;
    if (buf->n_datas > 0 && buf->datas[0].data) {
      self->consume(buf);
    }
    pw_stream_queue_buffer(self->stream_, b);
  }

  void consume(struct spa_buffer* buf) {
    const auto& plane = buf->datas[0];
    if (!plane.chunk || !plane.data) return;
    const int32_t srcStride = plane.chunk->stride;
    if (srcStride <= 0) return;
    {
      std::lock_guard<std::mutex> lock(mu_);
      if (width_ <= 0 || height_ <= 0 || width_ > 8192 || height_ > 8192) return;
      const size_t rowBytes = static_cast<size_t>(width_) * 4;
      const size_t needed = static_cast<size_t>(height_ - 1) * srcStride + rowBytes;
      if (static_cast<size_t>(srcStride) < rowBytes || plane.chunk->offset > plane.maxsize ||
          needed > plane.maxsize - plane.chunk->offset || needed > plane.chunk->size) return;
      const uint8_t* src = static_cast<const uint8_t*>(plane.data) + plane.chunk->offset;
      if (backBuffer_.size() != static_cast<size_t>(width_) * height_ * 4) {
        backBuffer_.assign(static_cast<size_t>(width_) * height_ * 4, 0);
      }

      const int dstStride = width_ * 4;
      for (int y = 0; y < height_; ++y) {
        const uint8_t* s = src + static_cast<size_t>(y) * srcStride;
        uint8_t* d = backBuffer_.data() + static_cast<size_t>(y) * dstStride;
        switch (format_) {
          case SPA_VIDEO_FORMAT_BGRA:
          case SPA_VIDEO_FORMAT_BGRx:
            memcpy(d, s, dstStride);
            break;
          case SPA_VIDEO_FORMAT_RGBA:
          case SPA_VIDEO_FORMAT_RGBx:
            for (int x = 0; x < width_; ++x) {
              d[x * 4 + 0] = s[x * 4 + 2];
              d[x * 4 + 1] = s[x * 4 + 1];
              d[x * 4 + 2] = s[x * 4 + 0];
              d[x * 4 + 3] = 255;
            }
            break;
          default:
            // Unexpected format: emit black rather than garbage, and say so once.
            memset(d, 0, dstStride);
            break;
        }
      }
      frontBuffer_.swap(backBuffer_);
      ptsUs_ = static_cast<uint64_t>(frameCount_++) * 1000000ull / static_cast<uint64_t>(fps_);
      frameReady_ = true;
    }
    cv_.notify_one();
  }

  bool connectPipeWire(std::string& error) {
    pw_init(nullptr, nullptr);

    threadLoop_ = pw_thread_loop_new("ps-portal", nullptr);
    if (!threadLoop_) { error = "pw_thread_loop_new failed"; return false; }

    pw_thread_loop_lock(threadLoop_);

    context_ = pw_context_new(pw_thread_loop_get_loop(threadLoop_), nullptr, 0);
    if (!context_) {
      pw_thread_loop_unlock(threadLoop_);
      error = "pw_context_new failed";
      return false;
    }

    // connect_fd takes ownership of the descriptor.
    core_ = pw_context_connect_fd(context_, pwFd_, nullptr, 0);
    if (!core_) {
      pw_thread_loop_unlock(threadLoop_);
      error = "could not connect to the PipeWire remote from the portal";
      return false;
    }
    pwFd_ = -1;

    static const pw_stream_events events = [] {
      pw_stream_events e{};
      e.version = PW_VERSION_STREAM_EVENTS;
      e.param_changed = onStreamParamChanged;
      e.process = onStreamProcess;
      return e;
    }();

    stream_ = pw_stream_new(core_, "penguin-stream-capture",
                            pw_properties_new(PW_KEY_MEDIA_TYPE, "Video",
                                              PW_KEY_MEDIA_CATEGORY, "Capture",
                                              PW_KEY_MEDIA_ROLE, "Screen",
                                              nullptr));
    if (!stream_) {
      pw_thread_loop_unlock(threadLoop_);
      error = "pw_stream_new failed";
      return false;
    }
    pw_stream_add_listener(stream_, &streamListener_, &events, this);

    uint8_t paramBuffer[1024];
    struct spa_pod_builder b = SPA_POD_BUILDER_INIT(paramBuffer, sizeof(paramBuffer));
    struct spa_rectangle defSize = SPA_RECTANGLE(1920, 1080);
    struct spa_rectangle minSize = SPA_RECTANGLE(1, 1);
    struct spa_rectangle maxSize = SPA_RECTANGLE(8192, 8192);
    struct spa_fraction defRate = SPA_FRACTION(static_cast<uint32_t>(fps_), 1);
    struct spa_fraction minRate = SPA_FRACTION(0, 1);
    struct spa_fraction maxRate = SPA_FRACTION(240, 1);

    const struct spa_pod* params[1];
    params[0] = static_cast<const spa_pod*>(spa_pod_builder_add_object(
        &b,
        SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat,
        SPA_FORMAT_mediaType, SPA_POD_Id(SPA_MEDIA_TYPE_video),
        SPA_FORMAT_mediaSubtype, SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
        SPA_FORMAT_VIDEO_format,
        SPA_POD_CHOICE_ENUM_Id(5,
                               SPA_VIDEO_FORMAT_BGRx, SPA_VIDEO_FORMAT_BGRx,
                               SPA_VIDEO_FORMAT_RGBx, SPA_VIDEO_FORMAT_BGRA,
                               SPA_VIDEO_FORMAT_RGBA),
        SPA_FORMAT_VIDEO_size, SPA_POD_CHOICE_RANGE_Rectangle(&defSize, &minSize, &maxSize),
        SPA_FORMAT_VIDEO_framerate, SPA_POD_CHOICE_RANGE_Fraction(&defRate, &minRate, &maxRate)));

    const int ret = pw_stream_connect(
        stream_, PW_DIRECTION_INPUT, nodeId_,
        static_cast<pw_stream_flags>(PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS),
        params, 1);
    pw_thread_loop_unlock(threadLoop_);

    if (ret < 0) {
      error = std::string("pw_stream_connect failed: ") + spa_strerror(ret);
      return false;
    }

    { std::lock_guard<std::mutex> lock(mu_); running_ = true; }
    if (pw_thread_loop_start(threadLoop_) < 0) {
      error = "pw_thread_loop_start failed";
      return false;
    }

    return true;
  }

  // portal state
  GDBusConnection* conn_ = nullptr;
  GDBusProxy* proxy_ = nullptr;
  GDBusProxy* remoteProxy_ = nullptr;
  guint closedSubscription_ = 0;
  bool allowInput_ = false;
  bool inputGranted_ = false;
  int inputWidth_ = 0, inputHeight_ = 0;
  std::set<int> heldKeys_, heldButtons_;
  std::string sessionHandle_;
  uint32_t nodeId_ = 0;
  int pwFd_ = -1;

  // pipewire state
  pw_thread_loop* threadLoop_ = nullptr;
  pw_context* context_ = nullptr;
  pw_core* core_ = nullptr;
  pw_stream* stream_ = nullptr;
  spa_hook streamListener_{};

  // frame handoff
  mutable std::mutex mu_;
  std::string captureError_;
  uint32_t formatWidth_ = 0, formatHeight_ = 0;
  std::condition_variable cv_;
  std::vector<uint8_t> backBuffer_;
  std::vector<uint8_t> frontBuffer_;
  std::vector<uint8_t> consumerBuffer_;
  bool frameReady_ = false;
  bool running_ = false;
  uint32_t format_ = SPA_VIDEO_FORMAT_BGRx;
  int width_ = 0;
  int height_ = 0;
  int fps_ = 60;
  uint64_t frameCount_ = 0;
  uint64_t ptsUs_ = 0;
  uint64_t emitted_ = 0;
  std::chrono::steady_clock::time_point nextDue_{};
};

}  // namespace

std::unique_ptr<CaptureSource> makePortalPipeWireSource() {
  return std::make_unique<PortalSource>();
}

}  // namespace ps
