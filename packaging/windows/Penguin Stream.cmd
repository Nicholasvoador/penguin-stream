@echo off
setlocal
title Penguin Stream
cd /d "%~dp0"
if not exist "runtime\node.exe" goto :notextracted
if not exist "bin\ps-media.exe" goto :notextracted
echo.
echo  Penguin Stream is starting and will open in your browser.
echo  Keep this window open while you use it. Close it to quit.
echo.
"runtime\node.exe" "node\src\cli.mjs" ui
if errorlevel 1 (
  echo.
  echo  Penguin Stream stopped with an error. See the messages above.
  pause
)
exit /b

:notextracted
echo.
echo  Some files are missing.
echo  Right-click the downloaded zip, choose "Extract All...", then open the
echo  extracted folder and double-click "Penguin Stream" there.
echo  (Running it directly from inside the zip does not work.)
echo.
pause
exit /b 1
