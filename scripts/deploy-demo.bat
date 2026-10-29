@echo off
title DAFECharts — Deploy live demo
cd /d "%~dp0.."

echo.
echo [1/3] Building web app...
call npm run build -w @dafe/web
if errorlevel 1 (
  echo BUILD FAILED
  pause
  exit /b 1
)

echo.
echo [2/3] Deploying to github.io demo...
call npx gh-pages -d apps/web/dist -b main -r https://github.com/DSKYZ-dev/dafe-charts-demo.git -m "Deploy DAFECharts demo [ci skip]"
if errorlevel 1 (
  echo DEPLOY FAILED
  pause
  exit /b 1
)

echo.
echo [3/3] Done. Live at: https://dskyz-dev.github.io/dafe-charts-demo/
echo (allow ~1 minute for GitHub Pages to rebuild)
pause