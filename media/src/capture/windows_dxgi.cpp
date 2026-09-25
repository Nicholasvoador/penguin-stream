// Windows capture (DXGI Desktop Duplication) and keyboard/mouse injection
// (SendInput) for one monitor.
//
// Frames are native-size, tightly packed, owned BGRA. The hardware cursor is
// not part of duplicated frames, so it is composited here from the pointer
// shape DXGI reports. Access loss (UAC prompt, lock screen, fullscreen mode
// switch) is recovered by re-duplicating while the last image is repeated.
#include "capture/source.h"
#include "input/keymap.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <exception>
#include <limits>
#include <mutex>
#include <set>
#include <thread>
#include <vector>

namespace ps {
namespace {
using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;

std::string dxgiError(const char* operation, HRESULT hr) {
  char code[16];
  std::snprintf(code, sizeof(code), "0x%08lX", static_cast<unsigned long>(hr));
  std::string result = std::string(operation) + ": " + code;
  if (hr == DXGI_ERROR_ACCESS_LOST)
    result += " (desktop duplication lost)";
  else if (hr == DXGI_ERROR_DEVICE_REMOVED || hr == DXGI_ERROR_DEVICE_RESET)
    result += " (D3D device lost)";
  else if (hr == E_ACCESSDENIED)
    result += " (desktop access denied: secure desktop, lock screen or no interactive session)";
  else if (hr == DXGI_ERROR_UNSUPPORTED)
    result += " (duplication unsupported on this adapter/output)";
  else if (hr == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE)
    result += " (too many applications are already duplicating this output)";
  return result;
}

// Physical-pixel coordinates everywhere: DXGI reports physical desktop
// rectangles and SendInput must agree with them on scaled (HiDPI) monitors.
void makeDpiAware() {
  static bool done = false;
  if (done) return;
  done = true;
  using SetCtx = BOOL(WINAPI*)(HANDLE);
  if (HMODULE user32 = GetModuleHandleW(L"user32.dll")) {
    if (auto set = reinterpret_cast<SetCtx>(reinterpret_cast<void*>(
            GetProcAddress(user32, "SetProcessDpiAwarenessContext")))) {
      if (set(reinterpret_cast<HANDLE>(-4))) return;  // PER_MONITOR_AWARE_V2
    }
  }
  SetProcessDPIAware();
}

struct AcquiredFrame {
  IDXGIOutputDuplication* duplication;
  bool held = true;
  explicit AcquiredFrame(IDXGIOutputDuplication* value) : duplication(value) {}
  AcquiredFrame(const AcquiredFrame&) = delete;
  AcquiredFrame& operator=(const AcquiredFrame&) = delete;
  ~AcquiredFrame() { if (held) duplication->ReleaseFrame(); }
  HRESULT release() { held = false; return duplication->ReleaseFrame(); }
};

struct MappedTexture {
  ID3D11DeviceContext* context;
  ID3D11Texture2D* texture;
  MappedTexture(ID3D11DeviceContext* c, ID3D11Texture2D* t) : context(c), texture(t) {}
  MappedTexture(const MappedTexture&) = delete;
  MappedTexture& operator=(const MappedTexture&) = delete;
  ~MappedTexture() { context->Unmap(texture, 0); }
};

struct PointerState {
  bool visible = false;
  int x = 0, y = 0;                           // top-left, output-relative
  DXGI_OUTDUPL_POINTER_SHAPE_INFO info{};
  std::vector<uint8_t> shape;
};

// Draws the DXGI pointer shape onto a BGRA frame (all three shape types).
void compositePointer(const PointerState& p, uint8_t* frame, int width, int height, int stride) {
  if (!p.visible || p.shape.empty()) return;
  const int type = static_cast<int>(p.info.Type);
  const int w = static_cast<int>(p.info.Width);
  const int h = type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME ? static_cast<int>(p.info.Height / 2)
                                                                  : static_cast<int>(p.info.Height);
  const int pitch = static_cast<int>(p.info.Pitch);
  for (int row = 0; row < h; ++row) {
    const int y = p.y + row;
    if (y < 0 || y >= height) continue;
    uint8_t* dst = frame + static_cast<size_t>(y) * stride;
    for (int col = 0; col < w; ++col) {
      const int x = p.x + col;
      if (x < 0 || x >= width) continue;
      uint8_t* px = dst + static_cast<size_t>(x) * 4;
      if (type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME) {
        const size_t andOff = static_cast<size_t>(row) * pitch + col / 8;
        const size_t xorOff = static_cast<size_t>(row + h) * pitch + col / 8;
        if (xorOff >= p.shape.size()) continue;
        const uint8_t bit = static_cast<uint8_t>(0x80 >> (col % 8));
        const bool andMask = (p.shape[andOff] & bit) != 0;
        const bool xorMask = (p.shape[xorOff] & bit) != 0;
        for (int c = 0; c < 3; ++c) {
          uint8_t v = andMask ? px[c] : 0;
          if (xorMask) v ^= 0xFF;
          px[c] = v;
        }
      } else {
        const size_t off = static_cast<size_t>(row) * pitch + static_cast<size_t>(col) * 4;
        if (off + 3 >= p.shape.size()) continue;
        const uint8_t* s = p.shape.data() + off;
        if (type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR) {
          const unsigned a = s[3];
          for (int c = 0; c < 3; ++c) px[c] = static_cast<uint8_t>((s[c] * a + px[c] * (255 - a)) / 255);
        } else {  // MASKED_COLOR: alpha 0 = replace, 0xFF = XOR with screen
          for (int c = 0; c < 3; ++c) px[c] = s[3] ? static_cast<uint8_t>(px[c] ^ s[c]) : s[c];
        }
      }
    }
  }
}

// SendInput-based keyboard/mouse injection for one captured monitor. Shared by
// the DXGI and GDI capture paths; thread-safe (control thread vs. frame thread).
class WinInjector {
 public:
  void setAllowed(bool allowed) {
    std::lock_guard<std::mutex> lock(mu_);
    allowed_ = allowed;
  }
  bool allowed() const {
    std::lock_guard<std::mutex> lock(mu_);
    return allowed_;
  }
  void setOutputRect(const RECT& r) {
    std::lock_guard<std::mutex> lock(mu_);
    outputRect_ = r;
  }

