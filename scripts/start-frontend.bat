@echo off
REM  Debug helper - run start.bat in the repo root for the full application.
REM  Runs the Vite dev server for the web app alone.
cd /d "%~dp0.."

set "FRONTEND_PORT=5173"

title dafe-frontend

cd /d "%~dp0..\apps\web"
npx vite --port %FRONTEND_PORT%

echo.
echo  [INFO] Vite frontend stopped.
pause
