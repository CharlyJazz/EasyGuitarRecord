@echo off
title Remotion Studio - EasyGuitarRecord
cd /d "%~dp0"

echo ========================================================
echo             Remotion Studio (Base)
echo ========================================================
echo.

:: Si ya habia un proceso corriendo en el puerto 3200, liberarlo
powershell -NoProfile -Command "$conn = Get-NetTCPConnection -LocalPort 3200 -ErrorAction SilentlyContinue; if ($conn) { $pids = $conn.OwningProcess | Select-Object -Unique; foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Write-Host \"Liberando puerto 3200 (PID $p)...\" } }"

echo Iniciando Remotion Studio en http://localhost:3200...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ". .\scripts\entorno.ps1; cd agents\remotion-base; npx remotion studio src/index.ts --port 3200"

pause