  bool input(const InputEvent& e) {
    std::lock_guard<std::mutex> lock(mu_);
    if (!allowed_) return false;
    switch (e.kind) {
      case InputKind::ReleaseAll:
        releaseHeldLocked();
        return true;
      case InputKind::MouseAbs:
        return sendAbsolute(e.x, e.y, 0);
      case InputKind::MouseRel: {
        INPUT in{};
        in.type = INPUT_MOUSE;
        in.mi.dx = e.dx;
        in.mi.dy = e.dy;
        in.mi.dwFlags = MOUSEEVENTF_MOVE;
        return SendInput(1, &in, sizeof(INPUT)) == 1;
      }
      case InputKind::MouseButton: {
        DWORD flag = 0, data = 0;
        buttonFlags(e.button, e.down, flag, data);
        const int id = static_cast<int>(e.button);
        if (e.down) heldButtons_.insert(id); else heldButtons_.erase(id);
        if (e.hasPosition) return sendAbsolute(e.x, e.y, flag, data);
        INPUT in{};
        in.type = INPUT_MOUSE;
        in.mi.dwFlags = flag;
        in.mi.mouseData = data;
        return SendInput(1, &in, sizeof(INPUT)) == 1;
      }
      case InputKind::Wheel: {
        INPUT in[2]{};
        UINT n = 0;
        if (e.wheelY != 0) {
          in[n].type = INPUT_MOUSE;
          in[n].mi.dwFlags = MOUSEEVENTF_WHEEL;
          in[n].mi.mouseData = static_cast<DWORD>(static_cast<LONG>(e.wheelY * WHEEL_DELTA));
          ++n;
        }
        if (e.wheelX != 0) {
          in[n].type = INPUT_MOUSE;
          in[n].mi.dwFlags = MOUSEEVENTF_HWHEEL;
          in[n].mi.mouseData = static_cast<DWORD>(static_cast<LONG>(e.wheelX * WHEEL_DELTA));
          ++n;
        }
        return n == 0 || SendInput(n, in, sizeof(INPUT)) == n;
      }
      case InputKind::Key: {
        NativeKey key;
        if (!lookupHidKey(e.hid, key)) return false;
        if (e.down && !heldKeys_.count(e.hid) && heldKeys_.size() >= 64) return false;
        if (e.down) heldKeys_.insert(e.hid); else heldKeys_.erase(e.hid);
        return sendKey(key, e.down);  // repeats re-send key-down: injected keys never auto-repeat
      }
      default:
        return false;  // controllers are handled by VirtualGamepads
    }
  }

