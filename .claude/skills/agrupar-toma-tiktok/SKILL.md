---
name: agrupar-toma-tiktok
description: >-
  Juntar una toma de video del iphone-monitor (camera mirror) con su toma de
  audio de FL Studio, copiándolas a D:\Tomas - TIKTOKIG\<fecha humana>\ con el
  mismo nombre por hora. Usar cuando Carlos pase un video
  (https://localhost:3000/grabaciones/toma-....mp4 o un path) y una toma de FL
  Studio (untitled_....wav) y diga "agrupa", "junta la toma con el video",
  "tomas de TikTok/IG". Triggers: agrupar toma, toma fl studio, video y audio,
  Tomas - TIKTOKIG.
---

# Agrupar toma de FL Studio + video del monitor

**No buscar archivos.** Carlos siempre pasa los dos paths. Nunca hacer scans
recursivos de disco; si falta un path (o solo da el nombre sin carpeta),
preguntarlo.

- Video: URL `https://localhost:3000/grabaciones/X` = `<repo iphone-monitor>\grabaciones\X` (el script la traduce solo).
- Audio: la toma de FL Studio (`.wav`), path completo.
- Etiqueta opcional: si da un texto suelto ("test primera prueba"), va como etiqueta.

## Ejecutar (con la tool PowerShell, no Bash: escribe en D:)

```powershell
& "<repo iphone-monitor>\.claude\skills\agrupar-toma-tiktok\agrupar.ps1" -Video "<url o path>" -Audio "<path .wav>" -Etiqueta "<texto opcional>"
```

Resultado:

```
D:\Tomas - TIKTOKIG\17 de octubre de 2026\
    17h43 - test primera prueba - video.mp4
    17h43 - test primera prueba - audio.wav
```

- Carpeta = fecha humana en español; hora = la del nombre de la toma de video
  (`toma-YYYY-MM-DD_HH-MM-SS`), así video y audio comparten nombre y quedan juntos.
- **Copia**, no mueve. Verifica tamaños. Si el nombre ya existe numera `(2)`, nunca pisa.
- Abre el Explorador con el video seleccionado (`-NoAbrir` para no hacerlo).
- Confirmar las líneas `OK ->` antes de decir "listo".
