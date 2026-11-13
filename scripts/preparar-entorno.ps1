# Prepara el entorno local del taller en .entorno/ (gitignored), sin instalar nada en el sistema:
#   .entorno/bin      ffmpeg, ffprobe, uv, uvx
#   .entorno/python   Python 3.11 de uv (el que piden los scripts: uv run --python 3.11)
#   .entorno/uv-cache paquetes de Python (numpy, scipy, librosa, faster-whisper...)
#   .entorno/hf       modelos de whisper (Hugging Face)
# Despues instala node_modules del monitor y de agents/remotion-base, y el Chrome headless de Remotion.
#
# Uso (PowerShell, desde la raiz del repo):
#   powershell -ExecutionPolicy Bypass -File scripts/preparar-entorno.ps1 [-Whisper] [-SinRemotion]
#   -Whisper     baja tambien el modelo large-v3-turbo (~1,6 GB) para transcribir sin esperar la primera vez
#   -SinRemotion no instala agents/remotion-base
# Es idempotente: lo que ya esta, no se vuelve a bajar.
param([switch]$Whisper, [switch]$SinRemotion)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest es 10x mas lento con la barra
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$raiz = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "entorno.ps1")
$bin = Join-Path $raiz ".entorno\bin"
$tmp = Join-Path $raiz ".entorno\tmp"
New-Item -ItemType Directory -Force $bin, $tmp | Out-Null

function Bajar($url, $destino) {
  Write-Host "  bajando $url"
  # curl.exe (viene con Windows 10+): Invoke-WebRequest se cuelga con archivos grandes en PowerShell 5.1
  & curl.exe -L --fail --retry 3 --connect-timeout 30 -sS -o $destino $url
  if ($LASTEXITCODE) { throw "fallo la descarga de $url" }
}

# --- uv ---
if (-not (Test-Path (Join-Path $bin "uv.exe"))) {
  Write-Host "[uv]"
  $zip = Join-Path $tmp "uv.zip"
  Bajar "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip" $zip
  Expand-Archive $zip -DestinationPath (Join-Path $tmp "uv") -Force
  Get-ChildItem (Join-Path $tmp "uv") -Recurse -Include uv.exe, uvx.exe, uvw.exe | Copy-Item -Destination $bin -Force
}
Write-Host "[uv] $(& uv --version)"

# --- ffmpeg (build GPL de BtbN en GitHub: trae libx264, nvenc, amf, qsv, loudnorm, ebur128) ---
if (-not (Test-Path (Join-Path $bin "ffmpeg.exe"))) {
  Write-Host "[ffmpeg]"
  $zip = Join-Path $tmp "ffmpeg.zip"
  Bajar "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" $zip
  Expand-Archive $zip -DestinationPath (Join-Path $tmp "ffmpeg") -Force
  Get-ChildItem (Join-Path $tmp "ffmpeg") -Recurse -Include ffmpeg.exe, ffprobe.exe | Copy-Item -Destination $bin -Force
}
Write-Host "[ffmpeg] $((& ffmpeg -hide_banner -version | Select-Object -First 1))"

# --- Python 3.11 + paquetes de los scripts (quedan en la cache de uv) ---
Write-Host "[python] uv python install 3.11"
& uv python install 3.11
if ($LASTEXITCODE) { throw "uv python install fallo" }
Write-Host "[python] precalentando paquetes de sync/mezcla/voz/bandas/cortar_toma/transcribir"
& uv run --no-project --python 3.11 --with numpy --with scipy python -c "import numpy, scipy; print('  sync/cortar_toma ok', numpy.__version__, scipy.__version__)"
if ($LASTEXITCODE) { throw "paquetes de sync fallaron" }
& uv run --no-project --python 3.11 --with librosa --with soundfile --with "numpy<2" python -c "import librosa, soundfile; print('  mezcla/voz/bandas ok', librosa.__version__)"
if ($LASTEXITCODE) { throw "paquetes de mezcla fallaron" }
& uv run --no-project --python 3.11 --with faster-whisper --with soundfile --with librosa --with "numpy<2" python -c "import faster_whisper; print('  transcribir ok', faster_whisper.__version__)"
if ($LASTEXITCODE) { throw "paquetes de whisper fallaron" }

if ($Whisper) {
  Write-Host "[whisper] bajando large-v3-turbo a .entorno/hf"
  & uv run --no-project --python 3.11 --with faster-whisper python -c "from faster_whisper.utils import download_model; print('  ', download_model('large-v3-turbo'))"
  if ($LASTEXITCODE) { throw "descarga del modelo fallo" }
}

# --- Node: monitor ---
Write-Host "[npm] monitor (raiz)"
Push-Location $raiz
& npm install --no-fund --no-audit
if ($LASTEXITCODE) { Pop-Location; throw "npm install del monitor fallo" }
Pop-Location

# --- Node: base de Remotion ---
if (-not $SinRemotion) {
  $base = Join-Path $raiz "agents\remotion-base"
  Write-Host "[npm] agents/remotion-base"
  Push-Location $base
  & npm install --no-fund --no-audit
  if ($LASTEXITCODE) { Pop-Location; throw "npm install de remotion-base fallo" }
  Write-Host "[remotion] Chrome headless"
  & npx remotion browser ensure
  if ($LASTEXITCODE) { Pop-Location; throw "remotion browser ensure fallo" }
  Pop-Location
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "`nListo. En cada terminal nueva: . .\scripts\entorno.ps1"