  void releaseHeld() {
    std::lock_guard<std::mutex> lock(mu_);
    releaseHeldLocked();
  }

 private:
  static void buttonFlags(MouseButton b, bool down, DWORD& flag, DWORD& data) {
    switch (b) {
      case MouseButton::Left: flag = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP; break;
      case MouseButton::Right: flag = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP; break;
      case MouseButton::Middle: flag = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP; break;
      case MouseButton::X1: flag = down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP; data = XBUTTON1; break;
      case MouseButton::X2: flag = down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP; data = XBUTTON2; break;
    }
  }

  // Maps 0..1 of the captured output onto the whole virtual desktop, so the
  // right monitor is hit on multi-monitor hosts.
  bool sendAbsolute(double nx, double ny, DWORD extraFlags, DWORD data = 0) {
    const int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    const int vw = std::max(2, GetSystemMetrics(SM_CXVIRTUALSCREEN));
    const int vh = std::max(2, GetSystemMetrics(SM_CYVIRTUALSCREEN));
    const double ow = std::max<LONG>(1, outputRect_.right - outputRect_.left);
    const double oh = std::max<LONG>(1, outputRect_.bottom - outputRect_.top);
    const double px = outputRect_.left + std::clamp(nx, 0.0, 1.0) * (ow - 1);
    const double py = outputRect_.top + std::clamp(ny, 0.0, 1.0) * (oh - 1);
    INPUT in{};
    in.type = INPUT_MOUSE;
    in.mi.dx = static_cast<LONG>((px - vx) * 65535.0 / (vw - 1) + 0.5);
    in.mi.dy = static_cast<LONG>((py - vy) * 65535.0 / (vh - 1) + 0.5);
    in.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | extraFlags;
    in.mi.mouseData = data;
    return SendInput(1, &in, sizeof(INPUT)) == 1;
  }

  static bool sendKey(const NativeKey& key, bool down) {
    INPUT in{};
    in.type = INPUT_KEYBOARD;
    if (key.winScan) {
      in.ki.wScan = key.winScan;
      in.ki.dwFlags = KEYEVENTF_SCANCODE | (key.winExtended ? KEYEVENTF_EXTENDEDKEY : 0);
    } else if (key.winVk) {
      in.ki.wVk = key.winVk;
      in.ki.wScan = static_cast<WORD>(MapVirtualKeyW(key.winVk, MAPVK_VK_TO_VSC));
    } else {
      return false;
    }
    if (!down) in.ki.dwFlags |= KEYEVENTF_KEYUP;
    return SendInput(1, &in, sizeof(INPUT)) == 1;
  }

  void releaseHeldLocked() {
    for (int id : heldButtons_) {
      DWORD flag = 0, data = 0;
      buttonFlags(static_cast<MouseButton>(id), false, flag, data);
      INPUT in{};
      in.type = INPUT_MOUSE;
      in.mi.dwFlags = flag;
      in.mi.mouseData = data;
      SendInput(1, &in, sizeof(INPUT));
    }
    heldButtons_.clear();
    for (int hid : heldKeys_) {
      NativeKey key;
      if (lookupHidKey(hid, key)) sendKey(key, false);
    }
    heldKeys_.clear();
  }

