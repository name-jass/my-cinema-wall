@echo off
cd /d "%~dp0"
title My Movie Station - update data

echo.
echo   ============================================
echo     Update data: re-read Excel + fetch covers
echo   ============================================
echo.
echo   - Covers already saved locally are NOT re-downloaded.
echo   - If Douban rate-limits us, the script stops by itself
echo     to protect your IP.
echo   - To retry only the ones that failed last time, run:
echo       python tools\fetch_covers.py --only-failed
echo.

python tools\fetch_covers.py %*

echo.
pause