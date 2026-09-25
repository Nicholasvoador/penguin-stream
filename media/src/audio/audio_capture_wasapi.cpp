// Host desktop audio on Windows (WASAPI loopback), with per-app filtering.
//
// Plain loopback records the whole default output mix. To leave an app out
// (Discord in the same call as the viewer), Windows 10 2004+ offers "process
// loopback": capture everything EXCEPT one process tree, or ONLY one process
// tree. Discord runs as a tree of Discord.exe processes, so excluding the root
// excludes all of it. The target is re-resolved every few seconds, so an app
// started or restarted mid-session is handled. On older Windows, or if the
// app is not running, we fall back to plain loopback and say so.

#include "audio/audio.h"

#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <tlhelp32.h>
#include <fcntl.h>
#include <io.h>

#include <atomic>
#include <chrono>
#include <functional>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

namespace ps {

namespace {

// From audioclientactivationparams.h (not shipped by MinGW).
enum PsActivationType { kActivationDefault = 0, kActivationProcessLoopback = 1 };
enum PsLoopbackMode { kIncludeTree = 0, kExcludeTree = 1 };
struct PsProcessLoopbackParams { DWORD targetProcessId; PsLoopbackMode mode; };
struct PsActivationParams { PsActivationType type; PsProcessLoopbackParams loopback; };
const wchar_t kProcessLoopbackDevice[] = L"VAD\\Process_Loopback";

using ActivateFn = HRESULT(WINAPI*)(LPCWSTR, REFIID, PROPVARIANT*, IActivateAudioInterfaceCompletionHandler*,
                                    IActivateAudioInterfaceAsyncOperation**);

std::atomic<bool> g_stop{false};
BOOL WINAPI onConsoleCtrl(DWORD) { g_stop = true; return TRUE; }

// IID_IAgileObject: activation completes on an MTA worker thread.
const GUID kIidAgileObject = {0x94ea2b94, 0xe9cc, 0x49e0, {0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90}};

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler {
 public:
  ActivationHandler() : done_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  ~ActivationHandler() { CloseHandle(done_); }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** out) override {
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler) ||
        riid == kIidAgileObject) {
      *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG r = --refs_;
    if (r == 0) delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
    IUnknown* unk = nullptr;
    HRESULT activateHr = E_FAIL;
    result_ = op->GetActivateResult(&activateHr, &unk);
    if (SUCCEEDED(result_)) result_ = activateHr;
    if (SUCCEEDED(result_) && unk) {
      result_ = unk->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(&client_));
    }
    if (unk) unk->Release();
    SetEvent(done_);
    return S_OK;
  }
  HANDLE done() const { return done_; }
  HRESULT result() const { return result_; }
  IAudioClient* take() { IAudioClient* c = client_; client_ = nullptr; return c; }

 private:
  std::atomic<ULONG> refs_{1};
  HANDLE done_;
  HRESULT result_ = E_PENDING;
  IAudioClient* client_ = nullptr;
};

std::string exeBase(const wchar_t* exe) {
  std::string s;
  for (const wchar_t* p = exe; *p; ++p) s += (*p < 128) ? char(*p) : '?';
  const auto dot = s.rfind('.');
  if (dot != std::string::npos) s.resize(dot);
  return s;
}

// Root process (by tree) of the first running app the filter selects, or 0.
DWORD findTarget(const AppFilter& f, std::string& name) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return 0;
  std::map<DWORD, std::pair<DWORD, std::string>> procs;   // pid -> (parent, exe)
  PROCESSENTRY32W pe{};
  pe.dwSize = sizeof(pe);
  for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe)) {
    procs[pe.th32ProcessID] = {pe.th32ParentProcessID, exeBase(pe.szExeFile)};
  }
  CloseHandle(snap);
  const DWORD self = GetCurrentProcessId();
  auto selected = [&](const std::string& exe) {
    return f.only.empty() ? f.matchesExclude(exe) : f.matchesOnly(exe);
  };
  for (const auto& [pid, info] : procs) {
    if (pid == self || !selected(info.second)) continue;
    // Walk up while the parent is the same app: exclude/include the whole tree.
    DWORD root = pid;
    for (int depth = 0; depth < 16; ++depth) {
      auto parent = procs.find(procs[root].first);
      if (parent == procs.end() || parent->first == root || !selected(parent->second.second)) break;
      root = parent->first;
    }
    name = procs[root].second;
    return root;
  }
  return 0;
}