  mutable std::mutex mu_;
  bool allowed_ = false;
  std::set<int> heldButtons_;
  std::set<int> heldKeys_;
  RECT outputRect_{};
};

class DxgiSource final : public CaptureSource {
 public:
  ~DxgiSource() override { stop(); }

  bool start(const CaptureOptions& opts, std::string& error) override {
    stop();
    makeDpiAware();
    error.clear();
    injector_.setAllowed(opts.allowInput);
    auto fail = [&](const std::string& message) {
      error = message;
      stop();
      return false;
    };
    monitor_ = 0;
    primaryDefault_ = opts.display.empty();
    for (char c : opts.display) {
      if (c < '0' || c > '9' || monitor_ > 1000) return fail("DXGI display must be a small nonnegative monitor index");
      monitor_ = monitor_ * 10 + static_cast<unsigned>(c - '0');
    }
    if (opts.width < 0 || opts.height < 0 || opts.fps < 0 || opts.fps > 1000)
      return fail("DXGI requires nonnegative dimensions and fps in 0..1000 (0 means 60)");

    if (!duplicate(error)) return fail(error);
    width_ = static_cast<int>(nativeWidth_ & ~1u);
    height_ = static_cast<int>(nativeHeight_ & ~1u);
    if ((opts.width && opts.width != width_ && opts.width != static_cast<int>(nativeWidth_)) ||
        (opts.height && opts.height != height_ && opts.height != static_cast<int>(nativeHeight_)))
      return fail("DXGI resizing is not supported; omit width/height or request native dimensions");
    stride_ = width_ * 4;
    try {
      desktop_.assign(static_cast<size_t>(stride_) * height_, 0);
      buffer_.assign(desktop_.size(), 0);
    } catch (const std::exception&) {
      return fail("DXGI BGRA buffer allocation failed");
    }
    period_ = std::chrono::microseconds(1000000 / (opts.fps ? opts.fps : 60));
    nextDue_ = Clock::now();
    running_ = true;
    return true;
  }

  void stop() override {
    injector_.releaseHeld();
    running_ = false;
    haveFrame_ = false;
    releaseDuplication();
    desktop_.clear();
    buffer_.clear();
    pointer_ = PointerState{};
    width_ = height_ = stride_ = 0;
    nativeWidth_ = nativeHeight_ = 0;
    lastPts_ = 0;
  }

  bool nextFrame(CaptureFrame& out, std::string& error) override {
    out = {};
    error.clear();
    if (!running_) {
      error = "DXGI capture is not running; call start() before nextFrame()";
      return false;
    }
    std::this_thread::sleep_until(nextDue_);

    if (!duplication_) {
      // Recovering from access loss: retry a few times per second while the
      // viewer keeps receiving the last good image.
      if (Clock::now() >= retryAt_) {
        std::string why;
        UINT oldW = nativeWidth_, oldH = nativeHeight_;
        if (duplicate(why)) {
          if (nativeWidth_ != oldW || nativeHeight_ != oldH) {
            error = "the captured display changed resolution; restart sharing";
            running_ = false;
            return false;
          }
          pointer_.visible = false;
        } else {
          retryAt_ = Clock::now() + std::chrono::milliseconds(250);
        }
      }
    }

    if (duplication_) {
      // The first acquisition may carry only a pointer update; keep waiting
      // (bounded) until real desktop pixels exist.
      const auto firstDeadline = Clock::now() + std::chrono::seconds(2);
      HRESULT hr;
      do {
        hr = acquire(error);
      } while (!haveFrame_ && hr == DXGI_ERROR_WAIT_TIMEOUT && Clock::now() < firstDeadline);
      if (hr == DXGI_ERROR_ACCESS_LOST || hr == DXGI_ERROR_INVALID_CALL || hr == E_ACCESSDENIED) {
        releaseDuplication();
        retryAt_ = Clock::now();
        if (!haveFrame_) {
          error = dxgiError("AcquireNextFrame", hr);
          running_ = false;
          return false;
        }
      } else if (FAILED(hr) && hr != DXGI_ERROR_WAIT_TIMEOUT) {
        running_ = false;
        return false;  // error already describes it
      } else if (hr == DXGI_ERROR_WAIT_TIMEOUT && !haveFrame_) {
        error = "DXGI first-frame timeout after 1000 ms; retry capture on an active desktop";
        running_ = false;
        return false;
      }
    }

    std::memcpy(buffer_.data(), desktop_.data(), buffer_.size());
    compositePointer(pointer_, buffer_.data(), width_, height_, stride_);

    const auto now = Clock::now();
    if (!haveFrame_) {
      epoch_ = now;
      lastPts_ = 0;
    } else {
      const auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(now - epoch_).count();
      lastPts_ = std::max(lastPts_ + 1, static_cast<uint64_t>(elapsed));
    }
    haveFrame_ = true;
    nextDue_ = now + period_;  // never burst to catch up after a slow consumer
    out.bgra = buffer_.data();
    out.stride = stride_;
    out.width = width_;
    out.height = height_;
    out.pts_us = lastPts_;
    return true;
  }

