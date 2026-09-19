@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo     Penguin Stream - Windows Setup & Check
echo ===================================================
echo.

:: 1. Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [*] Node.js is not found on your system.
    echo [*] Attempting to install Node.js LTS via winget...
    winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
    if %errorlevel% neq 0 (
        echo [!] Could not install Node.js automatically via winget.
        echo     Please download and install Node.js (v20+) from: https://nodejs.org/
        pause
        exit /b 1
    )
    echo [OK] Node.js installed. Please restart this script or command prompt.
    pause
    exit /b 0
)

echo [OK] Node.js detected.

:: 2. Install Node dependencies
echo [*] Installing Node dependencies (npm ci)...
call npm ci
if %errorlevel% neq 0 (
    echo [!] npm ci failed. Attempting npm install...
    call npm install
)

:: 3. Check for Media Engine or portable player
if exist "media\build\Release\ps-media.exe" (
    echo [OK] Native ps-media.exe detected.
) else if exist "media\build\ps-media.exe" (
    echo [OK] Native ps-media.exe detected.
) else (
    echo [*] Checking for FFmpeg / ffplay fallback...
    where ffplay >nul 2>nul
    if %errorlevel% neq 0 (
        echo [*] Installing FFmpeg/ffplay runtime via winget...
        winget install Gyan.FFmpeg --silent --accept-source-agreements --accept-package-agreements
        if %errorlevel% equ 0 (
            echo [OK] FFmpeg/ffplay runtime installed successfully!
        ) else (
            echo [NOTE] You can also compile the native C++ engine:
            echo        powershell -File scripts\build-windows.ps1
        )
    ) else (
        echo [OK] ffplay runtime detected.
    )
)

echo.
echo ===================================================
echo   Setup Complete!
echo   To launch, double-click or run: penguin-stream.bat
echo ===================================================
echo.
