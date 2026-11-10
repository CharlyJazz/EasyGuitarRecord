# agents/ — hacer los videos con agentes, sin DaVinci ni CapCut

Este repo no es solo el monitor de cámara: es el **taller completo** para grabar tocando y armar el
video final con un agente (Claude Code, Codex/ChatGPT, el que sea) escribiendo Remotion. Todo lo que
se aprendió haciendo videos reales está acá, en texto que cualquier agente puede leer.

## El flujo

```
 grabar ─────────► pasar a la PC ──► sincronizar ──► voz → texto ──► montar ──────► mezclar ─────► render + QA ──► publicar
 phone.html        transferir.html   sync.py         transcribir.py  Remotion        mezcla.py      render.mjs      textos
 (iPhone/Android)  (sin WeTransfer)  (GCC-PHAT)      (whisper GPU)   (remotion-base) (loop+ducking) (−14 LUFS)
 + DAW (FL Studio)
```

| Paso | Qué | Dónde |
|---|---|---|
| 1. Grabar | El teléfono filma (esta app), la DAW graba el audio limpio | `phone.html` / `monitor.html` |
| 2. Pasar archivos | Carpeta compartida teléfono ↔ PC por la red local | `transferir.html` |
| 3. Sincronizar | Audio de la DAW ↔ micrófono del teléfono, precisión de muestra | [sincronizar-audio-video](skills/sincronizar-audio-video/SKILL.md) |
| 4. Voz | Pistas habladas → texto con tiempos por palabra → línea de tiempo | [voz-y-timeline](skills/voz-y-timeline/SKILL.md) |
| 5. Montar | Proyecto Remotion desde la base compartida | [nuevo-video-remotion](skills/nuevo-video-remotion/SKILL.md) |
| 6. Música | Backing en loop, licks en la grilla, ducking bajo la voz | [mezcla-y-backing](skills/mezcla-y-backing/SKILL.md) |
| 7. Cortes y formatos | Smart cut sin desfase (`tools/cortar_toma.py`, busca el silencio solo), iPhone HEVC/VFR → CFR, ×2 | [ffmpeg-cortes-y-formatos](skills/ffmpeg-cortes-y-formatos/SKILL.md) |
| 8. Revisar | "OCR de video": qué pasa en cada segundo, tapar intrusos | [revisar-video](skills/revisar-video/SKILL.md) |
| 9. Render | Audio por ffmpeg (Remotion lo atrasa 42,7 ms), −14 LUFS, QA liviano | [render-y-qa](skills/render-y-qa/SKILL.md) |
| 10. Publicar | Textos para TikTok / Reels / Shorts | [textos-redes](skills/textos-redes/SKILL.md) |

Skills que ya estaban en `.claude/skills/` (Claude Code las carga solas):
- [agrupar-toma-tiktok](../.claude/skills/agrupar-toma-tiktok/SKILL.md): juntar la toma de video con la de audio de la DAW en una carpeta por fecha.
- [revision-optica-guitarra](../.claude/skills/revision-optica-guitarra/SKILL.md): leer en el video en qué cuerda y traste suena cada nota y corregir la tab.

## La base de Remotion

[`remotion-base/`](remotion-base/) es el esqueleto que comparten todos los videos: guion por
segundos, registro de escenas, helpers de UI, partitura con cursor (alphaTab) y las herramientas
de audio/render. Se **copia** fuera del repo para cada video nuevo (ver la skill
`nuevo-video-remotion`). Probado: compila, lista composiciones y renderiza.

## Requisitos

- Node 20+ (probado con 24), ffmpeg en el PATH.
- [uv](https://docs.astral.sh/uv/) para los scripts de Python: cada script dice su línea de `uv run`
  y trae sus dependencias al vuelo, sin instalar nada en el sistema.
- Para whisper rápido, una GPU NVIDIA (sin GPU anda en CPU, más lento).

## Reglas para el agente

1. **Medir antes de afirmar.** Sincronía, LUFS, cuadros: se verifican con números o con un render real,
   no "debería andar".
2. **El creador pasa las rutas.** No barrer discos buscando archivos; si falta una, preguntar.
3. **Procesos largos desacoplados** (Studio de Remotion, este server): en primer plano cuelgan la
   terminal del agente aunque el servicio esté perfecto. Verificar aparte (puerto, log).
4. **Mientras se itera, renders livianos**; el final solo con un "aprobado".
5. **Cortar solo lo pedido** y citar antes la frase exacta que sale y la que queda.
6. Las frases y decisiones artísticas son del creador; el agente propone borradores.
