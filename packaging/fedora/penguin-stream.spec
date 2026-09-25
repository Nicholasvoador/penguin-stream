# Built by scripts/build-desktop.sh from the electron-builder unpacked app.
# Not a from-source spec: SOURCES/linux-unpacked is the prebuilt app.

%global debug_package %{nil}
%global __strip /bin/true
%global _build_id_links none
# Electron bundles its own libffmpeg/EGL/Vulkan/SwiftShader: never export
# them to the system, never require them from it.
%global __provides_exclude_from ^/opt/penguin-stream/.*$
%global __requires_exclude ^(libffmpeg|libEGL|libGLESv2|libvk_swiftshader|libvulkan)\\.so.*$

Name:           penguin-stream
Version:        %{ps_version}
Release:        1%{?dist}
Summary:        Low-latency remote desktop that works behind CGNAT
License:        MIT
URL:            https://github.com/Nicholasvoador/penguin-stream
ExclusiveArch:  x86_64

# The media engine links FFmpeg by soname, so either Fedora's ffmpeg-free
# libraries or RPM Fusion's (adding NVENC/VA-API H.264) satisfy it.
Requires:       xdg-desktop-portal
Recommends:     (xdg-desktop-portal-kde or xdg-desktop-portal-gnome)
Recommends:     pipewire

%description
Penguin Stream shares a desktop between Windows and Fedora with hardware
H.264, direct peer-to-peer UDP (also behind CGNAT) with optional relay
fallback, end-to-end encryption and keyboard, mouse and controller input
that each side can switch on and off live.

%install
mkdir -p %{buildroot}/opt/penguin-stream %{buildroot}%{_bindir} \
         %{buildroot}%{_datadir}/applications %{buildroot}%{_datadir}/icons/hicolor/512x512/apps
cp -a %{_sourcedir}/linux-unpacked/. %{buildroot}/opt/penguin-stream/
chmod 4755 %{buildroot}/opt/penguin-stream/chrome-sandbox
ln -s /opt/penguin-stream/penguin-stream %{buildroot}%{_bindir}/penguin-stream
install -m644 %{_sourcedir}/icon.png %{buildroot}%{_datadir}/icons/hicolor/512x512/apps/penguin-stream.png
cat > %{buildroot}%{_datadir}/applications/penguin-stream.desktop <<'EOF'
[Desktop Entry]
Name=Penguin Stream
GenericName=Remote Desktop
Comment=Share or control a desktop over the Internet with low latency
Exec=/opt/penguin-stream/penguin-stream %U
Icon=penguin-stream
Terminal=false
Type=Application
Categories=Network;RemoteAccess;
Keywords=remote;desktop;stream;screen;share;
StartupWMClass=Penguin Stream
EOF

%files
/opt/penguin-stream
%{_bindir}/penguin-stream
%{_datadir}/applications/penguin-stream.desktop
%{_datadir}/icons/hicolor/512x512/apps/penguin-stream.png

%changelog
* Fri Sep 25 2026 Penguin Stream contributors <noreply@github.com> - 1.0.0-1
- First stable release: desktop app, relay setup, network check, NVENC RGB input
