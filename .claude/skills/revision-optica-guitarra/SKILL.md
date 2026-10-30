---
name: revision-optica-guitarra
description: >-
  Revisar ópticamente, cuadro por cuadro, un video de Carlos tocando guitarra para la parte
  híbrida del editor (GuitarVideoEditorRemotion + pestaña Editor del camera mirror): ver dónde
  está la mano en el mástil cuando suena cada nota de la cinta, decidir cuerda/traste, corregir
  la tab por la API y verificar el render (partitura, cursor, sincronía, encuadre). Usar cuando
  pida "revisá la cinta de <alias>", "mirá el video y corregí la tab", "¿en qué traste toco
  esto?", "verificá la digitación", "revisá el render/la partitura del video", o cualquier
  revisión visual de una sesión del editor. Triggers: revisión óptica, frame por frame, cuadro
  por cuadro, digitación, cuerda y traste, posición de la mano, mástil, cinta, sesión, tab,
  partitura en el video, cursor.
---

# Revisión óptica de un video de guitarra

La cinta (Basic Pitch) da **qué nota** suena y **cuándo**. El audio no puede decir **dónde** se
tocó: la misma altura existe en 3-5 lugares del mástil. El video sí, y esa es la parte que hago
yo mirando cuadros. Contexto de la arquitectura: memoria `guitar-video-editor-remotion`.

**Regla de oro: no se mira el video al azar.** Un minuto son 1800 cuadros. Se miran los cuadros
**de los ataques de la cinta**, que ya traen el frame calculado por el servidor:
`frame = round((t_s + offset_video_s) × fps)`.

## 0. Antes de mirar nada: orientación (ME EQUIVOQUÉ ACÁ)

En la primera toma dije "la mano está arriba en el mástil" y era al revés. Por eso, en cada
video nuevo, antes de leer un solo traste:

1. Sacá un cuadro a resolución completa: `ffmpeg -ss 10 -i video.mp4 -frames:v 1 cuadro.png`.
2. Ubicá el **clavijero** (en la PRS de Carlos se ve el logo "2AS" en la pala) y la **cejuela**.
   Los trastes graves (1, 2, 3...) están del lado del clavijero.
   - En las tomas horizontales del iPhone (rotación −180 aplicada), **el clavijero queda a la
     DERECHA**: los trastes suben de derecha a izquierda, hacia el cuerpo.
   - No lo des por sabido: cambia con cada montaje de cámara.
3. Calibrá contando **alambres de traste desde la cejuela**. Los inlays (pájaros en la PRS) son
   una referencia, no la verdad: confirmá en qué trastes están contando los alambres.
   Referencia física: el traste 12 está en la mitad entre la cejuela y el puente; la distancia
   del traste n a la cejuela es `L · (1 − 2^(−n/12))`, así que los trastes se achican hacia el
   cuerpo.
4. Anotá el resultado (lado del clavijero, a qué x del cuadro cae cada inlay) antes de seguir.

## 1. La hoja de contactos por ataque

```
python .claude/skills/revision-optica-guitarra/scripts/hoja_notas.py <alias> --desde 6.2 --hasta 9.0 --crop 800:420:700:640 --max 18 --out hoja.png
```

- Un cuadro por **ataque** de la cinta revisada (`--version cruda` para la cruda): las notas a
  menos de 60 ms son el mismo ataque (un acorde es una foto, no seis). Arriba
  `#n  tiempo_video  frame  notas`; con una sola nota, abajo **las posiciones candidatas**
  (`traste.cuerda`): solo hay que elegir la que cae en la ventana de la mano. En un acorde las
  candidatas no entran: ahí se usa `formas.py` (sección 2b). Lee la cinta del camera mirror
  (`https://localhost:3000`, tiene que estar corriendo). `#n` es el índice dentro de la hoja,
  no de la cinta: sumarle el índice de la primera nota del rango.
