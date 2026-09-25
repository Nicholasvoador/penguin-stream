@echo off
rem Command-line interface, e.g.:  penguin-stream host --allow-control
"%~dp0runtime\node.exe" "%~dp0node\src\cli.mjs" %*
