---
name: ffmpeg-cortes-y-formatos
description: >-
  Recetas de ffmpeg verificadas para videos de guitarra: cortar sin perder calidad ni desfasar el
  audio (smart cut), pasar videos del iPhone (HEVC, VFR, rotación) a H.264 30 fps constantes,
  remux de fMP4, acelerar ×2, sacar cuadros y hojas de contacto. Usar cuando pidan "cortá desde
  el segundo X", "sin perder calidad", "el video va a saltos", "DaVinci/Remotion no lo abre",
  "el audio quedó adelantado", o antes de meter un video del carrete en Remotion.
---

# ffmpeg: cortes y formatos

## Video del carrete del iPhone → listo para editar

Trae HEVC, frame rate **variable** y rotación en metadatos (−180 es común). Chrome/Remotion en
Windows muchas veces no reproduce HEVC, y el VFR desincroniza.

```bash
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames:stream_side_data=rotation -of default=nw=1 IN.mov
ffmpeg -i IN.mov -fps_mode cfr -r 30 -c:v h264_nvenc -cq 18 -c:a aac -b:a 320k -movflags +faststart OUT.mp4
#   sin NVIDIA: -c:v libx264 -crf 18 -preset medium
```

- `r_frame_rate` ≠ `avg_frame_rate` → VFR. **No creerle a `r_frame_rate`**: se deriva del hueco más corto.
- `-fps_mode cfr` **duplica cuadros en los huecos** en vez de comprimir el tiempo: conserva la duración real,
  que es lo único que sirve para sincronizar. ffmpeg aplica la rotación al recodificar.
- Para no perder calidad al pasar archivos del iPhone: *Ajustes → Fotos → Transferir a Mac o PC →
  Conservar originales*.

## Tomas de este repo

`remux.js` ya las deja en MP4 normal (no fMP4), H.264 CFR 30 y audio a −14 LUFS. Si alguna vez un
editor dice "archivo corrupto": es el envoltorio fMP4 de `MediaRecorder` (`moov` vacío, `duration=0`);
`ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4` lo arregla sin recodificar.

## Cortar sin perder calidad (smart cut): `agents/tools/cortar_toma.py`

Pedido típico: "cortá desde 4:48, creo que hay un silencito antes del arpegio, hasta 5:50, en un video
nuevo así queda el original de backup". Un solo comando:

```bash
uv run --no-project --python 3.11 --with numpy python -I agents/tools/cortar_toma.py grabaciones/toma-X.mp4 \
  --desde 4:48 --hasta 5:50 --buscar 2.5 --buscar-fin 0.6
#  --solo-buscar   para ver primero los silencios candidatos sin cortar
```

- `--buscar N`: busca el valle de energía más profundo (~100 ms) en ±N s y corta 100 ms antes del ataque
  siguiente; `--buscar-fin` corta justo antes de la nota siguiente (40 ms). Imprime los candidatos, porque
  "el silencio antes del arpegio" puede ser cualquiera de dos: decirle al creador cuál se eligió y cuál era
  la otra opción.
- El original no se toca; sale `<toma> - 4.49-5.50.mp4` al lado.
- Se verifica solo: cuadros contados, PSNR del primer cuadro (recodificado, ~58 dB) y de uno de la cola
  (copiado, idéntico = 99), audio contra el original (< 1 ms) y decodificación sin errores.
  Si algo dice `¡REVISAR!`, no entregar.

Dos trampas que costaron la primera versión del script (ya resueltas adentro):
- `dump_extra` sobre MP4 mete SPS/PPS en formato Annex B dentro de paquetes AVCC → "Invalid NAL unit size".
  Las partes van en **MPEG-TS** (cada keyframe lleva su SPS/PPS).
- El demuxer concat toma la duración de la cabeza hasta su último pts (**un cuadro menos**) → la cola
  queda corrida un cuadro: pts repetido y "non monotonically increasing dts". Se pasa `duration` explícita.

Receta manual (lo que hace el script):

1. **Video**: recodificar solo `[corte, próximo keyframe)` (`h264_nvenc -profile:v main -level 4.1 -cq 12`)
   a `.ts`; la cola desde el keyframe con `-c copy` a `.ts`; unir con `concat:a.ts|b.ts`.
2. **Audio**: `ffmpeg -i SRC -ss CORTE -c:a copy` — el **`-ss` DESPUÉS del `-i`**. Con `-ss` antes y copy,
   el audio arrastra los segundos desde el keyframe anterior: ffprobe los descarta (los chequeos dan 0 ms)
   pero los reproductores y editores los tocan → **audio adelantado**.
3. Compensar el bloque AAC con `-itsoffset` (pts del primer paquete ≥ corte − corte; 3–14 ms).
4. **Verificar** contando paquetes reales (paquetes de audio × 1024 / 48000 ≈ duración), no con `duration`;
   correlación del audio contra el original < 1 ms; `framemd5` de la cola idéntico; decodificación sin errores.

Reemplazar el archivo si lo piden (sin dejar clones); si piden backup, a `backup originales/` en la misma carpeta.

## Velocidad ×2 (tomas grabadas lento)

```bash
ffmpeg -i in.mp4 -filter_complex "[0:v]setpts=0.5*PTS[v];[0:a]atempo=2[a]" -map "[v]" -map "[a]" out.mp4
```

## Mirar un video sin verlo entero

- Hoja de contactos (1 cuadro cada 3 s): `ffmpeg -i x.mp4 -vf "fps=1/3,scale=216:-1,tile=6x5" hoja.png`, y leerla como imagen.
- Un tramo fino: `ffmpeg -ss 44 -t 10 -i x.mp4 -vf "fps=2,scale=180:-1,tile=10x2" tramo.png`.
- Cuadros exactos: `-vf "select='between(n,120,130)',tile=11x1"`.
- Gotchas: `drawtext` puede hacer segfault en builds sin fontconfig (no rotular con ffmpeg); el ffmpeg
  de imageio-ffmpeg no trae `ffprobe`.

## Colores

Nunca tapar algo con un color o un recorte sacado con ffmpeg y pegado en Chrome/Remotion: convierten
YUV→RGB distinto y queda "de otro azul" (se nota con un cuentagotas). Tapar con un cuadro limpio del
**mismo video** dentro de Remotion. Detalle en `revisar-video`.
