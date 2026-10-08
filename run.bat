@echo off
REM JB Capital - AI Trading Floor. Double-click to open the game in your browser.
REM The floor runs 24/7 in the background (scheduled task "JB Capital Floor" + scripts\watchdog.ps1).
REM If it isn't running yet, this starts the watchdog (hidden) and then opens the browser.
REM Ava uses Claude Code with your Claude Max plan by default (no API key).
REM To use an API key instead: set FLOOR_LLM=claude  and  set ANTHROPIC_API_KEY=sk-ant-...
REM To run in this window instead (old way, stops when you close it): run.bat console
cd /d "%~dp0"
if /i "%1"=="console" (
  py -u server.py
  pause
  exit /b
)
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:8000/api/status) | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo Starting the JB Capital floor in the background...
  start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\watchdog.ps1"
  powershell -NoProfile -Command "for ($i=0; $i -lt 60; $i++) { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:8000/api/status) | Out-Null; break } catch { Start-Sleep 2 } }"
)
start "" http://localhost:8000
