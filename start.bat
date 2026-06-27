@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

title DAFE System

:: ─── Configuration ─────────────────────────────────────────────
set "LLAMA_DIR=C:\llama.cpp"
set "MODEL_DIR=C:\DAFECharts\models"
set "MODEL_NAME=Qwythos-9B-Claude-Mythos-5-1M-MTP-Q4_K_M.gguf"
set "LLAMA_PORT=8081"
set "BACKEND_PORT=8788"
set "FRONTEND_PORT=5173"
set "USE_VISION=0"

:: ─── Parse args ───────────────────────────────────────────────
if /I "%1"=="-reset" goto reset
if /I "%1"=="reset" goto reset
if /I "%1"=="-vision" set "USE_VISION=1"
if /I "%1"=="vision" set "USE_VISION=1"
if /I "%1"=="-no-llm" set "SKIP_LLAMA=1"
if /I "%1"=="no-llm" set "SKIP_LLAMA=1"

:: ─── Banner ────────────────────────────────────────────────────
echo.
echo  DAFE Trading System
echo  -------------------
echo.
echo  Services that will start:
echo    1. LLM         http://127.0.0.1:%LLAMA_PORT%
echo    2. Backend     http://127.0.0.1:%BACKEND_PORT%
echo    3. Frontend    http://127.0.0.1:%FRONTEND_PORT%
echo.
echo  Flags:  start.bat -no-llm   (skip LLM)
echo          start.bat -vision   (image mode, needs mmproj)
echo          start.bat -reset    (kill all + clear cache)
echo.

:: ─── Check model ───────────────────────────────────────────────
if defined SKIP_LLAMA goto skip_llama_check
set "SKIP_LLAMA=1"
if exist "%MODEL_DIR%\%MODEL_NAME%" set "SKIP_LLAMA=0"
if "%SKIP_LLAMA%"=="1" (
    echo  [INFO] Model not found at %MODEL_DIR%\%MODEL_NAME%
    echo         Continuing without LLM ^(use -no-llm to hide^)
)
:skip_llama_check

if "%USE_VISION%"=="1" (
    echo  [INFO] Vision mode ^(slow^)
) else (
    echo  [INFO] Text-only mode ^(fast^)
)