WAVEFORMATEX pcmFormat() {
  WAVEFORMATEX w{};
  w.wFormatTag = WAVE_FORMAT_PCM;
  w.nChannels = kAudioChannels;
  w.nSamplesPerSec = kAudioRate;
  w.wBitsPerSample = 16;
  w.nBlockAlign = w.nChannels * w.wBitsPerSample / 8;
  w.nAvgBytesPerSec = w.nSamplesPerSec * w.nBlockAlign;
  return w;
}

IAudioClient* openProcessLoopback(DWORD pid, PsLoopbackMode mode, std::string& err) {
  static HMODULE mmdev = LoadLibraryW(L"mmdevapi.dll");
  auto activate = mmdev ? reinterpret_cast<ActivateFn>(reinterpret_cast<void*>(GetProcAddress(mmdev, "ActivateAudioInterfaceAsync"))) : nullptr;
  if (!activate) { err = "ActivateAudioInterfaceAsync unavailable"; return nullptr; }

  PsActivationParams params{kActivationProcessLoopback, {pid, mode}};
  PROPVARIANT pv{};
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(params);
  pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  auto* handler = new ActivationHandler();
  IActivateAudioInterfaceAsyncOperation* op = nullptr;
  HRESULT hr = activate(kProcessLoopbackDevice, __uuidof(IAudioClient), &pv, handler, &op);
  IAudioClient* client = nullptr;
  if (SUCCEEDED(hr)) {
    if (WaitForSingleObject(handler->done(), 5000) != WAIT_OBJECT_0) hr = HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    else hr = handler->result();
    if (SUCCEEDED(hr)) client = handler->take();
  }
  if (op) op->Release();
  handler->Release();
  if (!client) { char b[64]; snprintf(b, sizeof b, "process loopback activation failed (0x%08lx)", hr); err = b; return nullptr; }

  WAVEFORMATEX fmt = pcmFormat();
  // Process loopback has no mix format; it converts to whatever PCM we ask for.
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                          200000, 0, &fmt, nullptr);
  if (FAILED(hr)) {
    char b[64]; snprintf(b, sizeof b, "process loopback Initialize failed (0x%08lx)", hr); err = b;
    client->Release();
    return nullptr;
  }
  return client;
}

IAudioClient* openSystemLoopback(std::string& err) {
  IMMDeviceEnumerator* en = nullptr;
  IMMDevice* dev = nullptr;
  IAudioClient* client = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                reinterpret_cast<void**>(&en));
  if (SUCCEEDED(hr)) hr = en->GetDefaultAudioEndpoint(eRender, eConsole, &dev);
  if (SUCCEEDED(hr)) hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&client));
  if (SUCCEEDED(hr)) {
    WAVEFORMATEX fmt = pcmFormat();
    // The engine converts the endpoint's mix format (often float, 44.1/96 kHz,
    // 5.1) to our fixed PCM. Event callbacks on loopback are unreliable on
    // older builds, so the capture loop also polls.
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                                AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                            200000, 0, &fmt, nullptr);
  }
  if (dev) dev->Release();
  if (en) en->Release();
  if (FAILED(hr)) {
    char b[64]; snprintf(b, sizeof b, "system loopback failed (0x%08lx)", hr); err = b;
    if (client) client->Release();
    return nullptr;
  }
  return client;
}

