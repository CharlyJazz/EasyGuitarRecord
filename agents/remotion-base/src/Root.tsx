import React from "react";
import { Composition } from "remotion";
import guion from "./guion.json";
import { ALTO, ANCHO, FPS, PREFIJO } from "./estilo.ts";
import { Video, duracionFrames, type Props, type Version } from "./Video.tsx";

// Una composición por versión del guion × idioma: <PREFIJO>-<Version>-<es|en> (p. ej. Video-Corto-es).
// tools/render.mjs deduce la versión del id, así que respetar ese formato.
const nombre = (v: string) => v[0].toUpperCase() + v.slice(1);

export const Root: React.FC = () => (
  <>
    {(Object.keys(guion) as Version[]).flatMap((version) =>
      (["es", "en"] as const).map((idioma) => (
        <Composition
          key={`${version}-${idioma}`}
          id={`${PREFIJO}-${nombre(version)}-${idioma}`}
          component={Video}
          durationInFrames={duracionFrames(version)}
          fps={FPS}
          width={ANCHO}
          height={ALTO}
          // Subtítulos apagados por defecto: si el creador graba la voz con sus palabras, los textos
          // en pantalla que repiten la voz sobran. Prenderlos solo para versiones sin voz.
          defaultProps={{ idioma, version, subtitulos: false } satisfies Props}
        />
      )),
    )}
  </>
);
