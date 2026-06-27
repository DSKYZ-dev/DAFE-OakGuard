@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title DAFECharts - Hard Reset

echo.
echo  ----------------------------------------
echo   DAFE Charts - Hard Reset
echo  ----------------------------------------
echo.

echo  [1/4] Stopping all services...
powershell -NoProfile -Command "$w='llama-server','dafe-backend','dafe-frontend';Get-Process|Where-Object{$w -contains $_.MainWindowTitle}|Stop-Process -Force -ErrorAction SilentlyContinue" 2>nul
timeout /t 1 /nobreak >nul
echo         Done.

echo  [2/4] Cleaning Python cache...
if exist "C:\DAFECharts\backend\__pycache__" rmdir /s /q "C:\DAFECharts\backend\__pycache__" 2>nul
del /s /q "C:\DAFECharts\backend\*.pyc" 2>nul
echo         Done.

echo  [3/4] Cleaning Vite cache...
if exist "C:\DAFECharts\apps\web\node_modules\.vite" rmdir /s /q "C:\DAFECharts\apps\web\node_modules\.vite" 2>nul
echo         Done.

echo  [4/4] Flushing DNS...
ipconfig /flushdns >nul 2>&1
echo         Done.

echo.
echo  ----------------------------------------
echo   Reset complete.
echo.
echo   Run  start.bat  to launch DAFE Charts.
echo  ----------------------------------------
echo.
pause