bool processLoopbackSupported() {
  // Windows 10 2004 = build 19041. RtlGetVersion is not affected by manifests.
  using RtlGetVersionFn = LONG(WINAPI*)(OSVERSIONINFOW*);
  auto fn = reinterpret_cast<RtlGetVersionFn>(reinterpret_cast<void*>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion")));
  OSVERSIONINFOW v{};
  v.dwOSVersionInfoSize = sizeof(v);
  return fn && fn(&v) == 0 && (v.dwMajorVersion > 10 || (v.dwMajorVersion == 10 && v.dwBuildNumber >= 19041));
}

// Runs one capture client until stop, a write failure, or `recheck` says the
// target changed. Returns false on a fatal write failure.
bool pump(IAudioClient* client, const std::function<bool()>& recheck) {
  IAudioCaptureClient* cap = nullptr;
  HANDLE event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (FAILED(client->SetEventHandle(event)) ||
      FAILED(client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&cap))) ||
      FAILED(client->Start())) {
    if (cap) cap->Release();
    CloseHandle(event);
    return true;
  }
  std::vector<uint8_t> silence;
  bool ok = true;
  auto lastCheck = std::chrono::steady_clock::now();
  while (!g_stop && ok) {
    WaitForSingleObject(event, 10);
    UINT32 packet = 0;
    while (ok && SUCCEEDED(cap->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
      const size_t bytes = size_t(frames) * kAudioFrameBytes;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        silence.assign(bytes, 0);
        data = silence.data();
      }
      ok = fwrite(data, 1, bytes, stdout) == bytes;
      cap->ReleaseBuffer(frames);
    }
    if (ok) ok = fflush(stdout) == 0;
    const auto now = std::chrono::steady_clock::now();
    if (now - lastCheck > std::chrono::seconds(3)) {
      lastCheck = now;
      if (recheck()) break;
    }
  }
  client->Stop();
  cap->Release();
  CloseHandle(event);
  return ok;
}

}  // namespace

int runAudioCapture(int argc, char** argv) {
  _setmode(_fileno(stdout), _O_BINARY);
  SetConsoleCtrlHandler(onConsoleCtrl, TRUE);
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const AppFilter filter = AppFilter::fromArgs(argc, argv);
  const bool filtering = filter.excludeVoice || !filter.exclude.empty() || !filter.only.empty();
  const bool supported = processLoopbackSupported();
  fprintf(stderr, "audio: capturing %s via WASAPI\n", filter.describe().c_str());

  bool ok = true;
  std::string lastWarning;
  auto warn = [&](const std::string& w) {   // once per distinct problem, not every retry
    if (w != lastWarning) fprintf(stderr, "audio: warning: %s\n", w.c_str());
    lastWarning = w;
  };
  while (!g_stop && ok) {
    std::string name, err;
    const DWORD pid = filtering && supported ? findTarget(filter, name) : 0;
    IAudioClient* client = nullptr;
    if (!filter.only.empty()) {
      // "Only this app" must never widen to everything: send nothing instead.
      if (!supported) { warn("streaming a single app needs Windows 10 version 2004 or newer; no audio is sent"); Sleep(3000); continue; }
      if (!pid) { Sleep(3000); continue; }   // not running yet
      client = openProcessLoopback(pid, kIncludeTree, err);
      if (!client) { warn(err + "; no audio is sent"); Sleep(3000); continue; }
      fprintf(stderr, "audio: streaming only \"%s\" (pid %lu)\n", name.c_str(), pid);
    } else if (pid) {
      client = openProcessLoopback(pid, kExcludeTree, err);
      if (client) fprintf(stderr, "audio: leaving out \"%s\" (pid %lu)\n", name.c_str(), pid);
      else warn("could not leave out \"" + name + "\" (" + err + "); streaming all apps");
    } else if (filtering && !supported) {
      warn("leaving apps out needs Windows 10 version 2004 or newer; streaming all apps");
    }
    if (!client) client = openSystemLoopback(err);
    if (!client) {
      warn(err);
      Sleep(3000);   // e.g. no output device yet; keep trying
      continue;
    }
    const DWORD current = pid;
    ok = pump(client, [&] {
      if (!filtering || !supported) return false;
      std::string n;
      return findTarget(filter, n) != current;   // app started, quit or restarted
    });
    client->Release();
  }
  CoUninitialize();
  return 0;
}

std::string audioProbeJson() {
  return std::string("{\"capture\":\"wasapi\",\"appFilter\":") + (processLoopbackSupported() ? "true" : "false") +
         ",\"play\":\"sdl\"}";
}

}  // namespace ps