  bool input(const InputEvent& e) override { return injector_.input(e); }
  bool inputReady() const override { return injector_.allowed(); }

  int width() const override { return width_; }
  int height() const override { return height_; }
  const char* name() const override { return "dxgi"; }

 private:
  bool duplicate(std::string& error) {
    releaseDuplication();
    ComPtr<IDXGIFactory1> factory;
    HRESULT hr = CreateDXGIFactory1(IID_PPV_ARGS(factory.GetAddressOf()));
    if (FAILED(hr)) { error = dxgiError("CreateDXGIFactory1", hr); return false; }
    ComPtr<IDXGIAdapter1> selectedAdapter;
    ComPtr<IDXGIOutput> selectedOutput;
    DXGI_OUTPUT_DESC outputDesc{};
    unsigned remaining = monitor_;
    for (UINT a = 0; !selectedOutput; ++a) {
      ComPtr<IDXGIAdapter1> adapter;
      hr = factory->EnumAdapters1(a, adapter.GetAddressOf());
      if (hr == DXGI_ERROR_NOT_FOUND) break;
      if (FAILED(hr)) { error = dxgiError("EnumAdapters1", hr); return false; }
      for (UINT o = 0;; ++o) {
        ComPtr<IDXGIOutput> output;
        hr = adapter->EnumOutputs(o, output.GetAddressOf());
        if (hr == DXGI_ERROR_NOT_FOUND) break;
        if (FAILED(hr)) { error = dxgiError("EnumOutputs", hr); return false; }
        DXGI_OUTPUT_DESC desc{};
        if (FAILED(output->GetDesc(&desc)) || !desc.AttachedToDesktop) continue;
        // Without an explicit index, share the main monitor: the one whose
        // desktop rectangle starts at the origin.
        const bool primary = desc.DesktopCoordinates.left == 0 && desc.DesktopCoordinates.top == 0;
        if (primaryDefault_ ? primary : remaining == 0) {
          selectedAdapter = adapter;
          selectedOutput = output;
          outputDesc = desc;
          break;
        }
        --remaining;
      }
    }
    if (!selectedOutput && primaryDefault_) {
      // No output at the origin (unusual layouts): fall back to the first one.
      primaryDefault_ = false;
      remaining = 0;
      return duplicate(error);
    }
    if (!selectedOutput) { error = "DXGI monitor index not found among attached outputs"; return false; }

    // The device must live on the adapter that owns the output, or duplication
    // fails with DXGI_ERROR_UNSUPPORTED on hybrid-GPU laptops.
    hr = D3D11CreateDevice(selectedAdapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                           D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
                           device_.GetAddressOf(), nullptr, context_.GetAddressOf());
    if (FAILED(hr)) { error = dxgiError("D3D11CreateDevice", hr); return false; }
    ComPtr<IDXGIOutput1> output1;
    hr = selectedOutput.As(&output1);
    if (FAILED(hr)) { error = dxgiError("Query IDXGIOutput1", hr); releaseDuplication(); return false; }
    hr = output1->DuplicateOutput(device_.Get(), duplication_.GetAddressOf());
    if (FAILED(hr)) { error = dxgiError("DuplicateOutput", hr); releaseDuplication(); return false; }

    DXGI_OUTDUPL_DESC desc{};
    duplication_->GetDesc(&desc);
    if (desc.Rotation != DXGI_MODE_ROTATION_IDENTITY && desc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED) {
      error = "DXGI rotated (portrait) outputs are not supported yet; use landscape orientation";
      releaseDuplication();
      return false;
    }
    if (desc.ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
      error = "DXGI duplication did not provide BGRA8 pixels";
      releaseDuplication();
      return false;
    }
    const UINT w = desc.ModeDesc.Width, h = desc.ModeDesc.Height;
    if (w < 2 || h < 2 || w > 16384 || h > 16384) {
      error = "DXGI reported invalid desktop dimensions";
      releaseDuplication();
      return false;
    }
    nativeWidth_ = w;
    nativeHeight_ = h;
    injector_.setOutputRect(outputDesc.DesktopCoordinates);

    D3D11_TEXTURE2D_DESC stagingDesc{};
    stagingDesc.Width = w;
    stagingDesc.Height = h;
    stagingDesc.MipLevels = 1;
    stagingDesc.ArraySize = 1;
    stagingDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    stagingDesc.SampleDesc.Count = 1;
    stagingDesc.Usage = D3D11_USAGE_STAGING;
    stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    hr = device_->CreateTexture2D(&stagingDesc, nullptr, staging_.GetAddressOf());
    if (FAILED(hr)) { error = dxgiError("CreateTexture2D(staging)", hr); releaseDuplication(); return false; }
    return true;
  }

