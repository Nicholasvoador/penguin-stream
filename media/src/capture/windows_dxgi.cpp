// DXGI Desktop Duplication: native-size, tightly packed, owned BGRA frames.
#include "capture/source.h"
#include "ipc/framing.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <set>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <exception>
#include <limits>
#include <thread>

namespace ps {
namespace {
using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;

std::string dxgiError(const char* operation, HRESULT hr) {
  char code[16];
  std::snprintf(code, sizeof(code), "0x%08lX", static_cast<unsigned long>(hr));
  std::string result = std::string(operation) + ": " + code;
  if (hr == DXGI_ERROR_ACCESS_LOST)
    result += " (desktop duplication lost; stop/start capture after the desktop or mode change)";
  else if (hr == DXGI_ERROR_DEVICE_REMOVED || hr == DXGI_ERROR_DEVICE_RESET)
    result += " (D3D device lost; stop/start capture)";
  else if (hr == E_ACCESSDENIED)
    result += " (desktop access denied; use an accessible interactive desktop)";
  return result;
}

// Declared only after a successful acquire/map. Every exit releases ownership.
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

class DxgiSource final : public CaptureSource {
 public:
  ~DxgiSource() override { stop(); }

  bool start(const CaptureOptions& opts, std::string& error) override {
    stop();
    error.clear();
    allowInput_ = opts.allowInput;
    auto fail = [&](const std::string& message) {
      error = message;
      stop();
      return false;
    };
    // Flat zero-based index across attached outputs of all DXGI adapters.
    unsigned monitor = 0;
    for (char c : opts.display) {
      if (c < '0' || c > '9' ||
          monitor > (std::numeric_limits<unsigned>::max() - static_cast<unsigned>(c - '0')) / 10)
        return fail("DXGI display must be a nonnegative decimal monitor index");
      monitor = monitor * 10 + static_cast<unsigned>(c - '0');
    }
    if (opts.width < 0 || opts.height < 0 || opts.fps < 0 || opts.fps > 1000)
      return fail("DXGI requires nonnegative dimensions and fps in 0..1000 (0 means 60)");

    ComPtr<IDXGIFactory1> factory;
    HRESULT hr = CreateDXGIFactory1(IID_PPV_ARGS(factory.GetAddressOf()));
    if (FAILED(hr)) return fail(dxgiError("CreateDXGIFactory1", hr));
    ComPtr<IDXGIAdapter1> selectedAdapter;
    ComPtr<IDXGIOutput> selectedOutput;
    for (UINT a = 0; !selectedOutput; ++a) {
      ComPtr<IDXGIAdapter1> adapter;
      hr = factory->EnumAdapters1(a, adapter.GetAddressOf());
      if (hr == DXGI_ERROR_NOT_FOUND) break;
      if (FAILED(hr)) return fail(dxgiError("EnumAdapters1", hr));
      for (UINT o = 0; ; ++o) {
        ComPtr<IDXGIOutput> output;
        hr = adapter->EnumOutputs(o, output.GetAddressOf());
        if (hr == DXGI_ERROR_NOT_FOUND) break;
        if (FAILED(hr)) return fail(dxgiError("EnumOutputs", hr));
        DXGI_OUTPUT_DESC desc{};
        hr = output->GetDesc(&desc);
        if (FAILED(hr)) return fail(dxgiError("GetDesc(output)", hr));
        if (!desc.AttachedToDesktop) continue;
        if (monitor == 0) {
          selectedAdapter = adapter;
          selectedOutput = output;
          break;
        }
        --monitor;
      }
    }
    if (!selectedOutput) return fail("DXGI monitor index not found among attached outputs");

    hr = D3D11CreateDevice(selectedAdapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                           D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                           D3D11_SDK_VERSION, device_.GetAddressOf(), nullptr,
                           context_.GetAddressOf());
    if (FAILED(hr)) return fail(dxgiError("D3D11CreateDevice", hr));
    ComPtr<IDXGIOutput1> output1;
    hr = selectedOutput.As(&output1);
    if (FAILED(hr)) return fail(dxgiError("Query IDXGIOutput1", hr));
    hr = output1->DuplicateOutput(device_.Get(), duplication_.GetAddressOf());
    if (FAILED(hr)) return fail(dxgiError("DuplicateOutput", hr));

    DXGI_OUTDUPL_DESC desc{};
    duplication_->GetDesc(&desc);
    if (desc.Rotation != DXGI_MODE_ROTATION_IDENTITY &&
        desc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED)
      return fail("DXGI rotated outputs are not supported; use landscape orientation");
    if (desc.ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM)
      return fail("DXGI duplication did not provide BGRA8 pixels");
    nativeWidth_ = desc.ModeDesc.Width;
    nativeHeight_ = desc.ModeDesc.Height;
    if (nativeWidth_ < 2 || nativeHeight_ < 2 ||
        nativeWidth_ > static_cast<UINT>(std::numeric_limits<int>::max() / 4) ||
        nativeHeight_ > static_cast<UINT>(std::numeric_limits<int>::max()))
      return fail("DXGI reported invalid or oversized desktop dimensions");
    // Encoder uses 4:2:0: crop at most one right/bottom pixel, never scale.
    width_ = static_cast<int>(nativeWidth_ & ~1u);
    height_ = static_cast<int>(nativeHeight_ & ~1u);
    if ((opts.width && opts.width != width_ && opts.width != static_cast<int>(nativeWidth_)) ||
        (opts.height && opts.height != height_ && opts.height != static_cast<int>(nativeHeight_)))
      return fail("DXGI resizing is not supported; omit width/height or request native dimensions");
    stride_ = width_ * 4;
    const size_t rowBytes = static_cast<size_t>(stride_);
    if (static_cast<size_t>(height_) > std::numeric_limits<size_t>::max() / rowBytes)
      return fail("DXGI BGRA buffer size overflow");
    try {
      buffer_.resize(rowBytes * static_cast<size_t>(height_));
    } catch (const std::exception&) {
      return fail("DXGI BGRA buffer allocation failed");
    }

    D3D11_TEXTURE2D_DESC stagingDesc{};
    stagingDesc.Width = nativeWidth_;
    stagingDesc.Height = nativeHeight_;
    stagingDesc.MipLevels = 1;
    stagingDesc.ArraySize = 1;
    stagingDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    stagingDesc.SampleDesc.Count = 1;
    stagingDesc.Usage = D3D11_USAGE_STAGING;
    stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    hr = device_->CreateTexture2D(&stagingDesc, nullptr, staging_.GetAddressOf());
    if (FAILED(hr)) return fail(dxgiError("CreateTexture2D(staging)", hr));
    period_ = std::chrono::microseconds(1000000 / (opts.fps ? opts.fps : 60));
    nextDue_ = Clock::now();
    running_ = true;
    return true;
  }

