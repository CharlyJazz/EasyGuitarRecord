---
name: nuevo-video-remotion
description: >-
  Arrancar un video nuevo en Remotion (explicativo, tocando guitarra, con voz en off) a partir de la
  base compartida agents/remotion-base, sin DaVinci ni CapCut. Usar cuando pidan "armemos un video",
  "nuevo video de Remotion", "copiá la base", o cuando haya que montar tomas, voz y música en un
  video vertical para TikTok/Reels/Shorts. Explica la estructura guion.json → escenas → marcas.
---

# Video nuevo desde la base de Remotion

La base vive en `agents/remotion-base/` (Remotion 4.0.435, React 19, alphaTab 1.8.4, versiones
EXACTAS: no subirlas sin motivo, cada salto de Remotion cambia detalles del render).

## 1. Copiar y arrancar

```bash
cp -r agents/remotion-base "../MiVideo"      # fuera de este repo: cada video es su propio proyecto
cd ../MiVideo && rm -rf node_modules out && git init
npm install                                   # postinstall copia la fuente de alphaTab a public/
```

- Cambiar `PREFIJO` en `src/estilo.ts` (ids `<PREFIJO>-<Version>-<es|en>`).
- Studio, **siempre desacoplado** (en primer plano cuelga la terminal del agente):
  - Windows: `Start-Process cmd.exe "/c npx remotion studio src/index.ts --port 3200 --no-open > %TEMP%\studio.log 2>&1" -WindowStyle Hidden`
  - Mac/Linux: `nohup npx remotion studio src/index.ts --port 3200 --no-open > /tmp/studio.log 2>&1 &`
  - Un puerto distinto por video si hay varios abiertos (3200, 3201, 3202…).

## 2. Estructura

| Archivo | Qué es |
|---|---|
| `src/guion.json` | **Fuente de verdad del tiempo.** Versiones (`corto`, `largo`…) → `{audio, audioVersion, segmentos[]}`. Cada segmento: `id` (escena), `desde`/`hasta` en segundos, `voz {es,en}`, opcional `tiempos` (inicio de cada frase) y `marcas` |
| `src/escenas/index.tsx` | Registro `ESCENAS[id] = Componente`. Cada escena recibe `EscenaProps` |
| `src/escenas/tipos.ts` | `EscenaProps`, `L(idioma, {es,en})`, `marca(marcas, clave, dur, fps, def)` |
| `src/ui/comunes.tsx` | `Fondo`, `TextoGrande`, `Etiqueta`, `Subtitulo` (frase por frase, zona segura de TikTok), `Toma` (video de `public/tomas/`), `Panel`, `useEntrada` (resorte) |
| `src/ui/Partitura.tsx` | Partitura/tab de alphaTab con cursor sincronizado (soporta swing con `swingFase`) |
| `src/estilo.ts` | Colores, fuentes, FPS 30, 1080×1920, BPM/compás del backing |
| `tools/` | voz, transcripción, cortes, mezcla, sincronía, render: ver las otras skills |

**El video se adapta a la voz, no al revés**: los `desde/hasta` y las `marcas` salen de la
transcripción con tiempos por palabra (skill `voz-y-timeline`). Una marca es "segundos desde el
inicio de la escena"; para banderas usar presencia (`!== undefined`), no el valor: un script que
reste el inicio de escena a toda marca numérica rompe las banderas.

## 3. Reglas de contenido que ya se aprendieron

- **Gancho antes de los 2 s.** El cuadro 0 es la miniatura: no puede ser negro (la primera escena no lleva fundido).
- **Nada quieto.** Animaciones en segundos fijos; si un tramo muestra lo mismo varios segundos, cortarlo o acelerarlo.
- Si el creador graba la voz con sus palabras: **subtítulos apagados** y sacar textos en pantalla que
  repitan o contradigan la voz. Los componentes que ilustran lo que dice sí van.
- **Teoría musical verificada**: grados romanos derivados de los acordes, notas con ortografía correcta
  (Cm = C-Eb-G). Un error de teoría en pantalla en un video educativo es grave. Escribir tests para los
  números que el video afirma (`node --test`).
- Las frases finales son del creador: el agente propone borradores marcados BORRADOR.
- Tomas grabadas a mitad de velocidad → acelerar audio y video juntos (×2, `atempo=2` mantiene el tono)
  y avisarlo en pantalla si el creador lo pide.

## 4. Gotchas de alphaTab (medidos)

- Contenedor con **ancho real** (con `max-content` vacío nunca dibuja → timeout de `delayRender`).
- `core.useWorkers=false`, `enableLazyLoading=false`; apagar EffectDynamics y TrackNames.
- `.at-surface { overflow: visible !important }` o la partitura se corta desde el compás ~9: **verificar
  siempre un cuadro del final**, no solo el principio.
- En template strings de TS las barras de alphaTex van dobles (`\\tempo`); con una, `\t` es un tab y no dibuja nada.
- Guitarra: `\displaytranspose 12` (positivo; −12 la baja). Anacrusa con `\ac`.
- Importar alphaTab desde Node en Windows: URL `file:///E:/...` (`pathToFileURL`), no la ruta pelada.

## 5. Receta: video de UNA toma tocando (sin voz)

El caso más común, hecho de punta a punta así (60 s, final verificado):

1. **Cortar** la toma con `agents/tools/cortar_toma.py --desde … --hasta … --buscar 2.5 --buscar-fin 0.6`
   (archivo nuevo, el original queda de backup).
2. **Copiar la base** a una carpeta propia del video, `npm install`, `PREFIJO` y puerto del Studio propios.
3. **Separar** el corte: `public/tomas/toma.mp4` sin audio (`-map 0:v -c:v copy`) y
   `public/audio/telefono.wav` (`-map 0:a`), que es la referencia para sincronizar y el audio provisorio del Studio.
4. **Una escena `toma`** a pantalla completa (`OffthreadVideo` muted, `objectFit: cover`, `startFrom` según
   el `inicioSeg` de la escena) y un solo segmento en `guion.json` de 0 a la duración del corte.
5. **Audio de la DAW**: `tools/sync.py CORTE.mp4 EXPORT.mp3 --wav public/audio/mezcla-<version>.wav --no-mp4`
   (skill `sincronizar-audio-video`). En `guion.json`, `audio` apunta a esa mezcla y se sube `audioVersion`.
6. **Fundido final** (si lo piden, p. ej. "desde 0:50 fade out video y sonido"):
   - video: una capa `<AbsoluteFill style={{background:"#000", opacity}}>` con `interpolate(frame, [desde*fps, dur-1], [0,1])`,
     con el segundo en UNA constante (`FUNDIDO_DESDE`);
   - audio: `ffmpeg -i mezcla.wav -af "afade=t=in:d=0.01,afade=t=out:st=DESDE:d=RESTO:curve=tri"` sobre la mezcla
     (el render usa la mezcla, no el audio del Studio). Si se regenera la mezcla con sync.py, **volver a aplicar
     el afade** con el mismo segundo;
   - verificar midiendo brillo medio y dB por segundo en el render (bajan juntos hasta ~0 / ~−44 dB).
7. **QA liviano** → aprobado → **final** (skill `render-y-qa`) y verificar la sincronía sobre el mp4 final
   contra el micrófono del teléfono (mediana ≈ 0 ms).

## 6. Siguiente

voz → `voz-y-timeline` · tomas y audio de la DAW → `sincronizar-audio-video` · música →
`mezcla-y-backing` · cortes/formatos → `ffmpeg-cortes-y-formatos` · render → `render-y-qa`.
