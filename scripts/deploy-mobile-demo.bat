@echo off
title DAFECharts — Deploy MOBILE demo
cd /d "%~dp0.."

echo.
echo [1/3] Building mobile app...
call npm run build -w @dafe/mobile
if errorlevel 1 (
  echo BUILD FAILED
  pause
  exit /b 1
)

echo.
echo [2/3] Deploying to github.io mobile demo...
call npx gh-pages -d apps/mobile/dist -b main -r https://github.com/DSKYZ-dev/dafe-mobile-demo.git -m "Deploy DAFECharts mobile demo [ci skip]"
if errorlevel 1 (
  echo DEPLOY FAILED
  pause
  exit /b 1
)

echo.
echo [3/3] Done. Live at: https://dskyz-dev.github.io/dafe-mobile-demo/?demo=1
echo (allow ~1 minute for GitHub Pages to rebuild)
pause
