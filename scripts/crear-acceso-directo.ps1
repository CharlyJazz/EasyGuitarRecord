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
$wsh = New-Object -ComObject WScript.Shell

# 1. Monitor de camara
$bat1 = Join-Path $raiz 'iniciar-servidor.bat'
$lnk1 = Join-Path $desktop 'Iniciar Servidor EasyChord.lnk'
$shortcut1 = $wsh.CreateShortcut($lnk1)
$shortcut1.TargetPath = $bat1
$shortcut1.WorkingDirectory = $raiz
$shortcut1.Description = 'Iniciar Monitor de Camara EasyGuitarRecord'
$shortcut1.IconLocation = 'shell32.dll,116'  # Icono de camara de video de Windows
$shortcut1.Save()
Write-Host "Acceso directo creado en: $lnk1"

# 2. Remotion Studio
$bat2 = Join-Path $raiz 'iniciar-remotion.bat'
$lnk2 = Join-Path $desktop 'Iniciar Remotion Studio.lnk'
$shortcut2 = $wsh.CreateShortcut($lnk2)
$shortcut2.TargetPath = $bat2
$shortcut2.WorkingDirectory = $raiz
$shortcut2.Description = 'Iniciar Remotion Studio (EasyGuitarRecord)'
$shortcut2.IconLocation = 'shell32.dll,14'   # Icono de pantalla / multimedia de Windows
$shortcut2.Save()
Write-Host "Acceso directo creado en: $lnk2"
