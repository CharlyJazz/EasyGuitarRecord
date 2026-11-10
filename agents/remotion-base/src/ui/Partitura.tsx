import * as alphaTab from "@coderline/alphatab";
import React, { useEffect, useRef, useState } from "react";
import { continueRender, delayRender, staticFile } from "remotion";

// Pentagrama de alphaTab en una fila, con un cursor que sigue lo que suena.
// alphaTab 1.8.4 exacto. Gotchas medidos (si se olvida uno, no dibuja nada o se corta):
// sin workers, sin lazy loading, ancho real del contenedor, .at-surface con overflow visible).
//
// Sincronía: alphaTab cuenta en ticks (negra = 960) desde el primer compás escrito (acá la
// anacrusa), que empieza en `tick0Seg` del video. Con swing, la corchea del contratiempo suena
// tarde: el cursor deforma el tiempo (`swingFase` = fracción del tiempo donde cae la 2da corchea).

const TICKS_POR_NEGRA = 960;
type Tiempo = { tick: number; x: number };

/** escala: tamaño propio si la melodía es más ancha que la caja (pisa la escala de quien la usa) */
export type Melodia = { alphatex: string; bpm: number; swingFase?: number; escala?: number };

export const Partitura: React.FC<{
  melodia: Melodia;
  /** segundo del video en que empieza el tick 0 */
  tick0Seg: number;
  /** segundo del video ahora */
  ahoraSeg: number;
  ancho: number;
  alto: number;
  escala?: number;
  fondo?: string;
  /** papel: fondo blanco griseado y tinta negra */
  claro?: boolean;
  /** espacio arriba (px) para que entren los acordes y el "Swing" */
  paddingTop?: number;
  /** si la partitura es más ancha que la caja, se corre para que el cursor quede en esta fracción del ancho */
  seguir?: number;
}> = ({ melodia, tick0Seg, ahoraSeg, ancho, alto, escala = 1.6, fondo, claro = false, paddingTop = 36, seguir }) => {
  const contenedor = useRef<HTMLDivElement>(null);
  const [tiempos, setTiempos] = useState<Tiempo[] | null>(null);
  const [handle] = useState(() => delayRender("alphaTab dibujando la partitura", { timeoutInMilliseconds: 60000 }));

  useEffect(() => {
    if (!contenedor.current) return continueRender(handle);
    const tinta = claro ? new alphaTab.model.Color(17, 17, 17, 255) : new alphaTab.model.Color(240, 240, 240, 255);
    const gris = claro ? new alphaTab.model.Color(90, 90, 90, 255) : new alphaTab.model.Color(150, 150, 150, 255);
    const settings = new alphaTab.Settings();
    settings.core.engine = "svg";
    settings.core.useWorkers = false;
    settings.core.enableLazyLoading = false;
    settings.core.fontDirectory = staticFile("alphatab/font/");
    settings.player.enablePlayer = false;
    settings.core.logLevel = alphaTab.LogLevel.Warning;
    settings.notation.elements.set(alphaTab.NotationElement.EffectDynamics, false);
    settings.notation.elements.set(alphaTab.NotationElement.TrackNames, false);
    settings.notation.elements.set(alphaTab.NotationElement.EffectTempo, false); // el tempo ya está en el lead sheet
    settings.display.layoutMode = alphaTab.LayoutMode.Horizontal;
    settings.display.scale = melodia.escala ?? escala;
    const r = settings.display.resources;
    r.mainGlyphColor = tinta;
    r.secondaryGlyphColor = gris;
    r.staffLineColor = gris;
    r.barSeparatorColor = gris;
    r.barNumberColor = gris;

    const api = new alphaTab.AlphaTabApi(contenedor.current, settings);
    api.renderFinished.on(() => {
      const lista: Tiempo[] = [];
      const score = api.score, lookup = api.boundsLookup;
      if (score && lookup)
        for (const bar of score.tracks[0].staves[0].bars)
          for (const beat of bar.voices[0].beats) {
            const b = lookup.findBeat(beat);
            if (b) lista.push({ tick: beat.absolutePlaybackStart, x: b.onNotesX });
          }
      lista.sort((a, b) => a.tick - b.tick);
      setTiempos(lista);
      continueRender(handle);
    });
    api.error.on((e) => {
      console.error("alphaTab", e);
      continueRender(handle);
    });
    api.tex(melodia.alphatex);
    return () => api.destroy();
  }, [melodia.alphatex, claro]);

  // cursor en píxeles de la partitura (interpolado entre beats)
  let x: number | null = null;
  if (tiempos?.length) {
    const negras = (ahoraSeg - tick0Seg) * (melodia.bpm / 60);
    const sw = melodia.swingFase;
    const fase = negras - Math.floor(negras);
    const escrita = !sw ? fase : fase < sw ? (fase * 0.5) / sw : 0.5 + ((fase - sw) * 0.5) / (1 - sw);
    const tick = (Math.floor(negras) + escrita) * TICKS_POR_NEGRA;
    const i = tiempos.findIndex((t) => t.tick > tick);
    if (tick >= 0) {
      if (i === -1) x = tiempos.at(-1)!.x;
      else if (i > 0) {
        const a = tiempos[i - 1], b = tiempos[i];
        x = a.x + ((tick - a.tick) / (b.tick - a.tick)) * (b.x - a.x);
      } else x = tiempos[0].x;
    }
  }

  const corrimiento = seguir !== undefined && x !== null ? Math.max(0, x - ancho * seguir) : 0;
  return (
    <div style={{ position: "absolute", inset: 0, width: ancho, height: alto, overflow: "hidden", background: fondo ?? (claro ? "#ececef" : "#0d0d0f"), borderRadius: 18, boxShadow: claro ? "0 8px 30px #0006" : undefined }}>
      <style>{".partitura-alphatab .at-surface { overflow: visible !important; }"}</style>
      <div ref={contenedor} className="partitura-alphatab" style={{ position: "absolute", top: paddingTop, left: -corrimiento, width: seguir !== undefined ? 8000 : ancho, overflow: "visible" }} />
      {x !== null && (
        <div style={{ position: "absolute", top: 14, bottom: 14, left: x - corrimiento - 2, width: 4, background: claro ? "#d9534f" : "#f2b84b", opacity: 0.9, borderRadius: 2 }} />
      )}
    </div>
  );
};
