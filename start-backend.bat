@echo off
REM  DEBUG ONLY — run start.bat for the full application
cd /d "%~dp0"

set "BACKEND_PORT=8788"
set "USE_VISION=%~1"
set "LLM_PROVIDER=local"
set "LOCAL_LLM_BASE_URL=http://localhost:8081"
if "%USE_VISION%"=="1" set "VISION=1"

title dafe-backend

cd /d C:\DAFECharts\backend
python -m uvicorn main:app --reload --host 127.0.0.1 --port %BACKEND_PORT%

if errorlevel 1 (
    echo.
    echo  [ERROR] Backend exited with code %errorlevel%
    pause
)
