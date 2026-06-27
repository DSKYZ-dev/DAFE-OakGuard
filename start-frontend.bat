@echo off
REM  DEBUG ONLY — run start.bat for the full application
cd /d "%~dp0"

set "FRONTEND_PORT=5173"

title dafe-frontend

cd /d C:\DAFECharts\apps\web
npx vite --port %FRONTEND_PORT%

echo.
echo  [INFO] Vite frontend stopped.
pause
