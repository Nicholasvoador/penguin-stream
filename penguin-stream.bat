@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not found on your PATH.
    echo Running automated setup...
    call setup.bat
    exit /b
)

if not exist "node_modules" (
    echo Running first-time setup...
    call setup.bat
)

if "%~1"=="" (
    echo Launching Penguin Stream Local UI in your default browser...
    node node/src/cli.mjs ui
) else (
    node node/src/cli.mjs %*
)
