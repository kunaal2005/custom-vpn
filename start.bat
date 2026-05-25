@echo off
title Antigravity VPN Control Center
color 0B

echo ====================================================================
echo           ▲  A N T I G R A V I T Y   C U S T O M   V P N  ▲
echo ====================================================================
echo.
echo  This launcher will spin up:
echo  1. Local Intelligent Routing SOCKS5 Daemon (Port 1080 / API 3001)
echo  2. Glassmorphic Web Control Panel UI (Vite on Port 5173)
echo.
echo  Press any key to start the VPN system...
pause >nul

echo.
echo [*] Starting Backend Routing Service...
start "Antigravity VPN Routing Daemon" cmd /c "cd daemon && npm start"

echo [*] Starting Frontend UI Server...
start "Antigravity VPN Dashboard UI" cmd /c "cd frontend && npm run dev"

echo [*] Warming up the gateway...
timeout /t 4 /nobreak >nul

echo [*] Launching Web Dashboard...
start http://localhost:5173

echo.
echo ====================================================================
echo  VPN System is now running!
echo  - SOCKS5 local proxy: 127.0.0.1:1080
echo  - API server: http://localhost:3001
echo  - Dashboard: http://localhost:5173
echo.
echo  Keep this window open. Close it when you wish to shut down.
echo ====================================================================
echo.
pause
