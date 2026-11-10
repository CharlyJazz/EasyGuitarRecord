---
name: render-y-qa
description: >-
  Renderizar un video de Remotion sin desfasar el audio, con el volumen que esperan las redes, y el
  circuito de revisión con el creador (renders livianos mientras se itera, final solo con su OK).
  Usar cuando pidan "renderizá", "exportá", "mandame una versión para ver", "el final", o antes de
  decir que un video está listo.
---

# Render y QA

## Render: siempre con `tools/render.mjs`, nunca con el botón del Studio

```bash
node tools/render.mjs Video-Corto-es                       # final → out/video-corto-es.mp4
node tools/render.mjs Video-Corto-es --scale=0.5 --crf=30  # QA liviano (~5 MB)
```

- Remotion 4.0.435 codifica el AAC con 2048 muestras de priming que el edit list no saltea: **el audio sale
  +42,7 ms tarde** (medido con GCC-PHAT contra el original). `render.mjs` renderiza `--muted` y pone
  `public/audio/mezcla-<version>.wav` con ffmpeg: 0 muestras de desfase medidas.
- `loudnorm=I=-14:TP=-1:LRA=11`: sin eso los videos salían a ~−20 LUFS; las redes esperan ~−14.
- Llama al CLI con `process.execPath` y sin shell: en Windows `--props='{"..."}'` por shell pierde las
  comillas, y una ruta con espacios se rompe con `shell:true`. Props complejos → archivo JSON.

## Circuito con el creador

- **Mientras se itera: nada de renders finales.** Render liviano → `out/debug-qaN.mp4` → mandárselo
  (lo mira en el teléfono). Cada final tarda y pesa, y el timing cambia a cada rato.
- El final recién con un "aprobado" explícito.
- Para revisar rápido muchos cuadros: `npx remotion bundle src/index.ts --out-dir /tmp/bundle` una vez y
  después `remotion still /tmp/bundle <id> f.png --frame=N` (mucho más rápido que re-bundlear), y unir
  varios con `hstack`. Barrer 1 cuadro por segundo buscando errores y tramos quietos.
- Mirar **siempre un cuadro del final** además del principio (bugs que solo aparecen tarde: partitura
  cortada desde el compás 9, mezcla vieja en caché).

## Antes de decir "listo"

```bash
ffprobe -v error -show_entries stream=codec_name,width,height,avg_frame_rate:format=duration -of default=nw=1 out/x.mp4
ffmpeg -i out/x.mp4 -af ebur128=peak=true -f null - 2>&1 | tail -12      # I ≈ −14 LUFS, true peak ≤ −1 dBTP
```

1080×1920, 30 fps, −14 LUFS, true peak ≤ −1, y algunos cuadros mirados. Avisar si hay un mp4 viejo con
nombre parecido en `out/`.