  void stop() override {
    if (allowInput_) releaseHeld();
    running_ = false;
    haveFrame_ = false;
    staging_.Reset();
    duplication_.Reset();
    context_.Reset();
    device_.Reset();
    buffer_.clear();
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
    auto fail = [&](const std::string& message) {
      error = message;
      running_ = false;
      return false;
    };
    std::this_thread::sleep_until(nextDue_);
    DXGI_OUTDUPL_FRAME_INFO info{};
    ComPtr<IDXGIResource> resource;
    // A bounded wait for the first image; after that, idle means repeat the
    // owned last image at the requested cadence, not end-of-stream or a spin.
    HRESULT hr = duplication_->AcquireNextFrame(haveFrame_ ? 0 : 1000, &info,
                                                resource.GetAddressOf());
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
      if (!haveFrame_) return fail("DXGI first-frame timeout after 1000 ms; retry capture on an active desktop");
    } else if (FAILED(hr)) {
      return fail(dxgiError("AcquireNextFrame", hr));
    } else {
      AcquiredFrame acquired(duplication_.Get());
      ComPtr<ID3D11Texture2D> texture;
      hr = resource.As(&texture);
      if (FAILED(hr)) return fail(dxgiError("Query desktop texture", hr));
      D3D11_TEXTURE2D_DESC desc{};
      texture->GetDesc(&desc);
      if (desc.Width != nativeWidth_ || desc.Height != nativeHeight_ ||
          desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM || desc.MipLevels != 1 ||
          desc.ArraySize != 1 || desc.SampleDesc.Count != 1 || desc.SampleDesc.Quality != 0)
        return fail("DXGI desktop texture changed or is incompatible; stop/start capture");
      context_->CopyResource(staging_.Get(), texture.Get());
      D3D11_MAPPED_SUBRESOURCE mapped{};
      hr = context_->Map(staging_.Get(), 0, D3D11_MAP_READ, 0, &mapped);
      if (FAILED(hr)) return fail(dxgiError("Map(staging)", hr));
      {
        MappedTexture mapping(context_.Get(), staging_.Get());
        const size_t pitch = mapped.RowPitch;
        const size_t rows = static_cast<size_t>(height_);
        const size_t rowBytes = static_cast<size_t>(stride_);
        if (!mapped.pData || pitch < static_cast<size_t>(nativeWidth_) * 4 ||
            (rows - 1) > (std::numeric_limits<size_t>::max() - rowBytes) / pitch)
          return fail("DXGI staging map has invalid RowPitch or overflowing row offsets");
        const auto* pixels = static_cast<const uint8_t*>(mapped.pData);
        for (size_t y = 0; y < rows; ++y)
          std::memcpy(buffer_.data() + y * rowBytes, pixels + y * pitch, rowBytes);
      }  // Unmap before ReleaseFrame; no mapped pointer escapes.
      hr = acquired.release();
      if (FAILED(hr)) return fail(dxgiError("ReleaseFrame", hr));
    }

