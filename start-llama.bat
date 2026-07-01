@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Llama Server Debug

set "MODEL_DIR=%~dp0models"
set "LLAMA_PORT=8081"

:: Discover llama-server portably (env LLAMA_DIR, bundled, or PATH).
set "LLAMA_EXE="
for /f "usebackq delims=" %%p in (`python "%~dp0backend\model_manager.py" llama-path 2^>nul`) do set "LLAMA_EXE=%%p"
if defined LLAMA_EXE (
    for %%d in ("%LLAMA_EXE%") do set "LLAMA_DIR=%%~dpd"
) else (
    set "LLAMA_DIR=C:\llama.cpp\"
)

:: Pick model + adaptive params via the shared model manager (same logic
:: as start.bat and the backend — single source of truth).
set "MODEL_NAME=NONE"
set "CTX=2048"
set "NGL=0"
set "BSIZE=256"
set "NTHREADS=4"
for /f "usebackq tokens=1-5 delims=|" %%a in (`python "%~dp0backend\model_manager.py" select 2^>nul`) do (
    set "MODEL_NAME=%%a"
    set "CTX=%%b"
    set "NGL=%%c"
    set "BSIZE=%%d"
    set "NTHREADS=%%e"
)

if "%MODEL_NAME%"=="NONE" (
    echo [ERROR] No .gguf models found in %MODEL_DIR%
    echo Place .gguf files in %MODEL_DIR% and retry.
    pause
    exit /b 1
)
echo [HW] Selected via model_manager — ngl=%NGL% ctx=%CTX% batch=%BSIZE% threads=%NTHREADS%

:: Kill old instances
taskkill /F /IM llama-server.exe 2>nul >nul
timeout /t 1 /nobreak >nul

:: Print config
echo =============================================
echo  Llama Server Debug
echo =============================================
echo  Model: %MODEL_NAME%
echo  Port:  %LLAMA_PORT%
echo  Ctx:   %CTX%
echo  NGL:   %NGL%
echo =============================================
echo.

:: Launch with log capture
set "LOG_FILE=%TEMP%\dafe_llama_debug.log"
echo --- Llama Server Log %DATE% %TIME% --- > "%LOG_FILE%"

cd /d "%LLAMA_DIR%"
llama-server.exe -m "%MODEL_DIR%\%MODEL_NAME%" --port %LLAMA_PORT% --host 127.0.0.1 -c %CTX% -ngl %NGL% -b %BSIZE% -t %NTHREADS% >> "%LOG_FILE%" 2>&1

set "EXIT_CODE=%errorlevel%"
echo =============================================
echo  llama-server exited with code: %EXIT_CODE%
echo  Full log saved to: %LOG_FILE%
echo =============================================
echo.
echo  Last 20 lines of log:
echo  ---------------------
powershell -NoProfile -Command "Get-Content '%LOG_FILE%' -Tail 20"
echo.
echo  ---------------------
echo.
echo  Common causes of crashes:
echo   1. Model too large for VRAM — try ctx=1024
echo   2. Wrong CUDA version — check with nvidia-smi
echo   3. Corrupted model file — try re-downloading
echo.
pause
exit /b %EXIT_CODE%
