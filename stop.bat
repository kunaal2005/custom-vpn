@echo off
title Stop VPN System
color 0C

echo ====================================================================
echo             [ CUSTOM VPN STOP ]
echo ====================================================================
echo.
echo [*] Stopping SOCKS5 Proxy and API Server...
powershell -Command "Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
powershell -Command "Get-NetTCPConnection -LocalPort 1080 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"

echo [*] Stopping Frontend UI Server...
powershell -Command "Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"

echo.
echo VPN System Stopped.
ping 127.0.0.1 -n 3 >nul