    const auto now = Clock::now();
    if (!haveFrame_) {
      epoch_ = now;
      lastPts_ = 0;
    } else {
      const auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(now - epoch_).count();
      lastPts_ = std::max(lastPts_ + 1, static_cast<uint64_t>(elapsed));
    }
    haveFrame_ = true;
    nextDue_ = now + period_;  // Never burst to catch up after a slow consumer.
    out.bgra = buffer_.data();
    out.stride = stride_;
    out.width = width_;
    out.height = height_;
    out.pts_us = lastPts_;
    return true;
  }

  bool input(const std::string& json) override {
    if (!allowInput_) return false;
    std::string t;
    if (!jsonGetString(json, "t", t)) return false;

    if (t == "release_all") {
      releaseHeld();
      return true;
    }

    if (t == "gamepad_button") {
      std::string btn;
      if (!jsonGetString(json, "button", btn)) return false;
      const bool down = json.find("\"down\":true") != std::string::npos;
      WORD vk = 0;
      if (btn == "a") vk = VK_SPACE;
      else if (btn == "b") vk = VK_ESCAPE;
      else if (btn == "x") vk = 'E';
      else if (btn == "y") vk = 'F';
      else if (btn == "start") vk = VK_RETURN;
      else if (btn == "back") vk = VK_ESCAPE;
      else if (btn == "dpad_up") vk = VK_UP;
      else if (btn == "dpad_down") vk = VK_DOWN;
      else if (btn == "dpad_left") vk = VK_LEFT;
      else if (btn == "dpad_right") vk = VK_RIGHT;
      else if (btn == "lb") {
        INPUT in{}; in.type = INPUT_MOUSE; in.mi.dwFlags = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
        SendInput(1, &in, sizeof(INPUT));
        return true;
      } else if (btn == "rb") {
        INPUT in{}; in.type = INPUT_MOUSE; in.mi.dwFlags = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
        SendInput(1, &in, sizeof(INPUT));
        return true;
      }
      if (vk != 0) {
        INPUT in{}; in.type = INPUT_KEYBOARD; in.ki.wVk = vk;
        in.ki.dwFlags = down ? 0 : KEYEVENTF_KEYUP;
        SendInput(1, &in, sizeof(INPUT));
      }
      return true;
    }

    if (t == "gamepad_axis") {
      std::string axis;
      double val = 0;
      if (!jsonGetString(json, "axis", axis) || !jsonGetNumber(json, "value", val)) return false;
      if (axis == "ls_x") {
        INPUT in{}; in.type = INPUT_KEYBOARD;
        if (val > 0.3) { in.ki.wVk = 'D'; SendInput(1, &in, sizeof(INPUT)); }
        else if (val < -0.3) { in.ki.wVk = 'A'; SendInput(1, &in, sizeof(INPUT)); }
        else {
          in.ki.dwFlags = KEYEVENTF_KEYUP;
          in.ki.wVk = 'D'; SendInput(1, &in, sizeof(INPUT));
          in.ki.wVk = 'A'; SendInput(1, &in, sizeof(INPUT));
        }
      } else if (axis == "ls_y") {
        INPUT in{}; in.type = INPUT_KEYBOARD;
        if (val < -0.3) { in.ki.wVk = 'W'; SendInput(1, &in, sizeof(INPUT)); }
        else if (val > 0.3) { in.ki.wVk = 'S'; SendInput(1, &in, sizeof(INPUT)); }
        else {
          in.ki.dwFlags = KEYEVENTF_KEYUP;
          in.ki.wVk = 'W'; SendInput(1, &in, sizeof(INPUT));
          in.ki.wVk = 'S'; SendInput(1, &in, sizeof(INPUT));
        }
      } else if (axis == "lt") {
        INPUT in{}; in.type = INPUT_MOUSE;
        in.mi.dwFlags = val > 0.5 ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
        SendInput(1, &in, sizeof(INPUT));
      } else if (axis == "rt") {
        INPUT in{}; in.type = INPUT_MOUSE;
        in.mi.dwFlags = val > 0.5 ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
        SendInput(1, &in, sizeof(INPUT));
      }
      return true;
    }

    if (t == "mousemove") {
      double x = 0, y = 0;
      if (!jsonGetNumber(json, "x", x) || !jsonGetNumber(json, "y", y)) return false;
      INPUT in{};
      in.type = INPUT_MOUSE;
      in.mi.dx = static_cast<LONG>(std::clamp(x, 0.0, 1.0) * 65535.0);
      in.mi.dy = static_cast<LONG>(std::clamp(y, 0.0, 1.0) * 65535.0);
      in.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
      SendInput(1, &in, sizeof(INPUT));
      return true;
    }

    if (t == "mousebutton") {
      double x = 0, y = 0;
      if (!jsonGetNumber(json, "x", x) || !jsonGetNumber(json, "y", y)) return false;
      std::string btn;
      if (!jsonGetString(json, "button", btn)) return false;
      const bool down = json.find(""down":true") != std::string::npos;

      INPUT in{};
      in.type = INPUT_MOUSE;
      in.mi.dx = static_cast<LONG>(std::clamp(x, 0.0, 1.0) * 65535.0);
      in.mi.dy = static_cast<LONG>(std::clamp(y, 0.0, 1.0) * 65535.0);
      in.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;

      DWORD flag = 0;
      int btnId = 0;
      if (btn == "left") { flag = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP; btnId = 1; }
      else if (btn == "right") { flag = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP; btnId = 2; }
      else if (btn == "middle") { flag = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP; btnId = 3; }
      else return false;

      in.mi.dwFlags |= flag;
      SendInput(1, &in, sizeof(INPUT));
      if (down) heldButtons_.insert(btnId);
      else heldButtons_.erase(btnId);
      return true;
    }

    if (t == "wheel") {
      double dy = 0;
      if (!jsonGetNumber(json, "dy", dy)) return false;
      INPUT in{};
      in.type = INPUT_MOUSE;
      in.mi.dwFlags = MOUSEEVENTF_WHEEL;
      in.mi.mouseData = static_cast<DWORD>(static_cast<int>(dy * WHEEL_DELTA));
      SendInput(1, &in, sizeof(INPUT));
      return true;
    }

    if (t == "key") {
      double scancode = 0;
      if (!jsonGetNumber(json, "scancode", scancode)) return false;
      const bool down = json.find(""down":true") != std::string::npos;
      const int scan = static_cast<int>(scancode);

      INPUT in{};
      in.type = INPUT_KEYBOARD;
      in.ki.wScan = static_cast<WORD>(scan);
      in.ki.dwFlags = KEYEVENTF_SCANCODE | (down ? 0 : KEYEVENTF_KEYUP);
      SendInput(1, &in, sizeof(INPUT));
      if (down) heldKeys_.insert(scan);
      else heldKeys_.erase(scan);
      return true;
    }

    return false;
  }

