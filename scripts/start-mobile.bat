@echo off
title DAFE Charts - Mobile
echo.
echo  Starting DAFE Charts Mobile...
echo  Open on your phone:  http://YOUR-LAN-IP:5174
echo  (find YOUR-LAN-IP with: ipconfig)
echo.
cd /d "%~dp0.."
call npm run dev -w @dafe/mobile
pause