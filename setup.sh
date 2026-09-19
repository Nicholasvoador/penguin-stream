#!/usr/bin/env bash
#
# Penguin Stream - Automated Setup & Verification Script
# Checks dependencies, builds the native media engine, and verifies installation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

C_RESET="\033[0m"
C_BOLD="\033[1m"
C_GREEN="\033[32m"
C_YELLOW="\033[33m"
C_RED="\033[31m"
C_CYAN="\033[36m"

info()    { printf "${C_CYAN}${C_BOLD}[INFO]${C_RESET} %s\n" "$*"; }
success() { printf "${C_GREEN}${C_BOLD}[OK]${C_RESET}   %s\n" "$*"; }
warn()    { printf "${C_YELLOW}${C_BOLD}[WARN]${C_RESET} %s\n" "$*"; }
err()     { printf "${C_RED}${C_BOLD}[FAIL]${C_RESET} %s\n" "$*"; }

printf "${C_CYAN}${C_BOLD}"
cat <<'BANNER'
   ___                    _        ____  _
  / _ \___ ___  ___ ___ _(_)_ _   / __// /________ ___ _
 / ___/ -_) _ \/ _ `/ // / / _ \ _\ \ / __/ __/ -_) _ `/  __ _
/_/   \__/_//_/\_, /\_,_/_/_//_//___/ \__/_/  \__/\_,_/  /_//_/
              /___/
BANNER
printf "${C_RESET}\n"
info "Checking environment and prerequisites..."

# 1. Node.js check
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is not installed. Please install Node.js >= 20."
  exit 1
fi
NODE_VER="$(node -v | sed 's/v//')"
NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node.js version $NODE_VER is older than required (v20+)."
  exit 1
fi
success "Node.js v$NODE_VER detected"

# 2. Build tools check
MISSING_TOOLS=()
for tool in cmake pkg-config; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    MISSING_TOOLS+=("$tool")
  fi
done

if ! command -v g++ >/dev/null 2>&1 && ! command -v clang++ >/dev/null 2>&1; then
  MISSING_TOOLS+=("g++ or clang++")
fi

# 3. Native libraries check
MISSING_PKGS=()
check_pkg() {
  if ! pkg-config --exists "$1" 2>/dev/null; then
    MISSING_PKGS+=("$1")
  fi
}

check_pkg "libavcodec"
check_pkg "libavformat"
check_pkg "libavutil"
check_pkg "libswscale"
check_pkg "sdl2"
check_pkg "libpipewire-0.3"
check_pkg "gio-2.0"

if [ ${#MISSING_TOOLS[@]} -gt 0 ] || [ ${#MISSING_PKGS[@]} -gt 0 ]; then
  warn "Missing required build tools or libraries:"
  for t in "${MISSING_TOOLS[@]:-}"; do echo "  - tool: $t"; done
  for p in "${MISSING_PKGS[@]:-}"; do echo "  - package: $p"; done
  echo ""
  info "Install them using your system package manager:"
  if [ -f /etc/fedora-release ]; then
    echo "  sudo dnf install -y gcc-c++ cmake ninja-build pkgconf-pkg-config ffmpeg-free-devel SDL2-devel pipewire-devel glib2-devel"
  elif [ -f /etc/debian_version ]; then
    echo "  sudo apt-get update && sudo apt-get install -y build-essential cmake ninja-build pkg-config libavcodec-dev libavformat-dev libavutil-dev libswscale-dev libavdevice-dev libsdl2-dev libpipewire-0.3-dev libglib2.0-dev"
  elif [ -f /etc/arch-release ]; then
    echo "  sudo pacman -S --needed base-devel cmake ninja pkgconf ffmpeg sdl2 pipewire glib2"
  else
    echo "  (Please install C++17 compiler, cmake, pkg-config, ffmpeg-dev, sdl2-dev, pipewire-dev, glib2-dev)"
  fi
  exit 1
fi
success "All C++ compiler, build tools, and system libraries are present"

# 4. Install Node dependencies
info "Installing Node.js dependencies (npm ci)..."
npm ci --silent
success "Node.js dependencies installed"

# 5. Build C++ media engine
info "Configuring and compiling native media engine (media/build)..."
mkdir -p media/build
cmake -S media -B media/build -DCMAKE_BUILD_TYPE=Release
cmake --build media/build -j"$(nproc 2>/dev/null || echo 2)"
success "Native media engine built successfully"

# 6. Run self-test
info "Running hardware self-test (synthetic encode/decode)..."
SELFTEST_OUT="$(./media/build/ps-media selftest --frames 30 2>&1)"
echo "  $SELFTEST_OUT"
if echo "$SELFTEST_OUT" | grep -q '"ok":true'; then
  success "Hardware self-test passed!"
else
  warn "Hardware self-test reported warnings; see output above."
fi

# 7. Make root launcher executable
chmod +x penguin-stream 2>/dev/null || true

printf "\n${C_GREEN}${C_BOLD}Setup Complete!${C_RESET}\n\n"
echo "To start Penguin Stream, simply run:"
echo "  ./penguin-stream"
echo ""
echo "Or start via the command line:"
echo "  ./penguin-stream host       # Share your desktop"
echo "  ./penguin-stream connect    # Connect to another desktop"
echo ""
