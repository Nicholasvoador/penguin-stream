# Penguin Stream Windows Media Engine Build Script
param(
    [string]$VcpkgRoot = $env:VCPKG_ROOT,
    [string]$Triplet = "x64-windows",
    [string]$Config = "Release"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir

Write-Host "== Building Penguin Stream Media Engine (Windows) ==" -ForegroundColor Cyan

$CmakeArgs = @(
    "-S", "$RepoRoot/media",
    "-B", "$RepoRoot/media/build/windows",
    "-A", "x64"
)

if ($VcpkgRoot -and (Test-Path $VcpkgRoot)) {
    $CmakeArgs += "-DCMAKE_TOOLCHAIN_FILE=$VcpkgRoot/scripts/buildsystems/vcpkg.cmake"
    $CmakeArgs += "-DVCPKG_TARGET_TRIPLET=$Triplet"
} else {
    Write-Warning "VCPKG_ROOT is not set. If FFmpeg/SDL2 are missing, install via: vcpkg install ffmpeg[gpl,x264]:x64-windows sdl2:x64-windows"
}

Write-Host "Running CMake configure..." -ForegroundColor Yellow
& cmake @CmakeArgs

Write-Host "Running CMake build..." -ForegroundColor Yellow
& cmake --build "$RepoRoot/media/build/windows" --config $Config

$BinPath = "$RepoRoot/media/build/windows/$Config/ps-media.exe"
if (Test-Path $BinPath) {
    Write-Host "Build complete! Binary at $BinPath" -ForegroundColor Green
    & $BinPath probe
} else {
    Write-Error "Build finished but $BinPath was not found."
}
