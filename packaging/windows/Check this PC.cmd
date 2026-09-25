@echo off
setlocal
title Penguin Stream - check this PC
cd /d "%~dp0"
"runtime\node.exe" "node\src\cli.mjs" doctor
echo.
pause