  void releaseHeld() {
    for (int btnId : heldButtons_) {
      INPUT in{};
      in.type = INPUT_MOUSE;
      if (btnId == 1) in.mi.dwFlags = MOUSEEVENTF_LEFTUP;
      else if (btnId == 2) in.mi.dwFlags = MOUSEEVENTF_RIGHTUP;
      else if (btnId == 3) in.mi.dwFlags = MOUSEEVENTF_MIDDLEUP;
      SendInput(1, &in, sizeof(INPUT));
    }
    heldButtons_.clear();

    for (int scan : heldKeys_) {
      INPUT in{};
      in.type = INPUT_KEYBOARD;
      in.ki.wScan = static_cast<WORD>(scan);
      in.ki.dwFlags = KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP;
      SendInput(1, &in, sizeof(INPUT));
    }
    heldKeys_.clear();
  }

  int width() const override { return width_; }
  int height() const override { return height_; }
  const char* name() const override { return "dxgi"; }

 private:
  bool allowInput_ = false;
  std::set<int> heldButtons_;
  std::set<int> heldKeys_;
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<IDXGIOutputDuplication> duplication_;
  ComPtr<ID3D11Texture2D> staging_;
  std::vector<uint8_t> buffer_;
  UINT nativeWidth_ = 0, nativeHeight_ = 0;
  int width_ = 0, height_ = 0, stride_ = 0;
  bool running_ = false, haveFrame_ = false;
  uint64_t lastPts_ = 0;
  Clock::time_point epoch_{}, nextDue_{};
  std::chrono::microseconds period_{16666};
};
}  // namespace

std::unique_ptr<CaptureSource> makeDxgiSource() { return std::make_unique<DxgiSource>(); }
}  // namespace ps
