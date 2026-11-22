@echo off
cd /d "%~dp0"
set "OPEN_PATH=%~1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1" "%OPEN_PATH%"
