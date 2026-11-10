---
name: sincronizar-audio-video
description: >-
  Sincronizar con precisión de muestra el audio limpio de la DAW (FL Studio, Reaper…) con el video
  grabado en el teléfono (este repo), usando el micrófono del teléfono como referencia (GCC-PHAT).
  También ubicar una toma dentro de un backing o un stem dentro de la mezcla, y medir la deriva.
  Usar cuando pasen un video tocando + el WAV de la DAW, o pidan "sincronizá", "está desfasado",
  "¿dónde cae esta toma?".
---

# Audio de la DAW ↔ video del teléfono

Herramienta: `agents/remotion-base/tools/sync.py` (numpy + scipy).

```bash
uv run --no-project --python 3.11 --with numpy --with scipy python tools/sync.py VIDEO AUDIO_DAW [--out CARPETA] [--no-mp4]
```

Salidas junto al video: `<video>_fl.wav` (audio de la DAW corrido para empezar en t=0 del video, con
la misma duración), `<video>_sync.mp4` (vista previa sin recodificar el video) y `<video>_sync.json`
(offset, confianza, deriva). Sale con **código 2 si la sincronización es dudosa**: no seguir sin mirar.

## Por qué GCC-PHAT (Knapp & Carter, 1976)

El micrófono del teléfono escucha la misma interpretación con sala y ruido. GCC-PHAT blanquea el
espectro: pesa la coincidencia de fase, no el timbre ni el volumen. Banda 80 Hz–6 kHz.

- **Confianza** = altura del pico en desvíos estándar sobre el piso (fuera de ±50 ms). **No** usar
  "pico / segundo pico": los rebotes de la sala ponen picos a +6,5 y +13 ms y una toma buena daba 1,5×.
- Dudosa si: pico < 15, menos de 3 ventanas de 4 s o menos del 70 % de acuerdo entre ventanas.
- Medido en una toma real: offset 3,345 s, pico 49, 8/8 ventanas a < 1 ms, deriva 8,9 ppm. Control
  negativo (la DAW contra otro video): pico 6, 0 ventanas.

## Casos

- **Stem dentro de la mezcla** (guitarra sola vs. mezcla final): mismo método, da el offset del stem
  (medido: +26,9 ms, pico 590). Transcribir notas sobre el stem, nunca sobre la mezcla (la batería mete basura).
- **Toma dentro de un backing largo** (¿en qué segundo del MP3 cae este lick?): correlacionar el
  audio de la toma contra el MP3 y verificar contra los ataques conocidos.
- **Audio del teléfono que salta** (WebRTC ajusta ±30 ms): calcular el offset como la **mediana** de
  las ventanas contra la guitarra sola, no el pico global.
- **Tomas grabadas a mitad de velocidad**: sincronizar a velocidad real y recién después acelerar
  audio y video juntos (`setpts=0.5*PTS` + `atempo=2`).

## Antes de sincronizar: el video tiene que ser CFR

Las tomas de este repo ya salen a 30 fps constantes (`remux.js`). Un video del carrete del iPhone
(HEVC, VFR, rotación en metadatos) hay que pasarlo antes a H.264 CFR 30: ver `ffmpeg-cortes-y-formatos`.
Con VFR el editor conforma el video a un solo número y "algunas partes van más lentas".

## En Remotion

Los tiempos se guardan en **segundos** de la línea de tiempo del audio de la DAW; el cuadro se deriva:
`frame = round((t + offset_stem + offset_video) × fps)`. Guardar cuadros pierde 33 ms de precisión y se
invalida al re-sincronizar. El video va muteado y el audio se pone en el render (skill `render-y-qa`).