  void releaseDuplication() {
    staging_.Reset();
    duplication_.Reset();
    context_.Reset();
    device_.Reset();
  }

  // Returns S_OK (desktop and/or pointer updated), DXGI_ERROR_WAIT_TIMEOUT
  // (nothing new) or a failure HRESULT with `error` set.
  HRESULT acquire(std::string& error) {
    DXGI_OUTDUPL_FRAME_INFO info{};
    ComPtr<IDXGIResource> resource;
    HRESULT hr = duplication_->AcquireNextFrame(haveFrame_ ? 0 : 1000, &info, resource.GetAddressOf());
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) return hr;
    if (FAILED(hr)) { error = dxgiError("AcquireNextFrame", hr); return hr; }
    AcquiredFrame acquired(duplication_.Get());

    if (info.LastMouseUpdateTime.QuadPart != 0) {
      pointer_.visible = info.PointerPosition.Visible != FALSE;
      pointer_.x = info.PointerPosition.Position.x;
      pointer_.y = info.PointerPosition.Position.y;
    }
    if (info.PointerShapeBufferSize > 0 && info.PointerShapeBufferSize < 4u * 1024 * 1024) {
      std::vector<uint8_t> shape(info.PointerShapeBufferSize);
      UINT required = 0;
      DXGI_OUTDUPL_POINTER_SHAPE_INFO shapeInfo{};
      if (SUCCEEDED(duplication_->GetFramePointerShape(static_cast<UINT>(shape.size()), shape.data(),
                                                       &required, &shapeInfo))) {
        pointer_.info = shapeInfo;
        pointer_.shape.swap(shape);
      }
    }

