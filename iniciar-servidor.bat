@echo off
title EasyGuitarRecord - Monitor de Camara
cd /d "%~dp0"

echo ========================================================
echo         EasyGuitarRecord - Monitor de Camara
echo ========================================================
echo.

:: Si ya habia un servidor corriendo en segundo plano en el puerto 3000, cerrarlo para mostrarlo aqui
powershell -NoProfile -Command "$conn = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue; if ($conn) { $pids = $conn.OwningProcess | Select-Object -Unique; foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Write-Host \"Liberando puerto 3000 (PID $p)...\" } }"

echo Iniciando servidor con entorno local (ffmpeg, Node)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ". .\scripts\entorno.ps1; node server.js"

pause
