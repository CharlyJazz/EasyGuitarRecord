import React from "react";
import { AbsoluteFill, OffthreadVideo, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FPS, FUENTE, MONO } from "../estilo.ts";

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Entrada con resorte: 0..1 a partir del frame `desde` (relativo a la secuencia). */
export const useEntrada = (desde = 0, damping = 16) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: f - desde, fps, config: { damping } });
};

export const Fondo: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ background: `radial-gradient(120% 80% at 50% 0%, #1d1940 0%, ${C.fondo} 60%)`, fontFamily: FUENTE, color: C.texto }}>
    {children}
  </AbsoluteFill>
);

export const TextoGrande: React.FC<{ children: React.ReactNode; top?: number; tam?: number; desde?: number; color?: string }> = ({
  children, top = 260, tam = 86, desde = 0, color = C.texto,
}) => {
  const e = useEntrada(desde);
  return (
    <div
      style={{
        position: "absolute", top, left: 60, right: 60, textAlign: "center", fontSize: tam, fontWeight: 900,
        lineHeight: 1.08, color, opacity: e, transform: `translateY(${(1 - e) * 40}px)`, textWrap: "balance",
        textShadow: "0 6px 30px #000a",
      }}
    >
      {children}
    </div>
  );
};

export const Etiqueta: React.FC<{ children: React.ReactNode; top: number; desde?: number; tam?: number; color?: string }> = ({
  children, top, desde = 0, tam = 34, color = C.tenue,
}) => {
  const e = useEntrada(desde);
  return (
    <div style={{ position: "absolute", top, left: 60, right: 60, textAlign: "center", fontSize: tam, fontWeight: 600, color, opacity: e }}>
      {children}
    </div>
  );
};

/** Parte la voz en frases (. ? ! …) y reparte el tramo según el largo de cada una. */
export const frases = (texto: string, dur: number, tiempos?: number[]) => {
  const partes = texto.match(/[^.?!…]+[.?!…]+["”»]?\s*|[^.?!…]+$/g)?.map((x) => x.trim()).filter(Boolean) ?? [texto];
  // con tiempos: cada frase arranca en su segundo y dura lo que se tarda en decirla (~2,5 pal/s + 0,6 s),
  // sin pisar la siguiente; en los huecos (tomas sonando) no hay subtítulo
  if (tiempos && tiempos.length === partes.length)
    return partes.map((x, i) => {
      const desde = Math.round(tiempos[i] * FPS);
      const propio = desde + Math.round((x.split(/\s+/).length / 2.5 + 0.6) * FPS);
      return { texto: x, desde, hasta: Math.min(propio, i + 1 < tiempos.length ? Math.round(tiempos[i + 1] * FPS) : dur) };
    });
  const total = partes.reduce((a, x) => a + x.length, 0);
  let acc = 0;
  return partes.map((x) => {
    const desde = Math.round((acc / total) * dur);
    acc += x.length;
    return { texto: x, desde, hasta: Math.round((acc / total) * dur) };
  });
};

/** Subtítulo de la voz en off, frase por frase (zona segura de TikTok: deja libres los últimos ~300 px). */
export const Subtitulo: React.FC<{ texto: string; dur: number; tiempos?: number[] }> = ({ texto, dur, tiempos }) => {
  const f = useCurrentFrame();
  if (!texto.trim()) return null; // tramo solo de música
  const fr = frases(texto, dur, tiempos);
  const actual = fr.find((x) => f >= x.desde && f < x.hasta) ?? (tiempos ? undefined : fr[fr.length - 1]);
  if (!actual) return null;
  const o = interpolate(f - actual.desde, [0, 5], [0, 1], clamp);
  return (
    <div
      style={{
        position: "absolute", left: 70, right: 70, bottom: 300, fontFamily: FUENTE, textAlign: "center", fontSize: 42, fontWeight: 700,
        lineHeight: 1.3, color: "#fff", opacity: o, textWrap: "balance",
        background: "#000a", borderRadius: 18, padding: "16px 24px",
      }}
    >
      {actual.texto}
    </div>
  );
};

/** Hueco para una toma (video en public/tomas/). Sin archivo no dibuja nada, así el video se puede armar antes de grabar. */
export const Toma: React.FC<{ archivo: string | null | undefined; descripcion: string; estilo?: React.CSSProperties; desdeSeg?: number }> = ({
  archivo, descripcion, estilo, desdeSeg = 0,
}) => {
  const { fps } = useVideoConfig();
  const base: React.CSSProperties = { position: "absolute", overflow: "hidden", borderRadius: 28, ...estilo };
  if (archivo)
    return (
      <div style={base}>
        <OffthreadVideo src={staticFile(`tomas/${archivo}`)} startFrom={Math.round(desdeSeg * fps)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    );
  return null; // sin archivo no se dibuja nada (antes: recuadro "TOMA" de placeholder)
};

/** Perilla horizontal del coeficiente o (0..max). `valor` puede ser fraccionario mientras se mueve. */
export const Perilla: React.FC<{ valor: number; max?: number; titulo: string; top: number }> = ({ valor, max = 3, titulo, top }) => {
  const ancho = 760;
  const x = (valor / max) * ancho;
  const entero = Math.round(valor);
  return (
    <div style={{ position: "absolute", top, left: (1080 - ancho) / 2, width: ancho, height: 170 }}>
      <div style={{ textAlign: "center", fontSize: 30, color: C.tenue, fontWeight: 600 }}>{titulo}</div>
      <div style={{ position: "absolute", top: 86, left: 0, width: ancho, height: 12, borderRadius: 6, background: C.vacio }} />
      <div style={{ position: "absolute", top: 86, left: 0, width: x, height: 12, borderRadius: 6, background: `linear-gradient(90deg, ${C.verdeBg}, ${C.rojoBg})` }} />
      {Array.from({ length: max + 1 }, (_, i) => (
        <div key={i} style={{ position: "absolute", top: 118, left: (i / max) * ancho - 20, width: 40, textAlign: "center", fontSize: 30, fontWeight: 800, color: i === entero ? C.texto : C.tenue }}>
          {i}
        </div>
      ))}
      <div
        style={{
          position: "absolute", top: 54, left: x - 38, width: 76, height: 76, borderRadius: 38, background: C.texto,
          boxShadow: `0 0 0 8px ${C.acento}66, 0 8px 24px #000`, display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: MONO, fontSize: 30, fontWeight: 900, color: C.fondo,
        }}
      >
        o={entero}
      </div>
    </div>
  );
};

export const Panel: React.FC<{ children: React.ReactNode; estilo?: React.CSSProperties }> = ({ children, estilo }) => (
  <div style={{ position: "absolute", background: C.panel, border: `2px solid ${C.borde}`, borderRadius: 24, padding: 32, ...estilo }}>{children}</div>
);
