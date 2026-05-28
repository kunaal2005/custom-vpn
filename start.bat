@echo off
title Custom VPN Control Center
color 0B

echo ====================================================================
echo                 [ CUSTOM VPN ]
echo ====================================================================
echo.
echo  This launcher will spin up (in hidden mode):
echo  1. Local SOCKS5 Routing Daemon (Port 1080 / API 3001)
echo  2. Web Control Panel UI (Vite on Port 5173)
echo.
echo  Press any key to start the VPN system...
pause >nul

echo.
echo [*] Starting Backend Routing Service (Hidden)...
powershell -Command "Start-Process cmd -ArgumentList '/c cd daemon && npm start' -WindowStyle Hidden"

echo [*] Starting Frontend UI Server (Hidden)...
powershell -Command "Start-Process cmd -ArgumentList '/c cd frontend && npm run dev' -WindowStyle Hidden"

echo [*] Warming up the gateway...
ping 127.0.0.1 -n 5 >nul

echo [*] Launching Web Dashboard...
start http://localhost:5173

echo.
echo ====================================================================
echo  VPN System is now running!
echo  - SOCKS5 local proxy: 127.0.0.1:1080
echo  - API server: http://localhost:3001
echo  - Dashboard: http://localhost:5173
echo.
echo  PRESS ANY KEY IN THIS TERMINAL TO STOP THE VPN AND EXIT.
echo ====================================================================
echo.
pause >nul

echo [*] Stopping SOCKS5 Proxy and API Server...
powershell -Command "Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
powershell -Command "Get-NetTCPConnection -LocalPort 1080 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"

echo [*] Stopping Frontend UI Server...
powershell -Command "Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"

echo.
echo VPN System Stopped.
ping 127.0.0.1 -n 3 >nul
