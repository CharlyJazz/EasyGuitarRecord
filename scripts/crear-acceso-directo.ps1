$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop -or -not (Test-Path $desktop)) {
    $candidatos = @(
        (Join-Path $env:USERPROFILE "OneDrive\Escritorio"),
        (Join-Path $env:USERPROFILE "OneDrive\Desktop"),
        (Join-Path $env:USERPROFILE "Desktop"),
        (Join-Path $env:USERPROFILE "Escritorio")
    )
    $desktop = $candidatos | Where-Object { Test-Path $_ } | Select-Object -First 1
}

$raiz = Split-Path -Parent $PSScriptRoot
$bat = Join-Path $raiz 'iniciar-servidor.bat'
$lnk = Join-Path $desktop 'Iniciar Servidor EasyChord.lnk'

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($lnk)
$shortcut.TargetPath = $bat
$shortcut.WorkingDirectory = $raiz
$shortcut.Description = 'Iniciar Monitor de Camara EasyGuitarRecord'
$shortcut.IconLocation = 'shell32.dll,116'  # Icono de camara de video de Windows
$shortcut.Save()

Write-Host "Acceso directo creado en: $lnk"
