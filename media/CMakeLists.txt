cmake_minimum_required(VERSION 3.20)
project(ps_media LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_compile_options(-Wall -Wextra -Wno-unused-parameter)

set(PS_SOURCES
  src/main.cpp
  src/ipc/framing.cpp
  src/codec/encoder.cpp
  src/codec/decoder.cpp
  src/capture/synthetic.cpp
)

set(PS_LIBS "")
set(PS_DEFINES "")

if(WIN32)
  # Windows capture uses DXGI Desktop Duplication. Compiled but UNTESTED:
  # no Windows hardware was available. See LIMITATIONS.md.
  list(APPEND PS_SOURCES src/capture/windows_dxgi.cpp)
  list(APPEND PS_LIBS d3d11 dxgi)
  list(APPEND PS_DEFINES PS_HAVE_DXGI=1)
else()
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(FFMPEG REQUIRED IMPORTED_TARGET
    libavcodec libavformat libavutil libswscale libavdevice)
  list(APPEND PS_LIBS PkgConfig::FFMPEG)

  pkg_check_modules(X11 IMPORTED_TARGET x11)
  if(X11_FOUND)
    list(APPEND PS_SOURCES src/capture/x11_capture.cpp)
    list(APPEND PS_DEFINES PS_HAVE_X11=1)
  endif()

  pkg_check_modules(PIPEWIRE IMPORTED_TARGET libpipewire-0.3)
  pkg_check_modules(GIO IMPORTED_TARGET gio-2.0)
  if(PIPEWIRE_FOUND AND GIO_FOUND
     AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/src/capture/portal_pipewire.cpp")
    list(APPEND PS_SOURCES src/capture/portal_pipewire.cpp)
    list(APPEND PS_LIBS PkgConfig::PIPEWIRE PkgConfig::GIO)
    list(APPEND PS_DEFINES PS_HAVE_PIPEWIRE=1)
  endif()
endif()

if(WIN32)
  # On Windows FFmpeg is expected via vcpkg or a prebuilt SDK.
  find_package(FFMPEG QUIET)
endif()

pkg_check_modules(SDL2 IMPORTED_TARGET sdl2)
if(SDL2_FOUND)
  list(APPEND PS_SOURCES src/render/sdl_renderer.cpp)
  list(APPEND PS_LIBS PkgConfig::SDL2)
  list(APPEND PS_DEFINES PS_HAVE_SDL=1)
else()
  message(WARNING "SDL2 not found: 'view' mode will be unavailable")
endif()

add_executable(ps-media ${PS_SOURCES})
target_include_directories(ps-media PRIVATE src)
target_link_libraries(ps-media PRIVATE ${PS_LIBS})
target_compile_definitions(ps-media PRIVATE ${PS_DEFINES})

install(TARGETS ps-media RUNTIME DESTINATION bin)
