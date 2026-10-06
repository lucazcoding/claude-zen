@echo off
title ClaudeZen Hybrid Router

cd /d "C:\AI_config\ClaudeZen"

cls

echo.
echo ============================================
echo          CLAUDEZEN HYBRID ROUTER
echo ============================================
echo.
echo  Server:  http://127.0.0.1:8787
echo  Config:  C:\AI_config\ClaudeZen\config.json
echo.
echo  Iniciando ClaudeZen...
echo ============================================
echo.

node server.js

echo.
echo ============================================
echo  ClaudeZen foi encerrado.
echo ============================================
echo.
pause