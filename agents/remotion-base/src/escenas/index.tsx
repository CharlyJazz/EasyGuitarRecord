import React from "react";
import { useVideoConfig } from "remotion";
import { C } from "../estilo.ts";
import { Fondo, Etiqueta, TextoGrande, Toma } from "../ui/comunes.tsx";
import { L, marca, type EscenaProps } from "./tipos.ts";

// Escenas de EJEMPLO. Cada video crea las suyas y las registra en ESCENAS con el mismo id que usa
// src/guion.json. Reglas que ya costaron caro:
//  - Nada quieto: animar en segundos fijos (0,35 s, 1,6 s), no en % de escena; si un tramo muestra lo
//    mismo varios segundos, cortarlo o acelerarlo.
//  - El gancho tiene que pasar antes de los 2 s, y el cuadro 0 no puede ser negro (es la miniatura).
//  - Las animaciones se atan a PALABRAS de la voz con `marcas` (segundos desde el inicio de la escena),
//    que salen de la transcripción de whisper (tools/transcribir.py). Ver agents/skills/voz-y-timeline.

const Gancho: React.FC<EscenaProps> = ({ idioma }) => (
  <Fondo>
    <TextoGrande top={520} tam={96}>
      {L(idioma, { es: "¿Una pregunta que engancha?", en: "A question that hooks?" })}
    </TextoGrande>
  </Fondo>
);

const Explicacion: React.FC<EscenaProps> = ({ idioma, dur, marcas }) => {
  const { fps } = useVideoConfig();
  // `detalle` aparece cuando la voz dice la palabra marcada (o a la mitad si no hay marca todavía)
  const detalle = Math.round(marca(marcas, "detalle", dur, fps, 0.5) * dur);
  return (
    <Fondo>
      <TextoGrande top={300}>{L(idioma, { es: "La idea", en: "The idea" })}</TextoGrande>
      <Toma archivo={null} descripcion="toma tocando" estilo={{ top: 560, left: 90, width: 900, height: 900 }} />
      <Etiqueta top={1500} desde={detalle} color={C.ambar} tam={44}>
        {L(idioma, { es: "Aparece con la palabra marcada", en: "Shows up on the marked word" })}
      </Etiqueta>
    </Fondo>
  );
};

export const ESCENAS: Record<string, React.FC<EscenaProps>> = {
  gancho: Gancho,
  explicacion: Explicacion,
};
