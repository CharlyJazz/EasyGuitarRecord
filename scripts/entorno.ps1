# Activa el entorno local del taller (.entorno/, lo arma scripts/preparar-entorno.ps1) en ESTA terminal:
#   . .\scripts\entorno.ps1          (con el punto adelante: si no, no queda activo)
# Pone ffmpeg/ffprobe/uv primero en el PATH y deja la cache de uv, Python 3.11 y los modelos de whisper
# dentro del repo. No toca nada del sistema; cerrar la terminal lo deshace.
$__raiz = Split-Path -Parent $PSScriptRoot
$__ent = Join-Path $__raiz ".entorno"
$env:PATH = "$(Join-Path $__ent 'bin');$env:PATH"
$env:UV_CACHE_DIR = Join-Path $__ent "uv-cache"
$env:UV_PYTHON_INSTALL_DIR = Join-Path $__ent "python"
$env:UV_PYTHON_PREFERENCE = "only-managed"   # usar el 3.11 de .entorno, no el Python del sistema
$env:UV_LINK_MODE = "copy"                  # cache y repo pueden estar en discos distintos
$env:UV_NATIVE_TLS = "1"                    # certificados de Windows (un antivirus/proxy que inspecciona HTTPS
$env:UV_SYSTEM_CERTS = "1"                  # pone su propia CA ahi; con los de uv da "UnknownIssuer")
$env:HF_HOME = Join-Path $__ent "hf"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"  # Windows sin modo desarrollador: copia en vez de symlink, anda igual
$env:PYTHONIOENCODING = "utf-8"
$env:FFMPEG = Join-Path $__ent "bin\ffmpeg.exe"   # lo lee remux.js (server del monitor)
# Node (npm, Remotion) no usa los certificados de Windows: si un antivirus inspecciona HTTPS (Avast, etc.)
# falla con UNABLE_TO_VERIFY_LEAF_SIGNATURE. Se exportan las raices de confianza de Windows a un PEM.
$__pem = Join-Path $__ent "ca-windows.pem"
if (-not (Test-Path $__pem) -and (Test-Path $__ent)) {
  $__sb = New-Object System.Text.StringBuilder
  Get-ChildItem Cert:\LocalMachine\Root, Cert:\CurrentUser\Root -ErrorAction SilentlyContinue | Sort-Object Thumbprint -Unique | ForEach-Object {
    [void]$__sb.AppendLine("-----BEGIN CERTIFICATE-----")
    [void]$__sb.AppendLine([Convert]::ToBase64String($_.RawData, "InsertLineBreaks"))
    [void]$__sb.AppendLine("-----END CERTIFICATE-----")
  }
  [IO.File]::WriteAllText($__pem, $__sb.ToString())
  Remove-Variable __sb
}
if (Test-Path $__pem) { $env:NODE_EXTRA_CA_CERTS = $__pem }
Remove-Variable __pem
Remove-Variable __raiz, __ent
