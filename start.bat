@echo off
rem FBX Anim Studio launcher - starts a tiny local server and opens the tool.
rem (ES modules are blocked on file:// by Chrome/Edge, so a local server is required.)
cd /d "%~dp0"
start "" "http://127.0.0.1:8799/"
where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server 8799 --bind 127.0.0.1
  goto :eof
)
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 -m http.server 8799 --bind 127.0.0.1
  goto :eof
)
echo Python not found. Install Python 3 or serve this folder with any static server.
pause