    if (info.LastPresentTime.QuadPart != 0 && resource) {
      ComPtr<ID3D11Texture2D> texture;
      hr = resource.As(&texture);
      if (FAILED(hr)) { error = dxgiError("Query desktop texture", hr); return hr; }
      D3D11_TEXTURE2D_DESC desc{};
      texture->GetDesc(&desc);
      if (desc.Width != nativeWidth_ || desc.Height != nativeHeight_ ||
          desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
        error = "the captured display changed resolution or format; restart sharing";
        return E_FAIL;
      }
      context_->CopyResource(staging_.Get(), texture.Get());
      D3D11_MAPPED_SUBRESOURCE mapped{};
      hr = context_->Map(staging_.Get(), 0, D3D11_MAP_READ, 0, &mapped);
      if (FAILED(hr)) { error = dxgiError("Map(staging)", hr); return hr; }
      {
        MappedTexture mapping(context_.Get(), staging_.Get());
        const size_t pitch = mapped.RowPitch;
        const size_t rowBytes = static_cast<size_t>(stride_);
        if (!mapped.pData || pitch < rowBytes) {
          error = "DXGI staging map has an invalid RowPitch";
          return E_FAIL;
        }
        const auto* pixels = static_cast<const uint8_t*>(mapped.pData);
        for (int y = 0; y < height_; ++y)
          std::memcpy(desktop_.data() + static_cast<size_t>(y) * rowBytes, pixels + y * pitch, rowBytes);
      }
    } else if (!haveFrame_) {
      // First acquisition carried only a pointer update; wait for pixels.
      acquired.release();
      return DXGI_ERROR_WAIT_TIMEOUT;
    }
    hr = acquired.release();
    if (FAILED(hr)) { error = dxgiError("ReleaseFrame", hr); return hr; }
    return S_OK;
  }

  WinInjector injector_;

  // capture state (frame thread)
  unsigned monitor_ = 0;
  bool primaryDefault_ = true;
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<IDXGIOutputDuplication> duplication_;
  ComPtr<ID3D11Texture2D> staging_;
  std::vector<uint8_t> desktop_;   // last clean desktop image
  std::vector<uint8_t> buffer_;    // desktop + cursor, handed to the encoder
  PointerState pointer_;
  UINT nativeWidth_ = 0, nativeHeight_ = 0;
  int width_ = 0, height_ = 0, stride_ = 0;
  bool running_ = false, haveFrame_ = false;
  uint64_t lastPts_ = 0;
  Clock::time_point epoch_{}, nextDue_{}, retryAt_{};
  std::chrono::microseconds period_{16666};
};

// GDI fallback: BitBlt from the screen DC. Slower than DXGI but works where
// Desktop Duplication does not (Remote Desktop sessions, some VMs, drivers
// without duplication support, Wine). The cursor is drawn with DrawIconEx.
class GdiSource final : public CaptureSource {
 public:
  ~GdiSource() override { stop(); }

  bool start(const CaptureOptions& opts, std::string& error) override {
    stop();
    makeDpiAware();
    injector_.setAllowed(opts.allowInput);
    std::vector<RECT> monitors;
    RECT primary{};
    struct Ctx { std::vector<RECT>* list; RECT* primary; } ctx{&monitors, &primary};
    EnumDisplayMonitors(nullptr, nullptr, [](HMONITOR m, HDC, LPRECT, LPARAM data) -> BOOL {
      auto* c = reinterpret_cast<Ctx*>(data);
      MONITORINFO mi{};
      mi.cbSize = sizeof(mi);
      if (GetMonitorInfoW(m, &mi)) {
        if (mi.dwFlags & MONITORINFOF_PRIMARY) *c->primary = mi.rcMonitor;
        c->list->push_back(mi.rcMonitor);
      }
      return TRUE;
    }, reinterpret_cast<LPARAM>(&ctx));
    if (monitors.empty()) { error = "GDI: no monitors found"; return false; }
    if (opts.display.empty()) {
      rect_ = (primary.right > primary.left) ? primary : monitors[0];
    } else {
      unsigned index = 0;
      for (char c : opts.display) {
        if (c < '0' || c > '9' || index > 1000) { error = "GDI display must be a monitor index"; return false; }
        index = index * 10 + static_cast<unsigned>(c - '0');
      }
      if (index >= monitors.size()) { error = "GDI monitor index not found"; return false; }
      rect_ = monitors[index];
    }
    const int nativeW = rect_.right - rect_.left, nativeH = rect_.bottom - rect_.top;
    if (nativeW < 2 || nativeH < 2 || nativeW > 16384 || nativeH > 16384) {
      error = "GDI reported invalid monitor dimensions";
      return false;
    }
    width_ = nativeW & ~1;
    height_ = nativeH & ~1;
    if ((opts.width && opts.width != width_ && opts.width != nativeW) ||
        (opts.height && opts.height != height_ && opts.height != nativeH)) {
      error = "GDI resizing is not supported; omit width/height";
      return false;
    }
    screen_ = GetDC(nullptr);
    mem_ = CreateCompatibleDC(screen_);
    BITMAPINFO bmi{};
    bmi.bmiHeader.biSize = sizeof(bmi.bmiHeader);
    bmi.bmiHeader.biWidth = width_;
    bmi.bmiHeader.biHeight = -height_;  // top-down rows
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    bitmap_ = CreateDIBSection(mem_, &bmi, DIB_RGB_COLORS, &bits_, nullptr, 0);
    if (!screen_ || !mem_ || !bitmap_ || !bits_) {
      error = "GDI: could not create capture surfaces";
      stop();
      return false;
    }
    old_ = SelectObject(mem_, bitmap_);
    injector_.setOutputRect(rect_);
    period_ = std::chrono::microseconds(1000000 / (opts.fps > 0 ? opts.fps : 60));
    nextDue_ = Clock::now();
    epoch_ = nextDue_;
    running_ = true;
    return true;
  }

