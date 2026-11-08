@echo off
rem Builds Collection Tracker if anything changed, copies the exe to dist\, and starts it.
rem The first build takes a few minutes; after that it starts in a few seconds.
setlocal
cd /d "%~dp0src-tauri"

where cargo >nul 2>nul
if errorlevel 1 (
  echo Rust is not installed. Get it from https://rustup.rs and run this again.
  pause
  exit /b 1
)

echo Building Collection Tracker...
cargo build --release
if errorlevel 1 (
  echo.
  echo Build failed - see the messages above.
  pause
  exit /b 1
)

if not exist "%~dp0dist" mkdir "%~dp0dist"
copy /y "target\release\collection-tracker.exe" "%~dp0dist\Collection Tracker.exe" >nul
start "" "%~dp0dist\Collection Tracker.exe"
