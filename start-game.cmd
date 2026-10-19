@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 20 or newer from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
call npm ci --no-audit --no-fund
if errorlevel 1 (
  pause
  exit /b 1
)
call npm run play
pause
