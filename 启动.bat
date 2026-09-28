@echo off
cd /d "%~dp0"
title My Movie Station - keep this window open

echo.
echo   ============================================
echo     My Movie Station  -  starting local server
echo   ============================================
echo.
echo   The browser will open by itself in a second.
echo   To stop it later: just close this window.
echo   All your data stays on this computer.
echo.

python tools\server.py %*

if errorlevel 1 goto failed
goto end

:failed
echo.
echo   [X] The server could not start. Common reasons:
echo       1. Python is not installed.
echo          Download it from python.org and tick "Add Python to PATH".
echo       2. Port 8765 is already in use.
echo          Close the other black window first, then run this again.
echo.

:end
pause