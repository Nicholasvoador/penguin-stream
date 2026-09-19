@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not found on your PATH. Please install Node.js 20 or newer.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Installing node dependencies...
    call npm ci
    if %errorlevel% neq 0 (
        echo [ERROR] npm ci failed.
        pause
        exit /b 1
    )
)

if "%~1"=="" (
    echo Launching Penguin Stream Local UI in your default browser...
    node node/src/cli.mjs ui
) else (
    node node/src/cli.mjs %*
)