- `--desde/--hasta` van en **segundos de la mezcla** (los de la cinta), no del video.
- **Tokens: una imagen cuesta por área** (≈ ancho × alto / 750). El gris no ahorra nada. Lo que
  ahorra: recortar solo el mástil (nunca la cara ni la mano que pulsa) y celdas de 520 px
  (`--ancho`). 18 notas por hoja ≈ 1572×1500 ≈ 3000 tokens; la toma entera (110 notas) salió en
  ~8 hojas. `--saltear-unicas` saca las notas con una sola posición posible.
- **Dos niveles de recorte.** El ancho (`1360:620:560:460`, trastes 0-17) sirve para ubicar la
  región; para leer trastes, un recorte de la zona donde está la mano al doble de resolución por
  el mismo costo. En e02334b5 (1920×1080, clavijero a la derecha):
  - trastes 3-13: `800:420:700:640`
  - trastes 0-6: `920:440:1000:600`
  - trastes 9-19 (el final, con la guitarra más abajo): `1100:440:520:640`
- **La guitarra se mueve** (sube y baja ~300 px en la toma): si el mástil sale del recorte, no
  adivinar; correr el recorte (un cuadro completo chico con `drawgrid` para ubicarlo) y repetir.
- **Recalibrar en cada recorte nuevo** con los pájaros (el del 12 es el más grande) o el logo del
  clavijero. En la región aguda los alambres están juntos: si hay duda, un recorte a resolución
  nativa (sin escalar) de 1-2 cuadros para contar alambres.
- `--antes 2`: el ataque es el momento en que la mano derecha pulsa (sale movida), pero el dedo
  de la izquierda ya estaba apoyado. Si el cuadro del ataque está borroso, mirá 1-3 cuadros antes.
- **3 columnas como máximo** (`--cols 3`, default). Con 4 la imagen pasa de 2000 px y el visor la
  achica: se pierden justo los trastes.
- **Tramos de 8-12 notas.** Una hoja con 40 cuadros chiquitos no sirve para leer trastes.

## 2. Qué se puede leer y qué no

Lo que se ve bien en un video de teléfono: **en qué zona del mástil está la mano** (una ventana
de 4-5 trastes: dedo índice al meñique) y si la mano se movió entre dos notas.

Lo que casi nunca se ve: **qué cuerda** pisa cada dedo. Las cuerdas son finas, el mástil está en
ángulo y la mano tapa. Una excepción útil: en las tomas de Carlos **las cuerdas graves quedan
arriba** del cuadro (el pulgar envuelve por ahí); un dedo estirado hasta el borde de arriba está en
la 5ª o 6ª cuerda. Así se separa una A2 en 5.6 de la A al aire.

**El índice es el dedo más cercano al clavijero** (con el clavijero a la derecha, el de más a la
derecha): marca el traste más bajo de la ventana; el meñique, el más alto (índice + 3, + 4
estirando).

**Y no hace falta verlo.** La técnica es cruzar los dos datos:

> altura de la nota (cinta) + ventana de la mano (video) → casi siempre una sola posición.

La misma altura se repite cada ~5 trastes entre cuerdas vecinas, así que en una ventana de 4-5
trastes suele caber **una sola** opción. Ejemplo: G#4 (MIDI 68) puede ser 4.1, 9.2, 13.3 o 18.4
(traste.cuerda, cuerda 1 = mi aguda). Con la mano entre los trastes 7 y 10, es **9.2**.

- Si en la ventana cae **una** opción: es esa. Anotala.
- Si caen **dos** (pasa en la frontera sol-si, que está a 4 trastes): mirá la nota anterior y la
  siguiente (la mano no salta sin motivo), o dejala sin fijar.
- Si no se ve la mano (tapada, borrosa, fuera de cuadro) o está en pleno traslado: **no se fija
  nada**. Lo decide el Viterbi de `buildAlphaTab` por tocabilidad, ahora con las vecinas fijas.
- Al aire contra pisada (E4 en 0.1 o 5.2): la ventana no lo resuelve; fijar la pisada solo si se
  ve un dedo en esa cuerda/zona, y marcarla "confianza media".

**Por qué vale la pena:** en e02334b5 el video cambió 40 de 110 posiciones del Viterbi, todas
de 4 trastes o más (otra posición de mano). Ajustar los costos del Viterbi no lo arregla: el
castigo arriba del 12 resultó irrelevante, y lo que mejoraba esa toma no aguantó validación
cruzada entre mitades (`tests/digitacion.mjs`). La posición la da el video.

