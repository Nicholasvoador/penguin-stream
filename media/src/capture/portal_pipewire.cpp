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
#include "input/keymap.h"

#include <gio/gio.h>
#include <gio/gunixfdlist.h>

#include <pipewire/pipewire.h>
#include <spa/param/video/format-utils.h>
#include <spa/param/props.h>
#include <spa/utils/result.h>

#include <algorithm>
#include <cstdlib>
#include <condition_variable>
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
    wantMonitor_ = opts.monitor;
    workspace_ = opts.workspace;
    restoreTokenIn_ = opts.restoreToken;
    restoreToken_.clear();
    cropL_ = {};
    cropPx_ = {};
    note_.clear();

    // Test hook: read a PipeWire video node directly (no portal, no dialog).
    // Exercises exactly the same buffer/zero-copy code as a real share.
    if (const char* node = std::getenv("PS_PIPEWIRE_NODE")) {
      directNode_ = static_cast<uint32_t>(std::strtoul(node, nullptr, 10));
      nodeId_ = directNode_;
    } else {
      directNode_ = 0;
      if (!openPortalSession(error)) { stop(); return false; }
    }
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
    {
      // Wake a PipeWire thread waiting in onRemoveBuffer before joining it.
      std::lock_guard<std::mutex> lock(mu_);
      running_ = false;
      inUseBusy_ = false;
    }
    cv_.notify_all();
    releaseHeld();
    {
      std::lock_guard<std::recursive_mutex> lock(inputMu_);
      inputGranted_ = false;
    }
    if (threadLoop_ && stream_) {
      // Give held buffers back and disconnect cleanly while the loop still
      // runs. Destroying a stream that still holds dequeued buffers leaves the
      // producer short of buffers, and the next capture of the same source
      // received no frames at all.
      pw_thread_loop_lock(threadLoop_);
      {
        std::lock_guard<std::mutex> lock(mu_);
        if (pending_) pw_stream_queue_buffer(stream_, pending_);
        if (inUse_) pw_stream_queue_buffer(stream_, inUse_);
        pending_ = inUse_ = nullptr;
        pendingData_ = inUseData_ = nullptr;
      }
      pw_stream_disconnect(stream_);
      pw_thread_loop_unlock(threadLoop_);
    }
    if (threadLoop_) {
      pw_thread_loop_stop(threadLoop_);
    }
    if (stream_) { pw_stream_destroy(stream_); stream_ = nullptr; }
    {
      std::lock_guard<std::mutex> lock(mu_);
      pending_ = inUse_ = nullptr;
      pendingData_ = inUseData_ = nullptr;
      buffers_ = 0;
    }
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
    using Clock = std::chrono::steady_clock;
    // Latency-first pacing: a new compositor frame goes to the encoder the
    // moment it arrives. A token bucket keeps the average at the requested
    // fps (one token per frame period, at most one banked) and a minimum
    // spacing of 0.6 periods stops bursts. Unlike a fixed timer grid, a frame
    // never waits for a tick: simulated over 30-240 Hz desktops this removes
    // an average of 2-4 ms (up to 16 ms) of waiting per frame when the
    // desktop refreshes faster than the stream (e.g. 144 Hz -> 60 fps).
    // On a still desktop the last frame is repeated at ~10 fps so loss
    // recovery keeps working.
    const auto period = std::chrono::microseconds(1000000 / fps_);
    const auto minGap = period * 6 / 10;
    const auto idleRepeat = std::chrono::milliseconds(100);
    std::unique_lock<std::mutex> lock(mu_);
    // The encoder is done with the frame we handed out last time.
    inUseBusy_ = false;
    cv_.notify_all();
    bool fresh = false;
    for (;;) {
      if (!running_) { error = captureError_.empty() ? "capture stopped" : captureError_; return false; }
      const auto now = Clock::now();
      // Tokens accrue one per period, capped at one banked frame.
      const double tokens = std::min(1.0, tokens_ + std::chrono::duration<double>(now - tokensAt_) /
                                              std::chrono::duration<double>(period));
      // Earliest moment a fresh frame may go: spacing met and at least half a
      // token in the bucket (the bucket may dip to -0.5, then must refill).
      const auto budgetAt = now + std::chrono::duration_cast<Clock::duration>(
          std::chrono::duration<double, std::micro>(std::max(0.0, 0.5 - tokens) * period.count()));
      auto readyAt = std::max(lastEmit_ + minGap, budgetAt);
      // Desktop faster than the stream (e.g. 144 Hz -> 60 fps): if the frame
      // we are holding has already aged past half the desktop's frame
      // interval, the next one is closer than the old one is stale - wait for
      // it (bounded) and send fresh pixels instead.
      if (frameReady_ && now >= readyAt && arrivalUs_ > 0 && arrivalUs_ < period.count() * 0.9) {
        const int64_t age = static_cast<int64_t>(steadyMicros()) - static_cast<int64_t>(frontCapturedUs_);
        const int64_t giveUp = static_cast<int64_t>(frontCapturedUs_) + static_cast<int64_t>(arrivalUs_ * 1.5);
        if (age > arrivalUs_ / 2 && static_cast<int64_t>(steadyMicros()) < giveUp) {
          readyAt = now + std::chrono::microseconds(giveUp - static_cast<int64_t>(steadyMicros()));
          heldFor_ = frontCapturedUs_;
        }
      }
      if (frameReady_ && now >= readyAt) { fresh = true; tokens_ = tokens - 1.0; tokensAt_ = now; break; }
      // A newer frame replaced the one we were holding back for: take it now.
      if (frameReady_ && heldFor_ && frontCapturedUs_ != heldFor_ && now >= lastEmit_ + minGap && tokens >= 0.5) {
        fresh = true; tokens_ = tokens - 1.0; tokensAt_ = now; heldFor_ = 0; break;
      }
      const bool haveImage = inUseData_ || !(frontBuffer_.empty() && consumerBuffer_.empty());
      if (now >= lastEmit_ + idleRepeat && haveImage) {
        fresh = frameReady_;
        tokens_ = tokens - 1.0;
        tokensAt_ = now;
        break;
      }
      auto wakeAt = frameReady_ ? readyAt : lastEmit_ + idleRepeat;
      if (wakeAt > now + std::chrono::milliseconds(20)) wakeAt = now + std::chrono::milliseconds(20);
      cv_.wait_until(lock, wakeAt);
      if (!frameReady_) {  // keep portal signals (session closed) flowing while idle
        lock.unlock(); pumpPortal(); lock.lock();
      }
    }
    const auto now = Clock::now();
    lastEmit_ = now;
    heldFor_ = 0;
    uint64_t captured = steadyMicros();
    if (fresh && pending_) {
      // Zero-copy frame: promote it and hand the previous one back to
      // PipeWire. Lock order everywhere is PipeWire loop -> mu_.
      lock.unlock();
      pw_thread_loop_lock(threadLoop_);
      lock.lock();
      struct pw_buffer* old = nullptr;
      if (pending_) {
        old = inUse_;
        inUse_ = pending_;
        inUseData_ = pendingData_;
        inUseStride_ = pendingStride_;
        pending_ = nullptr;
        captured = frontCapturedUs_;
      }
      frameReady_ = false;
      if (old) pw_stream_queue_buffer(stream_, old);
      pw_thread_loop_unlock(threadLoop_);
      if (!running_) { error = captureError_.empty() ? "capture stopped" : captureError_; return false; }
    } else if (fresh) {
      // Copy path: O(1) swap with the buffer the PipeWire thread filled.
      consumerBuffer_.swap(frontBuffer_);
      frameReady_ = false;
      captured = frontCapturedUs_;
      inUseData_ = nullptr;   // switched back to copying (e.g. format change)
    }
    if (inUseData_) {
      inUseBusy_ = true;      // PipeWire must not free it until the next call
      out.bgra = inUseData_;
      out.stride = inUseStride_;
    } else {
      if (consumerBuffer_.empty()) { error = "no mapped compositor frame"; return false; }
      out.bgra = consumerBuffer_.data();
      out.stride = width_ * 4;
    }
    out.width = width_;
    out.height = height_;
    const uint64_t t = steadyMicros();
    lastPts_ = std::max(lastPts_ + 1, t);
    out.pts_us = lastPts_;
    out.captured_us = captured;
    return true;
  }

  bool input(const InputEvent& e) override {
    std::lock_guard<std::recursive_mutex> lock(inputMu_);
    if (!allowInput_ || !inputGranted_ || !remoteProxy_ || sessionHandle_.empty()) return false;
    switch (e.kind) {
      case InputKind::ReleaseAll:
        releaseHeld();
        return true;
      case InputKind::MouseAbs:
        return motion(e.x, e.y);
      case InputKind::MouseRel:
        notify("NotifyPointerMotion", g_variant_new("(o@a{sv}dd)", sessionHandle_.c_str(),
            g_variant_new_array(G_VARIANT_TYPE("{sv}"), nullptr, 0), double(e.dx), double(e.dy)));
        return true;
      case InputKind::MouseButton: {
        static const int codes[] = {0x110, 0x112, 0x111, 0x113, 0x114};  // BTN_LEFT, MIDDLE, RIGHT, SIDE, EXTRA
        const int code = codes[static_cast<int>(e.button)];
        if (e.hasPosition) motion(e.x, e.y);
        if (e.down) heldButtons_.insert(code); else heldButtons_.erase(code);
        buttonEvent(code, e.down);
        return true;
      }
      case InputKind::Wheel: {
        // SDL: wheel up/right is positive. Portal: positive scrolls down/right.
        // Whole notches (mouse wheels) go out as discrete clicks so apps scroll
        // by lines; fractional (touchpad) deltas as smooth ~15 px per notch.
        const bool notches = std::floor(e.wheelX) == e.wheelX && std::floor(e.wheelY) == e.wheelY;
        if (notches) {
          if (e.wheelY != 0) notify("NotifyPointerAxisDiscrete", g_variant_new("(o@a{sv}ui)", sessionHandle_.c_str(),
              g_variant_new_array(G_VARIANT_TYPE("{sv}"), nullptr, 0), 0u, static_cast<int>(-e.wheelY)));
          if (e.wheelX != 0) notify("NotifyPointerAxisDiscrete", g_variant_new("(o@a{sv}ui)", sessionHandle_.c_str(),
              g_variant_new_array(G_VARIANT_TYPE("{sv}"), nullptr, 0), 1u, static_cast<int>(e.wheelX)));
        } else {
          GVariantBuilder options;
          g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
          g_variant_builder_add(&options, "{sv}", "finish", g_variant_new_boolean(TRUE));
          notify("NotifyPointerAxis", g_variant_new("(oa{sv}dd)", sessionHandle_.c_str(), &options,
                                                    e.wheelX * 15.0, -e.wheelY * 15.0));
        }
        return true;
      }
      case InputKind::Key: {
        NativeKey key;
        if (!lookupHidKey(e.hid, key) || !key.evdev) return false;
        if (e.repeat) return true;  // Wayland clients generate their own key repeat
        if (e.down && !heldKeys_.count(key.evdev) && heldKeys_.size() >= 64) return false;
        if (e.down) heldKeys_.insert(key.evdev); else heldKeys_.erase(key.evdev);
        keyEvent(key.evdev, e.down);
        return true;
      }
      default:
        return false;  // controllers are handled by VirtualGamepads, not the portal
    }
  }

  bool inputReady() const override {
    std::lock_guard<std::recursive_mutex> lock(inputMu_);
    return allowInput_ && inputGranted_;
  }

  int width() const override { std::lock_guard<std::mutex> lock(mu_); return width_; }
  int height() const override { std::lock_guard<std::mutex> lock(mu_); return height_; }
  const char* name() const override { return "portal"; }
  std::string restoreToken() const override { return restoreToken_; }
  std::string captureNote() const override { return note_; }

 private:
  /* ------------------------------ portal ------------------------------ */

  void pumpPortal() {
    for (int i = 0; i < 8 && g_main_context_pending(nullptr); ++i)
      g_main_context_iteration(nullptr, FALSE);
  }

  // Fire-and-forget: with no callback GDBus sends NO_REPLY_EXPECTED, so a busy
  // compositor never stalls the input thread, and ordering is preserved on the
  // single connection. Revoked permission arrives as the Session Closed signal.
  void notify(const char* method, GVariant* parameters) {
    g_dbus_proxy_call(remoteProxy_, method, parameters, G_DBUS_CALL_FLAGS_NONE, -1,
                      nullptr, nullptr, nullptr);
  }
  bool motion(double nx, double ny) {
    // Coordinates are in the stream's logical space. When we crop one monitor
    // out of a whole-workspace stream, map into that monitor's rectangle.
    double x, y;
    if (cropL_.valid()) {
      x = cropL_.x + nx * (cropL_.w - 1);
      y = cropL_.y + ny * (cropL_.h - 1);
    } else {
      x = nx * (inputWidth_ - 1);
      y = ny * (inputHeight_ - 1);
    }
    notify("NotifyPointerMotionAbsolute", g_variant_new("(o@a{sv}udd)",
        sessionHandle_.c_str(), g_variant_new_array(G_VARIANT_TYPE("{sv}"), nullptr, 0), nodeId_, x, y));
    return true;
  }
  void keyEvent(int evdev, bool down) {
    notify("NotifyKeyboardKeycode", g_variant_new("(o@a{sv}iu)",
        sessionHandle_.c_str(), g_variant_new_array(G_VARIANT_TYPE("{sv}"), nullptr, 0), evdev, down ? 1u : 0u));
  }
  void buttonEvent(int button, bool down) {
    notify("NotifyPointerButton", g_variant_new("(o@a{sv}iu)",
        sessionHandle_.c_str(), g_variant_new_array(G_VARIANT_TYPE("{sv}"), nullptr, 0), button, down ? 1u : 0u));
  }
  void releaseHeld() {
    std::lock_guard<std::recursive_mutex> lock(inputMu_);
    if (remoteProxy_ && !sessionHandle_.empty() && inputGranted_) {
      for (int key : heldKeys_) keyEvent(key, false);
      for (int button : heldButtons_) buttonEvent(button, false);
      // Make sure the release messages leave before the session is closed.
      if (conn_) g_dbus_connection_flush_sync(conn_, nullptr, nullptr);
    }
    heldKeys_.clear();
    heldButtons_.clear();
  }
  static void onClosed(GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar*,
                       GVariant*, gpointer data) {
    auto* self = static_cast<PortalSource*>(data);
    {
      std::lock_guard<std::recursive_mutex> lock(self->inputMu_);
      self->inputGranted_ = false;
      self->heldKeys_.clear();
      self->heldButtons_.clear();
    }
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
      // Remember the choice (screen + control) until revoked, so the next
      // share starts without the picker. Remote desktop sessions persist via
      // SelectDevices; screen-cast-only sessions via SelectSources.
      g_variant_builder_add(&opts, "{sv}", "persist_mode", g_variant_new_uint32(2));
      if (!restoreTokenIn_.empty())
        g_variant_builder_add(&opts, "{sv}", "restore_token", g_variant_new_string(restoreTokenIn_.c_str()));
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
      if (!allowInput_) {
        g_variant_builder_add(&opts, "{sv}", "persist_mode", g_variant_new_uint32(2));
        if (!restoreTokenIn_.empty())
          g_variant_builder_add(&opts, "{sv}", "restore_token", g_variant_new_string(restoreTokenIn_.c_str()));
      }

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

      {
        const char* tok = nullptr;
        if (g_variant_lookup(results, "restore_token", "&s", &tok) && tok && std::strlen(tok) < 512)
          restoreToken_ = tok;
      }
      GVariant* first = g_variant_get_child_value(streams, 0);
      GVariant* props = nullptr;
      bool havePos = false;
      gint32 px = 0, py = 0;
      g_variant_get(first, "(u@a{sv})", &nodeId_, &props);
      if (props) {
        gint32 w = 0, h = 0;
        GVariant* size = g_variant_lookup_value(props, "size", G_VARIANT_TYPE("(ii)"));
        if (size) {
          g_variant_get(size, "(ii)", &w, &h);
          g_variant_unref(size);
          if (w > 0 && h > 0 && w <= 16384 && h <= 16384) {
            width_ = w & ~1; height_ = h & ~1;
            inputWidth_ = w; inputHeight_ = h;
          }
        }
        GVariant* pos = g_variant_lookup_value(props, "position", G_VARIANT_TYPE("(ii)"));
        if (pos) { g_variant_get(pos, "(ii)", &px, &py); g_variant_unref(pos); havePos = true; }
        g_variant_unref(props);
      }
      g_variant_unref(first);
      chooseCrop(havePos, px, py);
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
    self->zeroCopy_ = (info.format == SPA_VIDEO_FORMAT_BGRx || info.format == SPA_VIDEO_FORMAT_BGRA) &&
                      !std::getenv("PS_PORTAL_COPY");
    if (info.size.width > 0 && info.size.height > 0) {
      self->cropPx_ = {0, 0, static_cast<int>(info.size.width), static_cast<int>(info.size.height)};
      if (self->cropL_.valid() && self->inputWidth_ > 0 && self->inputHeight_ > 0) {
        // Logical -> buffer pixels (differs when the desktop is scaled).
        const double sx = double(info.size.width) / self->inputWidth_;
        const double sy = double(info.size.height) / self->inputHeight_;
        Rect c{int(self->cropL_.x * sx + 0.5), int(self->cropL_.y * sy + 0.5),
               int(self->cropL_.w * sx + 0.5), int(self->cropL_.h * sy + 0.5)};
        c.x = std::clamp(c.x, 0, int(info.size.width) - 2);
        c.y = std::clamp(c.y, 0, int(info.size.height) - 2);
        c.w = std::min(c.w, int(info.size.width) - c.x);
        c.h = std::min(c.h, int(info.size.height) - c.y);
        if (c.w >= 2 && c.h >= 2) self->cropPx_ = c;
      }
      self->width_ = self->cropPx_.w & ~1;
      self->height_ = self->cropPx_.h & ~1;
      self->backBuffer_.assign(static_cast<size_t>(self->width_) * self->height_ * 4, 0);
      self->frontBuffer_.assign(self->backBuffer_.size(), 0);
    }
  }

  static void onStreamProcess(void* data) {
    auto* self = static_cast<PortalSource*>(data);
    // Only the newest frame matters: give older queued ones straight back.
    struct pw_buffer* b = nullptr;
    while (struct pw_buffer* nb = pw_stream_dequeue_buffer(self->stream_)) {
      if (b) pw_stream_queue_buffer(self->stream_, b);
      b = nb;
    }
    if (!b) return;

    struct spa_buffer* buf = b->buffer;
    if (buf->n_datas > 0 && buf->datas[0].data) {
      if (self->holdForEncoder(b)) return;   // zero-copy: the encoder reads PipeWire's memory
      self->consume(buf);
    }
    pw_stream_queue_buffer(self->stream_, b);
  }

  static void onAddBuffer(void* data, struct pw_buffer*) {
    auto* self = static_cast<PortalSource*>(data);
    std::lock_guard<std::mutex> lock(self->mu_);
    ++self->buffers_;
  }

  // PipeWire is about to free this buffer (renegotiation or shutdown). If the
  // encoder is still reading it, wait until it has finished with that frame.
  static void onRemoveBuffer(void* data, struct pw_buffer* b) {
    auto* self = static_cast<PortalSource*>(data);
    std::unique_lock<std::mutex> lock(self->mu_);
    --self->buffers_;
    if (b == self->pending_) { self->pending_ = nullptr; self->frameReady_ = false; }
    if (b == self->inUse_) {
      self->cv_.wait(lock, [&] { return !self->inUseBusy_ || !self->running_; });
      self->inUse_ = nullptr;
      self->inUseData_ = nullptr;
    }
  }

  // Zero-copy path: keep the dequeued buffer (instead of copying the frame
  // out of it) and let the encoder read it directly. It goes back to
  // PipeWire when the encoder takes the next frame. Needs a byte order the
  // encoder accepts (BGRx/BGRA) and at least 3 buffers, so the compositor
  // always has one to draw into while we hold two.
  bool holdForEncoder(struct pw_buffer* b) {
    const auto& plane = b->buffer->datas[0];
    if (!plane.chunk || !plane.data) return false;
    if (plane.chunk->flags & SPA_CHUNK_FLAG_CORRUPTED) return false;
    const int32_t srcStride = plane.chunk->stride;
    std::unique_lock<std::mutex> lock(mu_);
    if (!zeroCopy_ || buffers_ < 3 || srcStride <= 0) return false;
    if (width_ <= 0 || height_ <= 0 || width_ > 8192 || height_ > 8192) return false;
    const size_t rowBytes = static_cast<size_t>(width_) * 4;
    const size_t cx = static_cast<size_t>(cropPx_.x), cy = static_cast<size_t>(cropPx_.y);
    const size_t needed = (cy + height_ - 1) * srcStride + (cx * 4) + rowBytes;
    if (static_cast<size_t>(srcStride) < (cx * 4) + rowBytes || plane.chunk->offset > plane.maxsize ||
        needed > plane.maxsize - plane.chunk->offset || needed > plane.chunk->size) return false;
    if (pending_) pw_stream_queue_buffer(stream_, pending_);   // superseded before the encoder took it
    pending_ = b;
    pendingData_ = static_cast<const uint8_t*>(plane.data) + plane.chunk->offset + cy * srcStride + cx * 4;
    pendingStride_ = srcStride;
    noteArrival(steadyMicros());
    frontCapturedUs_ = steadyMicros();
    ++frameCount_;
    frameReady_ = true;
    lock.unlock();
    cv_.notify_all();
    return true;
  }

  void consume(struct spa_buffer* buf) {
    const auto& plane = buf->datas[0];
    if (!plane.chunk || !plane.data) return;
    const int32_t srcStride = plane.chunk->stride;
    if (srcStride <= 0) return;
    // Geometry is only changed by onStreamParamChanged, which runs on this same
    // PipeWire thread, as does every write to backBuffer_. So the full-frame
    // copy (several ms at 1440p) happens WITHOUT the lock the encoder thread
    // waits on; only the O(1) buffer swap is done under it.
    int width, height, format;
    Rect crop;
    {
      std::lock_guard<std::mutex> lock(mu_);
      width = width_; height = height_; crop = cropPx_; format = static_cast<int>(format_);
    }
    {
      if (width <= 0 || height <= 0 || width > 8192 || height > 8192) return;
      const int width_ = width, height_ = height;  // shadow members: nothing below touches shared state
      const uint32_t format_ = static_cast<uint32_t>(format);
      const size_t rowBytes = static_cast<size_t>(width_) * 4;
      const size_t cx = static_cast<size_t>(crop.x), cy = static_cast<size_t>(crop.y);
      const size_t needed = (cy + height_ - 1) * srcStride + (cx * 4) + rowBytes;
      if (static_cast<size_t>(srcStride) < (cx * 4) + rowBytes || plane.chunk->offset > plane.maxsize ||
          needed > plane.maxsize - plane.chunk->offset || needed > plane.chunk->size) return;
      const uint8_t* src = static_cast<const uint8_t*>(plane.data) + plane.chunk->offset + cy * srcStride + cx * 4;
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
    }
    {
      const uint64_t captured = steadyMicros();
      std::lock_guard<std::mutex> lock(mu_);
      // Geometry changed while we copied: this frame is the wrong size.
      if (width != width_ || height != height_) return;
      frontBuffer_.swap(backBuffer_);
      noteArrival(captured);
      frontCapturedUs_ = captured;
      ++frameCount_;
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
    core_ = directNode_ ? pw_context_connect(context_, nullptr, 0) : pw_context_connect_fd(context_, pwFd_, nullptr, 0);
    if (!core_) {
      pw_thread_loop_unlock(threadLoop_);
      error = "could not connect to the PipeWire remote from the portal";
      return false;
    }
    if (!directNode_) pwFd_ = -1;

    static const pw_stream_events events = [] {
      pw_stream_events e{};
      e.version = PW_VERSION_STREAM_EVENTS;
      e.param_changed = onStreamParamChanged;
      e.process = onStreamProcess;
      e.add_buffer = onAddBuffer;
      e.remove_buffer = onRemoveBuffer;
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
  mutable std::recursive_mutex inputMu_;  // input thread vs. frame thread
  std::string sessionHandle_;
  uint32_t nodeId_ = 0;
  uint32_t directNode_ = 0;   // test hook (PS_PIPEWIRE_NODE)
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
  uint64_t frontCapturedUs_ = 0;
  // zero-copy state (guarded by mu_)
  bool zeroCopy_ = false;
  int buffers_ = 0;
  struct pw_buffer* pending_ = nullptr;   // newest frame, not yet taken by the encoder
  struct pw_buffer* inUse_ = nullptr;     // frame the encoder is reading
  const uint8_t* pendingData_ = nullptr;
  const uint8_t* inUseData_ = nullptr;
  int pendingStride_ = 0, inUseStride_ = 0;
  bool inUseBusy_ = false;
  // Desktop frame interval (EMA, µs) and the frame we are holding back for.
  double arrivalUs_ = 0;
  uint64_t lastArrival_ = 0, heldFor_ = 0;
  void noteArrival(uint64_t t) {   // mu_ held
    if (lastArrival_ && t > lastArrival_) {
      const double d = static_cast<double>(t - lastArrival_);
      if (d < 200000) arrivalUs_ = arrivalUs_ > 0 ? arrivalUs_ * 0.8 + d * 0.2 : d;
    }
    lastArrival_ = t;
  }
  uint64_t lastPts_ = 0;
  std::chrono::steady_clock::time_point lastEmit_{};
  std::chrono::steady_clock::time_point tokensAt_{};
  double tokens_ = 1.0;

  // monitor selection
  Rect wantMonitor_, workspace_;
  Rect cropL_;    // logical crop inside the stream (empty = whole stream)
  Rect cropPx_;   // same in buffer pixels
  std::string restoreTokenIn_, restoreToken_, note_;

  // Picks the monitor out of a whole-workspace stream. KDE's picker offers
  // "Full workspace" (all screens as one wide image); if that is what came
  // back and the user chose a monitor in Penguin Stream, crop to it.
  void chooseCrop(bool havePos, int px, int py) {
    cropL_ = {};
    const int sw = inputWidth_, sh = inputHeight_;
    if (!wantMonitor_.valid() || sw <= 0 || sh <= 0) return;
    const bool biggerThanMonitor = sw > wantMonitor_.w + 8 || sh > wantMonitor_.h + 8;
    if (!biggerThanMonitor) return;  // user picked a single screen in the dialog: honour it
    int ox = 0, oy = 0;
    if (havePos) { ox = px; oy = py; }
    else if (workspace_.valid()) { ox = workspace_.x; oy = workspace_.y; }
    Rect c{wantMonitor_.x - ox, wantMonitor_.y - oy, wantMonitor_.w, wantMonitor_.h};
    if (c.x < 0 || c.y < 0 || c.x + c.w > sw + 2 || c.y + c.h > sh + 2) {
      note_ = "the shared area does not contain the chosen monitor; streaming everything that was shared";
      return;
    }
    c.w = std::min(c.w, sw - c.x);
    c.h = std::min(c.h, sh - c.y);
    cropL_ = c;
    note_ = "whole workspace shared; streaming only the chosen monitor (" + std::to_string(c.w) + "x" +
            std::to_string(c.h) + " at " + std::to_string(c.x) + "," + std::to_string(c.y) + ")";
  }
};

}  // namespace

std::unique_ptr<CaptureSource> makePortalPipeWireSource() {
  return std::make_unique<PortalSource>();
}

}  // namespace ps
