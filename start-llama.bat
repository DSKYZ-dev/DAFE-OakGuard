@echo off
REM  DEBUG ONLY — run start.bat for the full application
cd /d "%~dp0"

set "LLAMA_DIR=C:\llama.cpp"
set "MODEL_DIR=C:\DAFECharts\models"
set "MODEL_NAME=Qwythos-9B-Claude-Mythos-5-1M-MTP-Q4_K_M.gguf"
set "LLAMA_PORT=8081"

title llama-server

cd /d "%LLAMA_DIR%"

echo ========================================
echo  Text-only mode
echo  Model: %MODEL_DIR%\%MODEL_NAME%
echo ========================================
llama-server.exe -m "%MODEL_DIR%\%MODEL_NAME%" --port %LLAMA_PORT% --host 127.0.0.1 -c 2048 -ngl -1 -b 512

if errorlevel 1 (
    echo.
    echo  [ERROR] llama-server.exe exited with code %errorlevel%
    echo.
    echo  Common fixes:
    echo    - Make sure C:\llama.cpp\llama-server.exe exists and is a CUDA build
    echo    - Try running start.bat -no-llm to skip LLM entirely
    echo    - Check that VRAM is not in use by other apps
    pause
)