## 2b. Acordes: `formas.py` (video + audio)

En un acorde no se ve qué cuerda pisa cada dedo, y Basic Pitch pierde las voces del medio y las
octavas (en acordes sintéticos encuentra el 77 %). Lo que sí se ve es **dónde está la mano**:

```
cd "E:/MY MUSIC SOFTWARE/GuitarVideoEditorRemotion/tools/transcribir"
uv run python formas.py "<fuentes/<id>/guitarra.wav>" --t <s en ESE archivo> --trastes 5-8
```

- `--trastes`: la ventana vista en el video (índice → índice + 3; cejilla en el 1 → `1-4`). Las
  cuerdas al aire siempre entran. El script la abre 1 traste a cada lado (`--margen 1`, default):
  sin margen, leer el índice un traste más arriba de lo real daba 0/53 aciertos con la misma
  confianza. No pongas `--margen 0`; ante la duda entre dos trastes, poné el más bajo. `--t` es en el archivo de audio que le pasás: con la guitarra
  sola, `t_s de la cinta - offset_guitarra_s`.
- Devuelve las 5 combinaciones de alturas más probables con nombre de acorde y las digitaciones
  posibles (`x13331`, cuerda 6 a 1). Con las mismas alturas el audio no distingue digitaciones:
  elegí con el video (¿cejilla? ¿qué cuerdas rasguea la mano derecha?).
- Puntaje = evidencia de la red de Basic Pitch ANTES de su umbral (calibrada: frontera en q ≈ 0,15)
  + prior de formas (CAGED, acorde con nombre, sin cuerdas mudas en el medio).
- Medido con acordes sintéticos (Karplus-Strong, `sintetico.py` + `medir_formas.py`): ver el
  README del editor para los números. **Con jazz (drop 2, shells con cuerdas mudas) es menos
  confiable**: tiende a agregar la quinta o la octava. Ahí la 2ª o 3ª opción suele ser la buena;
  mirá si en el video hay cuerdas apagadas.
- Escribí el acorde en la cinta (PUT) con una nota por altura y su `cuerda`/`traste`; las notas
  que agregues (las que Basic Pitch no vio) llevan `amp` de las vecinas y `nota: "formas.py +
  video frame N"`.
- **Chops / notas muertas:** `{"t_s":..., "fin_s":..., "muerta": true, "cuerda": 4}` (sin traste,
  sin midi). Se escriben `x.4`. Se ven en el video (mano izquierda apoyada sin pisar) y en el
  audio como golpe sin altura (Basic Pitch no da nada o da basura).

## 2c. Ritmo: tresillos y swing (automático, pero revisalo)

`buildAlphaTab` cuantiza con un HMM métrico (tools/ritmo.mjs): cada negra es binaria, de tresillos
o de seisillos, y detecta swing (se escribe recto con "Swing"). Lo que conviene mirar en la
partitura:
- Un tresillo suelto entre semicorcheas a tempo rápido es ambiguo (a 140 BPM, ~8 % mal leídos con
  ruido de 15 ms). Si Carlos dice "eso era un tresillo", es eso.
- Swing: `PATCH {"swing": 0.5}` lo apaga (sale en tresillos), `{"swing": 0.66}` lo fuerza,
  `{"swing": null}` lo vuelve a detectar. El cursor del video sigue el swing.
- Fusas (más rápido que el seisillo) todavía no se escriben bien: salen corridas a la grilla.

## 3. Escribir lo que viste (por la API)

```
GET https://localhost:3000/api/editor/sesiones/<uuid>/notas            # cinta revisada, con frame
PUT https://localhost:3000/api/editor/sesiones/<uuid>/notas            # {notas:[...]} -> rehace la partitura
```

- El **PUT reemplaza TODA la cinta revisada**: siempre GET completo, modificar solo las notas
  vistas, PUT de la lista completa. Nunca un PUT con solo las notas cambiadas.
