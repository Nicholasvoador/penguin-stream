cmake_minimum_required(VERSION 3.20)
project(ps_media LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Threads REQUIRED)

set(PS_SOURCES
  src/main.cpp
  src/ipc/framing.cpp
  src/codec/encoder.cpp
  src/codec/decoder.cpp
  src/capture/synthetic.cpp
)

set(PS_LIBS Threads::Threads)
set(PS_DEFINES "")
set(PS_INCLUDE_DIRS "")
set(PS_LIBRARY_DIRS "")

if(WIN32)
  # vcpkg's FFmpeg wrapper supplies FindFFMPEG and these usage variables.
  # Missing FFmpeg is a configure error, not a later missing-header failure.
  find_package(FFMPEG REQUIRED)
  list(APPEND PS_INCLUDE_DIRS ${FFMPEG_INCLUDE_DIRS})
  list(APPEND PS_LIBRARY_DIRS ${FFMPEG_LIBRARY_DIRS})
  list(APPEND PS_LIBS ${FFMPEG_LIBRARIES} d3d11 dxgi)
  list(APPEND PS_SOURCES src/capture/windows_dxgi.cpp)
  list(APPEND PS_DEFINES PS_HAVE_DXGI=1 NOMINMAX WIN32_LEAN_AND_MEAN)

  # Windows must not depend on pkg-config for SDL discovery.
  find_package(SDL2 CONFIG QUIET)
  if(TARGET SDL2::SDL2)
    set(PS_SDL_TARGET SDL2::SDL2)
  elseif(TARGET SDL2::SDL2-static)
    set(PS_SDL_TARGET SDL2::SDL2-static)
  endif()
  if(PS_SDL_TARGET)
    # The existing renderer spells the include <SDL2/SDL.h>, whereas some
    # SDL targets expose only the include/SDL2 directory.
    find_path(PS_SDL_INCLUDE_ROOT NAMES SDL2/SDL.h
      HINTS ${SDL2_INCLUDE_DIRS} PATH_SUFFIXES .. REQUIRED)
    list(APPEND PS_INCLUDE_DIRS ${PS_SDL_INCLUDE_ROOT})
    list(APPEND PS_DEFINES SDL_MAIN_HANDLED)
  endif()
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

  pkg_check_modules(SDL2 IMPORTED_TARGET sdl2)
  if(SDL2_FOUND)
    set(PS_SDL_TARGET PkgConfig::SDL2)
  endif()
endif()

if(PS_SDL_TARGET)
  list(APPEND PS_SOURCES src/render/sdl_renderer.cpp)
  list(APPEND PS_LIBS ${PS_SDL_TARGET})
  list(APPEND PS_DEFINES PS_HAVE_SDL=1)
else()
  message(WARNING "SDL2 not found: 'view' mode will be unavailable")
endif()

add_executable(ps-media ${PS_SOURCES})
if(MSVC)
  target_compile_options(ps-media PRIVATE /W4 /permissive- /EHsc)
else()
  target_compile_options(ps-media PRIVATE -Wall -Wextra -Wno-unused-parameter)
endif()
target_include_directories(ps-media PRIVATE src ${PS_INCLUDE_DIRS})
target_link_directories(ps-media PRIVATE ${PS_LIBRARY_DIRS})
target_link_libraries(ps-media PRIVATE ${PS_LIBS})
target_compile_definitions(ps-media PRIVATE ${PS_DEFINES})

install(TARGETS ps-media RUNTIME DESTINATION bin)
