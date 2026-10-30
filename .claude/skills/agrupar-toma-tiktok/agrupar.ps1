# Copia un video del iphone-monitor + su toma de FL Studio a
#   D:\Tomas - TIKTOKIG\<fecha humana>\<hora> [- etiqueta] - video|audio.<ext>
# No busca archivos: recibe los dos paths (el video puede ser la URL del monitor).
param(
  [Parameter(Mandatory)][string]$Video,
  [Parameter(Mandatory)][string]$Audio,
  [string]$Etiqueta = '',
  [string]$Raiz = 'D:\Tomas - TIKTOKIG',
  [switch]$NoAbrir
)
$ErrorActionPreference = 'Stop'

# URL del monitor -> archivo en disco
if ($Video -match '^https?://[^/]+/grabaciones/(.+)$') {
  # La skill vive en <repo>\.claude\skills\agrupar-toma-tiktok; las tomas, en <repo>\grabaciones.
  # Si se la llama por un junction (~\.claude\skills), se sigue hasta la carpeta real.
  $aqui = Get-Item -LiteralPath $PSScriptRoot
  if ($aqui.LinkType) { $aqui = Get-Item -LiteralPath @($aqui.Target)[0] }
  $Video = Join-Path (Join-Path $aqui.FullName '..\..\..\grabaciones') ([uri]::UnescapeDataString($Matches[1]))
}
foreach ($p in $Video, $Audio) {
  if (-not (Test-Path -LiteralPath $p)) { throw "No existe: $p" }
}

# La hora sale del nombre de la toma de video (toma-YYYY-MM-DD_HH-MM-SS); si no, de la fecha del archivo
$v = Get-Item -LiteralPath $Video
if ($v.BaseName -match '(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})') {
  $cuando = Get-Date -Year $Matches[1] -Month $Matches[2] -Day $Matches[3] -Hour $Matches[4] -Minute $Matches[5] -Second $Matches[6]
} else {
  $cuando = $v.LastWriteTime
}

$meses = 'enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'
$dia = "{0} de {1} de {2}" -f $cuando.Day, $meses[$cuando.Month - 1], $cuando.Year
$hora = $cuando.ToString('HH') + 'h' + $cuando.ToString('mm')

$carpeta = Join-Path $Raiz $dia
New-Item -ItemType Directory -Force -Path $carpeta | Out-Null

$base = $hora
if ($Etiqueta) { $base += ' - ' + ($Etiqueta -replace '[\\/:*?"<>|]', '') }
# Si ya hay una toma con ese nombre, numerar en vez de pisar
$n = 1; $stem = $base
while (Get-ChildItem -LiteralPath $carpeta -Filter "$stem - *" -ErrorAction SilentlyContinue) { $n++; $stem = "$base ($n)" }

$destVideo = Join-Path $carpeta ("$stem - video" + $v.Extension)
$destAudio = Join-Path $carpeta ("$stem - audio" + (Get-Item -LiteralPath $Audio).Extension)
Copy-Item -LiteralPath $Video -Destination $destVideo
Copy-Item -LiteralPath $Audio -Destination $destAudio

foreach ($pair in @(@($Video, $destVideo), @($Audio, $destAudio))) {
  if ((Get-Item -LiteralPath $pair[0]).Length -ne (Get-Item -LiteralPath $pair[1]).Length) { throw "Copia incompleta: $($pair[1])" }
  "OK -> $($pair[1])"
}
if (-not $NoAbrir) { Start-Process explorer.exe "/select,`"$destVideo`"" }