  void stop() override {
    injector_.releaseHeld();
    running_ = false;
    if (mem_ && old_) SelectObject(mem_, old_);
    if (bitmap_) DeleteObject(bitmap_);
    if (mem_) DeleteDC(mem_);
    if (screen_) ReleaseDC(nullptr, screen_);
    bitmap_ = nullptr;
    mem_ = nullptr;
    screen_ = nullptr;
    old_ = nullptr;
    bits_ = nullptr;
  }

  bool nextFrame(CaptureFrame& out, std::string& error) override {
    out = {};
    if (!running_) { error = "GDI capture is not running"; return false; }
    std::this_thread::sleep_until(nextDue_);
    if (!BitBlt(mem_, 0, 0, width_, height_, screen_, rect_.left, rect_.top, SRCCOPY)) {
      // The secure desktop (UAC, lock screen) refuses BitBlt; keep the last image.
    }
    CURSORINFO ci{};
    ci.cbSize = sizeof(ci);
    if (GetCursorInfo(&ci) && (ci.flags & CURSOR_SHOWING) && ci.hCursor) {
      ICONINFO ii{};
      if (GetIconInfo(ci.hCursor, &ii)) {
        DrawIconEx(mem_, ci.ptScreenPos.x - rect_.left - static_cast<int>(ii.xHotspot),
                   ci.ptScreenPos.y - rect_.top - static_cast<int>(ii.yHotspot), ci.hCursor, 0, 0, 0,
                   nullptr, DI_NORMAL);
        if (ii.hbmMask) DeleteObject(ii.hbmMask);
        if (ii.hbmColor) DeleteObject(ii.hbmColor);
      }
    }
    GdiFlush();
    const auto now = Clock::now();
    nextDue_ = now + period_;
    const uint64_t pts = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(now - epoch_).count());
    lastPts_ = frames_++ ? std::max(lastPts_ + 1, pts) : 0;
    out.bgra = static_cast<const uint8_t*>(bits_);
    out.stride = width_ * 4;
    out.width = width_;
    out.height = height_;
    out.pts_us = lastPts_;
    return true;
  }

  bool input(const InputEvent& e) override { return injector_.input(e); }
  bool inputReady() const override { return injector_.allowed(); }
  int width() const override { return width_; }
  int height() const override { return height_; }
  const char* name() const override { return "gdi"; }

 private:
  WinInjector injector_;
  RECT rect_{};
  HDC screen_ = nullptr, mem_ = nullptr;
  HBITMAP bitmap_ = nullptr;
  HGDIOBJ old_ = nullptr;
  void* bits_ = nullptr;
  int width_ = 0, height_ = 0;
  bool running_ = false;
  uint64_t frames_ = 0, lastPts_ = 0;
  Clock::time_point epoch_{}, nextDue_{};
  std::chrono::microseconds period_{16666};
};
}  // namespace

std::unique_ptr<CaptureSource> makeDxgiSource() { return std::make_unique<DxgiSource>(); }
std::unique_ptr<CaptureSource> makeGdiSource() { return std::make_unique<GdiSource>(); }
}  // namespace ps
