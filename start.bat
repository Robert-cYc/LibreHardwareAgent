@echo off
chcp 65001 > nul
cd /d "%~dp0"
title AI Hardware Monitor
echo ===================================================
echo   Starting AI-Driven Dynamic Hardware Monitor...
echo ===================================================
echo.
echo [1] Checking and starting the server...
echo [2] Please make sure Libre Hardware Monitor is running with Remote Web Server enabled.
echo [3] Opening your browser at: http://localhost:63210
echo.

start http://localhost:63210

python -m uvicorn main:app --reload --host 0.0.0.0 --port 63210

pause
