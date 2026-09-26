# Fedora notes

## Install

```sh
# download the .rpm from https://github.com/Nicholasvoador/penguin-stream/releases/latest, then:
sudo dnf install ./penguin-stream-*.x86_64.rpm
```

dnf pulls in the FFmpeg, SDL2 (sdl2-compat) and PipeWire libraries automatically. Start it from the app menu, or run `penguin-stream`.

## GPU encoding (recommended for hosting)

Fedora's stock FFmpeg (`ffmpeg-free`) decodes H.264, includes **NVENC** (NVIDIA, with the proprietary driver installed),
and falls back to OpenH264 software encoding. **AMD/Intel** GPUs need RPM Fusion's Mesa build for VA-API H.264 encoding:

```sh
sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm
sudo dnf swap mesa-va-drivers mesa-va-drivers-freeworld   # VA-API H.264 on AMD/Intel
sudo dnf install libavcodec-freeworld                      # optional: full codec set (x264 fallback)
```

No app restart is needed: the next share picks the fastest encoder that works. The **Activity** page shows which
encoder was chosen (`encoding with h264_nvenc`).

## Wayland

- The first share shows KDE/GNOME's screen-sharing dialog: pick the monitor you chose in Penguin Stream, and tick *Allow
  remote interaction* to allow keyboard/mouse control. The choice is remembered, so later shares start straight away.
  If you pick "Full workspace", Penguin Stream still streams only the monitor chosen on its Home page.
- Controllers on a Linux host use `/dev/uinput`, which must be writable by your user. If the app reports controllers as
  unavailable, `sudo dnf install steam-devices` adds the standard udev rule (log out and back in afterwards).

## Dual network paths

If your machine has two uplinks, for example fibre on IPv4 and Starlink on IPv6, ICE may pick either. The **Activity** log shows
the selected route after connecting.
