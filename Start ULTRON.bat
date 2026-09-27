@echo off
rem Double-click to update and start ULTRON, then open it in the browser.
cd /d "%~dp0"
title ULTRON
echo Getting the latest ULTRON...
git pull
echo Installing what it needs (first time takes a few minutes)...
call npm install
if errorlevel 1 (
  echo.
  echo npm install failed. Is Node.js installed? Get it from https://nodejs.org
  pause
  exit /b 1
)
echo Starting ULTRON. Keep this window open - closing it stops ULTRON.
start "" cmd /c "timeout /t 15 >nul & start http://localhost:3000"
call npm run dev
echo.
echo ULTRON stopped. Send a screenshot of any red error above.
pause
