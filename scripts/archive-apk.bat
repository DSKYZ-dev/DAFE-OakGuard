@echo off
REM Archive the current Android debug APK into releases\ with version + timestamp.
setlocal enabledelayedexpansion
set "REPO=%~dp0.."
set "SRC=%REPO%\apps\mobile\android\app\build\outputs\apk\debug\app-debug.apk"

if not exist "%SRC%" (
    echo [ERROR] No debug APK found at:
    echo         %SRC%
    echo         Build it first:  npm run android:apk -w @dafe/mobile
    pause
    exit /b 1
)

for /f "tokens=2 delims=: " %%a in ('findstr /R "\"version\"" "%REPO%\apps\mobile\package.json"') do set VER=%%a
set VER=%VER:,=%
set VER=%VER:"=%
if "%VER%"=="" set VER=0.4.0

for /f %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmmss"') do set STAMP=%%t

if not exist "%REPO%\releases" mkdir "%REPO%\releases"
copy /Y "%SRC%" "%REPO%\releases\DAFECharts-v%VER%-%STAMP%.apk" >nul
echo Archived to %REPO%\releases\DAFECharts-v%VER%-%STAMP%.apk
pause
