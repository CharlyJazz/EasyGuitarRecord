#!/usr/bin/env bash
# Descarga el audio de un video de YouTube (un backing track) y lo deja como MP3 320k.
# Uso:  bash youtube-mp3.sh "<URL de YouTube>"  [--keep-webm]  [--no-open]
# Destino: $DESCARGAS si esta definida; si no, ~/Downloads.
# Requiere: uv (yt-dlp y ffmpeg se obtienen al vuelo con uvx; no se instala nada).
#
# Estrategia robusta (Git Bash + Windows):
#  - Se descarga a un nombre por ID (%(id)s) => ASCII y determinista, sin problemas
#    de codepage con caracteres unicode en los titulos.
#  - El MP3 final se nombra con el titulo saneado (--restrict-filenames) y los
#    guiones bajos se pasan a espacios.
set -euo pipefail

URL="${1:-}"
if [[ -z "$URL" ]]; then
  echo "ERROR: falta la URL de YouTube." >&2
  echo "Uso: bash youtube-mp3.sh \"<URL>\" [--keep-webm] [--no-open]" >&2
  exit 1
fi
shift || true

KEEP_WEBM=0
OPEN=1
for arg in "$@"; do
  case "$arg" in
    --keep-webm) KEEP_WEBM=1 ;;
    --no-open)   OPEN=0 ;;
  esac
done

DEST="${DESCARGAS:-$HOME/Downloads}"
mkdir -p "$DEST"
export PATH="$PATH:$HOME/.local/bin"

echo ">> Obteniendo ffmpeg (imageio-ffmpeg, cacheado por uv)..."
FFMPEG="$(uvx --from imageio-ffmpeg python -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())" | tr -d '\r')"

echo ">> Leyendo metadatos (id + titulo saneado)..."
# Dos lineas: 1) id (ASCII)   2) titulo saneado a ASCII por --restrict-filenames
META="$(uvx yt-dlp --skip-download --restrict-filenames \
        --print "%(id)s" --print "%(title)s" "$URL" 2>/dev/null)"
ID="$(printf '%s\n' "$META"    | sed -n '1p' | tr -d '\r\n ')"
TITLE="$(printf '%s\n' "$META" | sed -n '2p' | tr -d '\r\n')"
if [[ -z "$ID" ]]; then
  echo "ERROR: no se pudo obtener el id del video." >&2
  exit 1
fi
# Nombre bonito: guiones bajos -> espacios, quitar caracteres ILEGALES en
# nombres de archivo de Windows \ / : * ? " < > | (los reemplaza por '-'), y
# tambien quitar [ ] , y ' : el build de ffmpeg (imageio-ffmpeg, essentials-www.gyan.dev)
# falla con "Error opening output ... No such file or directory" si el nombre
# de salida tiene corchetes, comas o apostrofes (probado: mismo path sin ellos funciona).
PRETTY="$(printf '%s' "$TITLE" \
  | tr '_' ' ' \
  | sed -E "s#[\\\\/:*?\"<>|]# - #g; s/[][,']//g; s/[[:space:]]+/ /g; s/^ +| +\$//g")"
[[ -z "$PRETTY" ]] && PRETTY="$ID"
echo ">> id=$ID  titulo=\"$PRETTY\""

echo ">> Descargando mejor audio a $DEST ..."
uvx yt-dlp -f bestaudio --force-overwrites -o "$DEST/${ID}.%(ext)s" "$URL"

# Localizar el archivo descargado por id (extension desconocida: webm/m4a/...)
WEBM="$(ls "$DEST/${ID}".* 2>/dev/null | grep -vi '\.mp3$' | head -n1)"
if [[ -z "$WEBM" || ! -f "$WEBM" ]]; then
  echo "ERROR: no se encontro el archivo descargado ($DEST/${ID}.*)." >&2
  exit 1
fi
echo ">> Descargado: $WEBM"

MP3="$DEST/${PRETTY}.mp3"
echo ">> Convirtiendo a MP3 320k -> $MP3"
# stdout a null; se dejan ver los errores de ffmpeg (stderr) por si algo falla.
"$FFMPEG" -y -i "$WEBM" -vn -c:a libmp3lame -b:a 320k "$MP3" >/dev/null
echo ">> MP3 listo."

if [[ "$KEEP_WEBM" -eq 0 ]]; then
  rm -f "$WEBM"
  echo ">> Eliminado el archivo de audio original (temporal)."
fi

# Git Bash: /d/Carpeta/Foo.mp3 pasa a la ruta de Windows D:/Carpeta/Foo.mp3 con barras invertidas
WINPATH="$(printf '%s' "$MP3" | sed -E 's#^/([a-zA-Z])/#\U\1:/#' | tr '/' '\\')"
echo "WINPATH=$WINPATH"
if [[ "$OPEN" -eq 1 ]]; then
  if command -v powershell.exe >/dev/null; then powershell.exe -NoProfile -Command "explorer.exe '/select,$WINPATH'" || true; elif command -v open >/dev/null; then open -R "$MP3" || true; fi
fi

echo "OK -> $WINPATH"
