import type { Idioma } from "../i18n.ts";

// Props que recibe cada escena (las arma Video.tsx desde src/guion.json).
export type EscenaProps = {
  idioma: Idioma;
  /** duración de la escena en frames */
  dur: number;
  /** segundo del video en que empieza la escena */
  inicioSeg: number;
  /** voz en español del tramo */
  vozEs: string;
  /** momentos de la animación atados a palabras de la voz grabada (segundos desde el inicio de la escena).
   *  Las salen de la transcripción por palabra (tools/transcribir.py). Ojo: banderas = presencia, no valor. */
  marcas?: Record<string, number | number[]>;
};

export const L = <T = string,>(idioma: Idioma, o: { es: T; en: T }) => o[idioma];

/** marca en segundos → fracción de la escena (o `def` si no hay marca) */
export const marca = (marcas: EscenaProps["marcas"], clave: string, dur: number, fps: number, def: number) => {
  const v = marcas?.[clave];
  return typeof v === "number" ? (v * fps) / dur : def;
};
