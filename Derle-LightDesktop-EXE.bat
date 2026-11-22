@echo off
cd /d "%~dp0"
echo Portable EXE derleniyor...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-portable.ps1"
if errorlevel 1 (
  echo.
  echo Derleme sirasinda hata olustu!
  pause
  exit /b 1
)
echo.
echo Tamamlandi! dist\LightDesktop.exe klasoru aciliyor...
explorer /select,"%~dp0dist\LightDesktop.exe"
pause