- En cada nota fijada: `cuerda`, `traste` y `nota: "visto en frame 317: mano en trastes 7-10"`.
- El servidor rechaza (400) una posición que no da la altura (`2.1` para un G#4), cuerda fuera de
  1-6, traste fuera de 0-22, cuerda sin traste o una muerta sin cuerda: validar con `AF[cuerda-1] + traste == midi`
  antes del PUT (AF = 64 59 55 50 45 40). La respuesta trae `avisos` de buildAlphaTab (acordes
  imposibles, notas que no entran): leerlos.
  `buildAlphaTab` respeta cualquier nota que traiga cuerda/traste y usa el Viterbi para el resto.
- Lo que no se tocó queda como estaba (`cuerda: null`).
- Certificado autofirmado: `curl -k`, o en Python `ssl._create_unverified_context()`.
- La cinta **cruda** no se toca nunca.

## 4. Verificar el render

1. **Un cuadro de Remotion** en el momento que importa:
   `npx remotion still src/index.ts Sesion-<uuid> out/x.png --frame=N` (desde el repo del editor).
   Recortá la franja de la partitura para leerla: `crop=1080:820:0:1100` en la salida vertical
   con fuente horizontal. Borrá los `out/*.png` de prueba al terminar.
2. **Cursor:** calculá dónde tiene que estar y compará con el cuadro.
   `negras = (frame/fps − offset_video_s − inicio_compas_s) × bpm/60`; compás = `negras // 4 + 1`.
   Hacé al menos tres puntos (principio, medio, final): un error de BPM se nota recién al final.
3. **Sincronía del audio** del MP4 final contra el video ORIGINAL del teléfono. Tiene que dar
   0 muestras:
   `cd tools/sync && uv run python sync.py <original.mov> out/<uuid>.mp4 --out <tmp> --no-mp4`.
   Si da ~42,7 ms, se renderizó con el botón del Studio en vez de `tools/render.mjs`.
   Mirá también **un cuadro del final del video**: hasta el arreglo del 2026-10-29 la partitura
   desaparecía desde el compás 9 (la `.at-surface` de alphaTab recortaba con un ancho sin escalar)
   y los chequeos a 4/12/20 s no lo vieron.
4. **Encuadre:** en fuente horizontal, revisá que la mano que pisa no quede cortada en el borde.
   Se ajusta con `encuadre_x` (slider en editor.html, o `PATCH {encuadre_x}`).

## 5. Cómo reportarle a Carlos

- Separar **visto** de **inferido**: "en el frame 317 la mano está en 7-10 (visto) → la F3 va en
  la 4ª cuerda traste 3... (inferido de altura + ventana)".
- Una hoja de contactos gruesa (un cuadro cada 2 s) **no verifica notas**: sirve para la posición
  general. Decir cuál de las dos se hizo.
- Si te equivocaste leyendo el mástil, decirlo y corregirlo, no taparlo.
- Los dobles ataques dudosos que dejó `revisar.py` los confirma él de oído: listarlos con su tiempo.

## Gotchas de esta PC

- `ffmpeg drawtext` **sin `fontfile`** se cae con "Fontconfig error" y segfault. El script ya pasa
  `C\:/Windows/Fonts/arial.ttf` (el `:` de la unidad escapado para el filtro).
- No barrer discos buscando el video: Carlos pasa el path, y si falta se le pregunta. Los videos del
  teléfono suelen estar en `E:\MY MUSIC SOFTWARE\iphone-monitor\transferencias\`, y el de la sesión
  ya está en `public/sesiones/<uuid>/video.mp4` del editor.
- Las imágenes de más de ~2000 px se ven achicadas: recortar y armar hojas angostas.

## Para automatizarlo más adelante

Literatura con nombre: Paleari et al. 2008 (Eurecom, audio + visión, 89 % de notas resueltas con
grilla del mástil + detección de mano) y GuiFiR 2026 (grilla de 126 landmarks del mástil + pose de
la mano, supervisado con tabs generadas desde el audio). Es el paso "video → cuerda/traste" que
sigue en PLAN. Esta skill es la versión manual del mismo cruce.
