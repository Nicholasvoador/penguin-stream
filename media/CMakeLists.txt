cmake_minimum_required(VERSION 3.20)
project(ps_media VERSION 1.1.0 LANGUAGES CXX)

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
  src/input/event.cpp
  src/input/keymap.cpp
  src/audio/audio_common.cpp
)

set(PS_LIBS Threads::Threads)
set(PS_DEFINES "PS_VERSION=\"${PROJECT_VERSION}\"")

# Optional prebuilt FFmpeg tree (include/ + lib/), e.g. BtbN's win64 "shared"
# builds for MinGW cross-compiles. Takes precedence over other discovery.
set(PS_FFMPEG_ROOT "" CACHE PATH "Prebuilt FFmpeg root containing include/ and lib/")
set(PS_INCLUDE_DIRS "")
set(PS_LIBRARY_DIRS "")

if(WIN32)
  if(PS_FFMPEG_ROOT)
    set(PS_FFMPEG_LIBS "")
    foreach(lib avcodec avutil swscale)
      find_library(PS_${lib}_LIB NAMES ${lib} lib${lib} PATHS "${PS_FFMPEG_ROOT}/lib" NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH REQUIRED)
      list(APPEND PS_FFMPEG_LIBS ${PS_${lib}_LIB})
    endforeach()
    list(APPEND PS_INCLUDE_DIRS "${PS_FFMPEG_ROOT}/include")
    list(APPEND PS_LIBS ${PS_FFMPEG_LIBS})
  else()
    # vcpkg's FFmpeg wrapper supplies FindFFMPEG and these usage variables.
    # Missing FFmpeg is a configure error, not a later missing-header failure.
    find_package(FFMPEG REQUIRED)
    list(APPEND PS_INCLUDE_DIRS ${FFMPEG_INCLUDE_DIRS})
    list(APPEND PS_LIBRARY_DIRS ${FFMPEG_LIBRARY_DIRS})
    list(APPEND PS_LIBS ${FFMPEG_LIBRARIES})
  endif()
  list(APPEND PS_LIBS d3d11 dxgi setupapi ole32 uuid)
  list(APPEND PS_SOURCES
    src/audio/audio_capture_wasapi.cpp
    src/capture/windows_dxgi.cpp
    src/input/gamepad_vigem.cpp
    third_party/vigem/src/ViGEmClient.cpp)
  list(APPEND PS_INCLUDE_DIRS third_party/vigem/include third_party/vigem/src)
  list(APPEND PS_DEFINES PS_HAVE_DXGI=1 PS_HAVE_AUDIO_CAPTURE=1 NOMINMAX WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0A00)

  # Windows must not depend on pkg-config for SDL discovery.
  find_package(SDL2 CONFIG QUIET)
  if(TARGET SDL2::SDL2)
    set(PS_SDL_TARGET SDL2::SDL2)
  elseif(TARGET SDL2::SDL2-static)
    set(PS_SDL_TARGET SDL2::SDL2-static)
  endif()
  if(PS_SDL_TARGET)
    # The renderer includes <SDL2/SDL.h>, whereas SDL targets usually expose
    # the include/SDL2 directory itself: add its parent as well.
    get_target_property(_ps_sdl_incs ${PS_SDL_TARGET} INTERFACE_INCLUDE_DIRECTORIES)
    foreach(_dir IN LISTS _ps_sdl_incs SDL2_INCLUDE_DIRS)
      if(EXISTS "${_dir}/SDL2/SDL.h")
        list(APPEND PS_INCLUDE_DIRS "${_dir}")
      elseif(EXISTS "${_dir}/SDL.h")
        get_filename_component(_parent "${_dir}" DIRECTORY)
        list(APPEND PS_INCLUDE_DIRS "${_parent}")
      endif()
    endforeach()
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
    list(APPEND PS_SOURCES src/capture/portal_pipewire.cpp src/audio/audio_capture_pipewire.cpp)
    list(APPEND PS_LIBS PkgConfig::PIPEWIRE PkgConfig::GIO)
    list(APPEND PS_DEFINES PS_HAVE_PIPEWIRE=1 PS_HAVE_AUDIO_CAPTURE=1)
  endif()

  pkg_check_modules(SDL2 IMPORTED_TARGET sdl2)
  if(SDL2_FOUND)
    set(PS_SDL_TARGET PkgConfig::SDL2)
  endif()

  if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    list(APPEND PS_SOURCES src/input/gamepad_uinput.cpp)
  endif()
endif()

if(PS_SDL_TARGET)
  list(APPEND PS_SOURCES src/render/sdl_renderer.cpp src/audio/audio_play_sdl.cpp)
  list(APPEND PS_LIBS ${PS_SDL_TARGET})
  list(APPEND PS_DEFINES PS_HAVE_SDL=1)
else()
  message(WARNING "SDL2 not found: 'view' mode will be unavailable")
endif()

add_executable(ps-media ${PS_SOURCES})
if(MSVC)
  target_compile_options(ps-media PRIVATE /W4 /permissive- /EHsc /utf-8)
else()
  target_compile_options(ps-media PRIVATE -Wall -Wextra -Wno-unused-parameter)
endif()
if(MINGW)
  # Self-contained runtime: no libstdc++/libgcc/winpthread DLLs to ship.
  target_link_options(ps-media PRIVATE -static-libgcc -static-libstdc++ -Wl,-Bstatic,--whole-archive -lwinpthread -Wl,--no-whole-archive,-Bdynamic)
endif()
if(WIN32)
  # The vendored ViGEm client is third-party code; keep our warnings meaningful.
  set_source_files_properties(third_party/vigem/src/ViGEmClient.cpp PROPERTIES COMPILE_OPTIONS
    "$<IF:$<CXX_COMPILER_ID:MSVC>,/W0,-w>")
endif()
target_include_directories(ps-media PRIVATE src ${PS_INCLUDE_DIRS})
target_link_directories(ps-media PRIVATE ${PS_LIBRARY_DIRS})
target_link_libraries(ps-media PRIVATE ${PS_LIBS})
target_compile_definitions(ps-media PRIVATE ${PS_DEFINES})

install(TARGETS ps-media RUNTIME DESTINATION bin)
