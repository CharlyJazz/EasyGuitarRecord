import React from "react";
import { AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import guion from "./guion.json";
import { C, FPS } from "./estilo.ts";
import type { Idioma } from "./i18n.ts";
import { Subtitulo } from "./ui/comunes.tsx";
import { ESCENAS } from "./escenas/index.tsx";

// Video armado desde src/guion.json: cada versión = { audio, segmentos[] }. Cada segmento es una escena con
// desde/hasta (s), voz es/en, y opcionalmente `tiempos` (inicio de cada frase) y `marcas` (animación atada a palabras).
// Las escenas se registran por id en src/escenas/index.tsx. Flujo completo en agents/README.md.

export type Version = keyof typeof guion;
export type Props = { idioma: Idioma; version: Version; subtitulos: boolean };

type Segmento = {
  id: string; desde: number; hasta: number; momento: string;
  voz: { es: string; en: string };
  tiempos?: number[];
  marcas?: Record<string, number | number[]>;
};
type Guion = { audio: string | null; audioVersion?: number; segmentos: Segmento[] };

const g = (v: Version) => guion[v] as unknown as Guion;
export const duracionFrames = (v: Version) => Math.round(Math.max(...g(v).segmentos.map((s) => s.hasta)) * FPS);

// La primera escena entra sin fundido: el cuadro 0 es la miniatura y el gancho de las redes (no puede ser negro).
const Fundido: React.FC<{ children: React.ReactNode; sin?: boolean }> = ({ children, sin }) => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ opacity: sin ? 1 : interpolate(f, [0, 6], [0, 1], { extrapolateRight: "clamp" }) }}>{children}</AbsoluteFill>;
};

// Audio: en el Studio suena guion.audio (la mezcla de tools/mezcla.py); en el render final se pone con ffmpeg
// (tools/render.mjs), no con Remotion: su AAC atrasa el audio 42,7 ms.
export const Video: React.FC<Props> = ({ idioma, version, subtitulos }) => (
  <AbsoluteFill style={{ background: C.fondo }}>
    {g(version).audio && <Audio src={`${staticFile(g(version).audio!)}?v=${g(version).audioVersion ?? 0}`} />}
    {g(version).segmentos.map((s, i) => {
      const Escena = ESCENAS[s.id];
      if (!Escena) throw new Error(`escena sin componente: ${s.id}`);
      const desde = Math.round(s.desde * FPS);
      const dur = Math.round(s.hasta * FPS) - desde;
      return (
        <Sequence key={`${s.id}-${i}`} from={desde} durationInFrames={dur} name={`${s.desde}s · ${s.momento}`}>
          <Fundido sin={i === 0}>
            <Escena idioma={idioma} dur={dur} inicioSeg={s.desde} vozEs={s.voz.es} marcas={s.marcas} />
          </Fundido>
          {subtitulos && <Subtitulo texto={s.voz[idioma]} dur={dur} tiempos={s.tiempos} />}
        </Sequence>
      );
    })}
  </AbsoluteFill>
);
