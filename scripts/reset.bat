@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0.."
title DAFECharts - Hard Reset

echo.
echo  ----------------------------------------
echo   DAFE Charts - Hard Reset
echo  ----------------------------------------
echo.

echo  [1/5] Stopping llama-server (port 8081)...
powershell -NoProfile -Command "$p = Get-NetTCPConnection -LocalPort 8081 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }" 2>nul
echo         Done.

echo  [2/5] Stopping backend server (port 8788)...
powershell -NoProfile -Command "$p = Get-NetTCPConnection -LocalPort 8788 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }" 2>nul
echo         Done.

echo  [3/5] Stopping frontend dev server (port 5173)...
powershell -NoProfile -Command "$p = Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }" 2>nul
echo         Done.

echo  [4/5] Cleaning Python cache...
if exist "%~dp0..\backend\__pycache__" rmdir /s /q "%~dp0..\backend\__pycache__" 2>nul
del /s /q "%~dp0..\backend\*.pyc" 2>nul
echo         Done.

echo  [5/5] Cleaning Vite cache...
if exist "%~dp0..\apps\web\node_modules\.vite" rmdir /s /q "%~dp0..\apps\web\node_modules\.vite" 2>nul
echo         Done.

echo.
echo  ----------------------------------------
echo   Reset complete. All services stopped.
echo.
echo   Run  start.bat  to launch DAFE Charts.
echo  ----------------------------------------
echo.
pause
