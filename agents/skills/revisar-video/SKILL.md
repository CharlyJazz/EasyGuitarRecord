---
name: revisar-video
description: >-
  "OCR de video": entender qué pasa en cada segundo de una grabación (pantalla del teléfono, toma
  tocando) sin mirarla cuadro por cuadro, medir cuándo y dónde aparece algo (notificación, banner,
  dato personal) y taparlo sin costuras en Remotion. Usar cuando pidan "mirá qué pasa en el video",
  "tapá la notificación", "¿en qué segundo pasa X?", "sincronizá los textos con el video".
---

# Revisar un video ("OCR de video")

Un minuto a 30 fps son 1800 cuadros. Se combinan: **ver muestras** (hojas de contactos leídas como
imagen), **medir con código** (píxeles crudos con ffmpeg comparados en Python) y **verificar
renderizando** cuadros sueltos del resultado.

1. **Sondear y preparar**: si es VFR o HEVC, pasarlo a H.264 CFR 30 (`ffmpeg-cortes-y-formatos`) y medir
   todo sobre ESE archivo.
2. **Panorama**: hoja de contactos cada 2–3 s → línea de tiempo gruesa (inicio, momentos clave,
   intrusos: notificaciones, banners, nombres o mails reales).
3. **Cuándo**: comparar una región contra un cuadro limpio a 10 fps
   (`ffmpeg -ss A -to B -i x.mp4 -vf "fps=10,crop=w:h:x:y" -f rawvideo -pix_fmt rgb24 -` + numpy) e imprimir
   cuándo cambia. Medir también **justo debajo** del intruso: si ahí cambia, hay un modal y el parche no puede ir.
4. **Dónde**: diferencia fila por fila entre un cuadro con el intruso y uno limpio → rectángulo exacto.
5. **Tapar en Remotion, desde el propio video**: congelar un cuadro limpio del mismo video y recortarlo
   sobre el rectángulo, solo en el tramo en que la pantalla de abajo es igual al cuadro limpio. Nunca
   colores ni recortes de ffmpeg (YUV→RGB distinto). Notificaciones de iOS: el parche arranca en y = 0
   (entran deslizándose sobre la barra de estado; si no, destello de 2–3 cuadros).
6. **Verificar**: `remotion still` en la entrada y salida de cada parche, cuadro por cuadro, y unirlos con
   `ffmpeg -i a.png -i b.png -filter_complex hstack=inputs=2 grilla.png`. Medir colores en el still (como los
   dibuja Chrome), no en el fuente.

## Reloj

El creador habla en el reloj del **Studio** (la composición); si se recortó el principio del fuente
(`SRC_START`), Studio = fuente − SRC_START. Cuando se hable de tiempos, darle una tabla Studio ↔ fuente.

No se escucha el audio: la sincronía que se verifica así es visual. Decirlo.

## Para grabar la próxima sin intrusos

Un modo Enfoque/No molestar que se active solo al abrir la app que se graba, con "notificaciones
urgentes" apagadas (si no, Gmail/Slack lo atraviesan).