:: ─── Kill old services (non-blocking PowerShell) ──────────────
echo.
echo  [1/4] Stopping previous instances...
powershell -NoProfile -Command "$w='llama-server','dafe-backend','dafe-frontend';Get-Process|Where-Object{$w -contains $_.MainWindowTitle}|Stop-Process -Force -ErrorAction SilentlyContinue" 2>nul
:: Also kill any process squatting on our ports
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8788,5173,8081 -ErrorAction SilentlyContinue|ForEach-Object{Stop-Process -Id `$_.OwningProcess -Force -ErrorAction SilentlyContinue}" 2>nul
timeout /t 1 /nobreak >nul
echo         Done.

:: ═══════════════════════════════════════════════════════════════
::  Adaptive hardware detection
:: ═══════════════════════════════════════════════════════════════

if "%SKIP_LLAMA%"=="0" (
    :: Simple GPU check — if nvidia-smi exists, assume GPU is available
    set "HAS_GPU=0"
    where nvidia-smi >nul 2>&1
    if not errorlevel 1 set "HAS_GPU=1"

    if !HAS_GPU! EQU 1 (
        :: GPU present — conservative defaults for 8GB VRAM
        set "NGPULAYERS=-1"
        set "CTX=4096"
        set "BSIZE=256"
        set /a "NTHREADS=4"
        echo  [HW]  GPU detected — using GPU-accelerated mode
    ) else (
        :: No GPU — CPU-only, use half of logical cores
        set "NGPULAYERS=0"
        set "CTX=1024"
        set "BSIZE=32"
        for /f "tokens=*" %%i in ('powershell -NoProfile -Command "[Environment]::ProcessorCount"') do set "CPU_CORES=%%i"
        if "!CPU_CORES!"=="" set "CPU_CORES=4"
        set /a "NTHREADS=!CPU_CORES! / 2"
        if !NTHREADS! LSS 2 set "NTHREADS=2"
        if !NTHREADS! GTR 8 set "NTHREADS=8"
        echo  [HW]  No GPU — using CPU mode ^(%CPU_CORES% cores, %NTHREADS% threads^)
    )
    echo  [HW]  Params:  -ngl %NGPULAYERS%  -c %CTX%  -b %BSIZE%  -t %NTHREADS%
)

:: ═══════════════════════════════════════════════════════════════
::  2/4 — LLM (optional)
:: ═══════════════════════════════════════════════════════════════
echo.
if "%SKIP_LLAMA%"=="0" (
    echo  [2/4] Starting local LLM on port %LLAMA_PORT%...

    :: Pre-flight checks
    if not exist "%LLAMA_DIR%\llama-server.exe" (
        echo  [SKIP] llama-server.exe not found at %LLAMA_DIR%
        echo         Install llama.cpp CUDA build there, or use start.bat -no-llm
        goto skip_llama
    )
    if not exist "%MODEL_DIR%\%MODEL_NAME%" (
        echo  [SKIP] Model not found at %MODEL_DIR%\%MODEL_NAME%
        goto skip_llama
    )

    :: Launch with auto-detected params — text-only mode
    start "llama-server" cmd /k "cd /d %LLAMA_DIR% && llama-server.exe -m %MODEL_DIR%\%MODEL_NAME% --port %LLAMA_PORT% --host 127.0.0.1 -c !CTX! -ngl !NGPULAYERS! -b !BSIZE! -t !NTHREADS!"

    :: Fast crash detection
    timeout /t 6 /nobreak >nul
    tasklist /FI "WINDOWTITLE eq llama-server" /NH 2>nul | findstr "cmd.exe" >nul
    if errorlevel 1 (
        echo  [SKIP] LLM crashed on startup — see the llama-server window for errors
        goto skip_llama
    )

    echo         Loading model — this may take 15-60s. Please wait...
    set WAIT=0
    :wait_llama
    timeout /t 3 /nobreak >nul
    set /a WAIT+=1
    if !WAIT! gtr 30 (
        echo  [SKIP] LLM still not responding after 90s — continuing without LLM
        goto skip_llama
    )
    powershell -NoProfile -Command "try{$r=Invoke-WebRequest -Uri 'http://127.0.0.1:%LLAMA_PORT%/health' -TimeoutSec 3 -UseBasicParsing;if($r.Content -match 'ok'){exit 0}else{exit 1}}catch{exit 1}" >nul 2>&1
    if errorlevel 1 goto wait_llama
    echo  [OK]  LLM ready
) else (
    echo  [2/4] LLM skipped
)
:skip_llama

:: ═══════════════════════════════════════════════════════════════
::  3/4 — Backend
:: ═══════════════════════════════════════════════════════════════
echo.
echo  [3/4] Starting backend on port %BACKEND_PORT%...
start "dafe-backend" cmd /k "cd /d C:\DAFECharts\backend && python -m uvicorn main:app --host 127.0.0.1 --port %BACKEND_PORT%"

echo         Waiting for backend ^(up to 60s^)...
set WAIT=0
:wait_backend
timeout /t 3 /nobreak >nul
set /a WAIT+=1
if !WAIT! gtr 20 (
    echo  [WARN] Backend not responding — app will use synthetic data
    goto skip_backend
)
powershell -NoProfile -Command "try{Invoke-WebRequest -Uri 'http://127.0.0.1:%BACKEND_PORT%/api/ping' -TimeoutSec 3 -UseBasicParsing;exit 0}catch{exit 1}" >nul 2>&1
if errorlevel 1 goto wait_backend
echo  [OK]  Backend ready
:skip_backend

:: ═══════════════════════════════════════════════════════════════
::  4/4 — Frontend
:: ═══════════════════════════════════════════════════════════════
echo.
echo  [4/4] Starting frontend on port %FRONTEND_PORT%...
start "dafe-frontend" cmd /k "cd /d C:\DAFECharts\apps\web && npx vite --port %FRONTEND_PORT%"

echo         Waiting for frontend ^(up to 60s^)...
set WAIT=0
:wait_frontend
timeout /t 3 /nobreak >nul
set /a WAIT+=1
if !WAIT! gtr 20 (
    echo  [WARN] Frontend not responding
    goto skip_frontend
)
powershell -NoProfile -Command "try{Invoke-WebRequest -Uri 'http://127.0.0.1:%FRONTEND_PORT%/' -TimeoutSec 3 -UseBasicParsing;exit 0}catch{exit 1}" >nul 2>&1
if errorlevel 1 goto wait_frontend
echo  [OK]  Frontend ready
:skip_frontend

:: ─── Open browser ─────────────────────────────────────────────
echo.
echo  Opening browser...
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:%FRONTEND_PORT%"

echo.
echo  +--------------------------------------+
echo  |  DAFE Charts is running              |
echo  |  http://127.0.0.1:%FRONTEND_PORT%              |
echo  |                                      |
echo  |  Type a symbol and press Enter       |
echo  |  Click the diamond for Trade Advisor |
echo  +--------------------------------------+
echo.
echo  Press ENTER to stop all services...
pause >nul

:: ─── Shutdown ──────────────────────────────────────────────────
echo.
echo  Shutting down...
powershell -NoProfile -Command "$w='llama-server','dafe-backend','dafe-frontend';Get-Process|Where-Object{$w -contains $_.MainWindowTitle}|Stop-Process -Force -ErrorAction SilentlyContinue" 2>nul
echo  All services stopped.
exit /b

:: ═══════════════════════════════════════════════════════════════
::  RESET  (start.bat -reset)
:: ═══════════════════════════════════════════════════════════════
:reset
echo.
echo  ----------------------------------------
echo   DAFE Charts - Hard Reset
echo  ----------------------------------------
echo.

echo  [1/4] Stopping all services...
powershell -NoProfile -Command "$w='llama-server','dafe-backend','dafe-frontend';Get-Process|Where-Object{$w -contains $_.MainWindowTitle}|Stop-Process -Force -ErrorAction SilentlyContinue" 2>nul
timeout /t 1 /nobreak >nul
echo         Done.

echo  [2/4] Cleaning caches...
if exist "C:\DAFECharts\backend\__pycache__" rmdir /s /q "C:\DAFECharts\backend\__pycache__" 2>nul
if exist "C:\DAFECharts\apps\web\node_modules\.vite" rmdir /s /q "C:\DAFECharts\apps\web\node_modules\.vite" 2>nul
del /s /q "C:\DAFECharts\backend\*.pyc" 2>nul
echo         Done.

echo  [3/4] Flushing DNS...
ipconfig /flushdns >nul 2>&1
echo         Done.

echo.
echo  [4/4] Reset complete.
echo.
echo    Run  start.bat  to launch fresh.
echo.
pause
exit /b
