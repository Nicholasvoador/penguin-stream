// Viewer playback: PCM from stdin -> SDL audio device.
//
// Latency policy: start once ~30 ms is buffered (absorbs network jitter), and
// keep it there: if the queue sits above target+20 ms for half a second (a
// burst after a stall, or the sender's clock running fast), drop the excess
// so audio returns to ~30 ms instead of lagging video for minutes. Above
// ~120 ms at once, drop the backlog and re-buffer.

#include "audio/audio.h"

#include <SDL2/SDL.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace ps {

namespace {
constexpr Uint32 msBytes(int ms) { return Uint32(kAudioRate / 1000 * ms * kAudioFrameBytes); }
}  // namespace

int runAudioPlay(int argc, char** argv) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
#endif
  int startMs = 30, maxMs = 120;
  for (int i = 1; i + 1 < argc; ++i) {
    const std::string a = argv[i];
    if (a == "--buffer-ms") startMs = std::max(5, std::min(500, atoi(argv[++i])));
    else if (a == "--max-ms") maxMs = std::max(40, std::min(2000, atoi(argv[++i])));
  }
  if (maxMs <= startMs) maxMs = startMs * 3;

  SDL_SetHint(SDL_HINT_AUDIO_DEVICE_APP_NAME, "Penguin Stream");
  SDL_SetHint("SDL_APP_NAME", "Penguin Stream");   // SDL3 (sdl2-compat) spelling
  SDL_SetHint(SDL_HINT_AUDIO_DEVICE_STREAM_NAME, "Remote desktop audio");
  if (SDL_Init(SDL_INIT_AUDIO) != 0) {
    fprintf(stderr, "audio: SDL_Init failed: %s\n", SDL_GetError());
    return 1;
  }
  SDL_AudioSpec want{}, have{};
  want.freq = kAudioRate;
  want.format = AUDIO_S16LSB;
  want.channels = kAudioChannels;
  want.samples = 256;   // ~5 ms device period
  const SDL_AudioDeviceID dev = SDL_OpenAudioDevice(nullptr, 0, &want, &have, 0);
  if (!dev) {
    fprintf(stderr, "audio: cannot open playback device: %s\n", SDL_GetError());
    SDL_Quit();
    return 1;
  }
  fprintf(stderr, "audio: playing on %s, %d Hz, buffer %d-%d ms\n",
          SDL_GetCurrentAudioDriver(), have.freq, startMs, maxMs);

  std::vector<uint8_t> buf(msBytes(10));
  bool playing = false;
  size_t carry = 0;   // keep whole frames only
  int overFor = 0;    // consecutive reads with the queue above target
  for (;;) {
    const size_t n = fread(buf.data() + carry, 1, buf.size() - carry, stdin);
    if (n == 0) break;   // EOF: session over
    const size_t total = carry + n;
    const size_t whole = total - total % kAudioFrameBytes;
    const Uint32 queued = SDL_GetQueuedAudioSize(dev);
    if (queued > msBytes(maxMs)) {
      SDL_ClearQueuedAudio(dev);   // too far behind: skip ahead
      SDL_PauseAudioDevice(dev, 1);
      playing = false;
    } else if (playing && queued == 0) {
      SDL_PauseAudioDevice(dev, 1);   // ran dry: re-buffer instead of stuttering
      playing = false;
    }
    // Trim a standing excess: skip incoming audio instead of queuing it
    // (one 10 ms read at a time, which is barely audible).
    bool skip = false;
    if (playing && queued > msBytes(startMs + 20)) {
      if (++overFor >= 50) skip = true;           // ~0.5 s above target
    } else {
      overFor = 0;
    }
    if (skip && queued <= msBytes(startMs + 5)) overFor = 0;
    if (!skip) SDL_QueueAudio(dev, buf.data(), Uint32(whole));
    else if (SDL_GetQueuedAudioSize(dev) <= msBytes(startMs)) overFor = 0;   // back at target
    carry = total - whole;
    if (carry) memmove(buf.data(), buf.data() + whole, carry);
    if (!playing && SDL_GetQueuedAudioSize(dev) >= msBytes(startMs)) {
      SDL_PauseAudioDevice(dev, 0);
      playing = true;
    }
  }
  SDL_CloseAudioDevice(dev);
  SDL_Quit();
  return 0;
}

}  // namespace ps
