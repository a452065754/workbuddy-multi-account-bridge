@echo off
title WorkBuddy Multi-Account Bridge
cd /d "%~dp0"

echo.
echo ===== WorkBuddy Multi-Account Bridge (portable) =====
echo Working dir: %~dp0
echo.

rem ===== 1. Find Node =====
set "NODE="
if exist "D:\Program Files\nodejs\node.exe" set "NODE=D:\Program Files\nodejs\node.exe"
if not defined NODE (
  if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
)
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (
  for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
)
if not defined NODE (
  echo [ERR] node.exe not found.
  echo Install Node.js LTS: https://nodejs.org
  echo Or set NODE path in a terminal before running this script.
  pause
  exit /b 1
)
echo [OK] node = %NODE%

rem ===== 2. Check port (reliable probe via node) =====
set "PORT_OPEN=False"
for /f "delims=" %%a in ('"%NODE%" "%~dp0check-port.cjs" 2^>nul') do set "PORT_OPEN=%%a"
if /i "%PORT_OPEN%"=="True" (
  echo [INFO] Service is already running. Opening browser.
  start "" "http://127.0.0.1:3085/"
  pause
  exit /b 0
)
echo [OK] Port free

rem ===== 3. Run launcher (reads portable-config.txt, installs deps, starts webapp) =====
echo Starting service. Keep this window open.
echo Browser will auto-open.
echo.
"%NODE%" "%~dp0run-bridge.cjs"
set "RC=%errorlevel%"

echo.
echo ===== Service stopped (exit code %RC%) =====
if "%RC%"=="0" (
  echo [info] exited normally.
) else (
  echo [diag] exit code %RC%.
  echo   1. Check that Node.js is installed.
  echo   2. If desktop account A is needed, install WorkBuddy / WorkBuddyAI desktop client.
  echo   3. If desktop account A is needed, install DSH web profile with dsh-workbuddy-connect.
  echo   4. Web accounts B/C/D... only need Node.js; login cookies can be imported via UI.
  echo   5. Edit portable-config.txt if paths are wrong, then retry.
  echo   Run manually for full log: "%NODE%" "%~dp0run-bridge.cjs"
)
echo.
pause
