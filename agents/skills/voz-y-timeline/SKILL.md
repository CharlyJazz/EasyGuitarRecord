---
name: voz-y-timeline
description: >-
  Convertir la voz grabada (pistas de FL Studio u otra DAW) en la línea de tiempo del video:
  sumar pistas, transcribir con whisper con tiempos por PALABRA, ubicar escenas y animaciones en
  esas palabras, insertar pausas para licks, y cortar palabras sin clics. Usar cuando pasen "la voz",
  "audios hablando", "transcribí", "sincronizá el texto con lo que digo", "sacá esta palabra".
---

# Voz → texto con tiempos → guion.json

Herramientas en `agents/remotion-base/tools/`: `voz.py`, `transcribir.py`, `bandas.py`.
Todas corren con `uv run --no-project --python 3.11 --with ...` (la línea exacta está en el
docstring de cada script): no se instala nada en el sistema.

## 1. Juntar la voz

Lo más cómodo para grabar: una pista por frase en la DAW, exportadas **con el silencio adelante**
(cada WAV ya empieza en su segundo de la línea de tiempo). Entonces se **suman**, no se concatenan:

```bash
uv run ... python tools/voz.py corto "carpeta/de/pistas"     # → public/audio/voz-corto.wav, pico −1 dBFS, 48 kHz
```

Si es un solo archivo (un MP3 hablando de corrido), usarlo directo.

## 2. Transcribir con tiempos por palabra (whisper)

```bash
uv run --no-project --python 3.11 --with faster-whisper --with nvidia-cublas-cu12 \
  --with "nvidia-cudnn-cu12>=9,<10" --with soundfile --with librosa --with "numpy<2" \
  python tools/transcribir.py public/audio/voz-corto.wav datos-voz/transcripcion.json --prompt "jerga, nombres propios"
```

- Modelo `large-v3-turbo` en GPU float16: carga ~2,5 s, 30 s de audio en ~0,8 s (RTX 4070 Ti).
- `--prompt` con la jerga: sin eso whisper confunde "Re bemol" → "do bemol", "progresión" → "proyección".
  **Corregir en el texto y avisarle al creador** por si de verdad lo dijo así.
- Gotcha Windows: sin cargar las DLL de `nvidia.__path__` antes de importar → `cublas64_12.dll is not found`
  (el script ya lo hace). Sin GPU NVIDIA: `device="cpu", compute_type="int8"`.
- Pasar `PYTHONIOENCODING=utf-8` si se llama desde Node o la consola de Windows (tildes rotas).

## 3. Armar la línea de tiempo

Patrón que funcionó (un script `tools/timeline_voz.py` por video, porque cada guion es distinto):

- `ESCENAS = [(id, desde_voz, hasta_voz, {marca: segundo_voz})]`, con los segundos sacados de la
  transcripción (la palabra donde cambia el tema, la palabra que dispara cada animación).
- **Pausas insertadas** donde la música es la prueba (licks, ejemplos): `(segundo_de_voz_donde_corta, largo)`.
  Una función `T(v)` pasa de segundo de voz a segundo de video sumando las pausas anteriores.
- **Versiones** (`corto`, `sintimbre`…): cada una con sus pausas y sus tramos de voz **quitados**; el script
  escribe todas en `src/guion.json` y la mezcla se arma por versión.
- Huecos para licks: buscar silencios ≥ 1,5 s en la transcripción; si el lick tiene que caer en un acorde
  del backing, ajustarlo a la grilla (p. ej. `4,5 + 6n` s) y validarlo.
- Re-correr el script (y después la mezcla) cada vez que cambia un tiempo. Nunca editar a mano los
  segundos que el script genera.
- Para que el creador lea el guion: generar un `docs/guion.txt` solo con los párrafos.

## 4. Cortar una palabra sin ruido raro

1. Antes de cortar, **citarle al creador la frase exacta que sale y la que queda** (cortar de más ya pasó).
2. `tools/bandas.py pista.wav 58.1 58.45`: energía por bandas cada 10 ms (voz 80–1500 Hz, sibilante > 4 kHz).
   Los límites de whisper son ±50 ms: cortar en el **cierre de una oclusiva** (p/t/k: caen las dos bandas)
   o **después de la "s" final**.
3. El corte va en `tools/cortes-<version>.json` → `{"Track 13": [[fundido_desde, silencio_desde, silencio_hasta]]}`
   (fundido de ~40 ms). Los WAV originales no se tocan.
4. **Verificar**: re-transcribir el tramo (`--desde/--hasta`) y medir pico = 0 en el silencio.
