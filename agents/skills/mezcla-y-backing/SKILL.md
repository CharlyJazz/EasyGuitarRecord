---
name: mezcla-y-backing
description: >-
  Armar el audio final del video: backing track en loop para dar espacio, licks/ejemplos insertados
  en su segundo (en la grilla del compás), voz con ducking, fundido y volumen para redes. Incluye
  bajar un backing de YouTube a MP3. Usar cuando pidan "poné el backing de fondo", "loopealo",
  "meté el lick acá", "la música tapa la voz", "bajá este backing", o haya que regenerar la mezcla.
---

# Mezcla: fondo + inserciones + voz

Herramientas en `agents/remotion-base/tools/`: `mezcla.py` y `youtube-mp3.sh`.

## Bajar un backing de YouTube

```bash
DESCARGAS="ruta/destino" bash tools/youtube-mp3.sh "https://www.youtube.com/watch?v=..."
```

`yt-dlp` y `ffmpeg` llegan con `uvx` (no se instala nada). Descarga por id y convierte a MP3 320k.
Gotcha: el ffmpeg de imageio-ffmpeg falla si el **nombre de salida** tiene `[ ] , '` (muchos títulos
de backings traen `[Em, 110 BPM]`): el script ya los saca.

## Armar la mezcla

```bash
uv run --no-project --python 3.11 --with librosa --with soundfile --with "numpy<2" python tools/mezcla.py corto \
  --fondo "backing.mp3" --fondo-desde 30 --fondo-largo 72 \
  --insertar 12.5 public/audio/lick1.wav --insertar 24.5 public/audio/lick2.wav
```

→ `public/audio/mezcla-corto.wav`, con la duración que dice `src/guion.json["corto"]`.

- **Fondo en loop**: elegir un tramo limpio del backing (`--fondo-desde`, `--fondo-largo`) que cierre en
  un compás entero, para que el loop no salte. Evitar tramos donde el backing cambia (un bajo que baja de
  volumen al final, un break). Si el backing se re-exporta, verificar que arranque y acordes sigan iguales.
- **Inserciones** (licks, ejemplos sonoros): entran con fundido de 40 ms. Si tienen que caer en un acorde,
  ubicarlas en la grilla: `t = inicio_backing + n × SEG_COMPAS` (`src/estilo.ts`). Medir con GCC-PHAT
  dónde cae cada toma dentro del MP3 en vez de suponerlo.
- **Licks sin cortes feos**: cortar después de la última nota de la frase y antes del lick siguiente;
  ningún hueco sin sonido cuando la pantalla muestra una escala.
- **Ducking** (si existe `public/audio/voz-<version>.wav`): envolvente RMS de 20 ms, ataque 60 ms /
  suelta 400 ms; la música baja 9 dB bajo la voz y la voz queda ~8 dB arriba. Ajustable con
  `--baja-db` / `--voz-sobre-db`.
- Fundido final 1,5 s. El loudnorm a −14 LUFS lo hace `render.mjs`, no la mezcla.
- Cambiar la velocidad sin cambiar el tono: `ffmpeg -i in.wav -af atempo=2 out.wav`.

## En el Studio

`guion.json[version].audio = "audio/mezcla-corto.wav"` para escucharla en el Studio. Subir
`audioVersion` cada vez que se regenera: el Studio cachea por nombre y ya pasó que reprodujera una
mezcla vieja (silencio donde ya había música).

Orden si cambia el guion: `timeline_voz.py` → `mezcla.py` → render.
