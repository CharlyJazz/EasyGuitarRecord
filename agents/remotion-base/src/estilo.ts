// Paleta y medidas compartidas por todos los videos (fondo violeta oscuro, vertical 1080x1920).
// Agregar acá los colores propios de cada video.
export const C = {
  fondo: "#0f0d1f",
  panel: "#1a1736",
  vacio: "#221f42",
  borde: "#34306a",
  texto: "#efedff",
  tenue: "#8f8ab8",
  acento: "#8b7cff",
  acordeBg: "#463d9e",
  acordeTx: "#e4e0ff",
  verdeBg: "#1d7a57",
  verdeTx: "#d2fbe9",
  rojoBg: "#b32a37",
  rojoTx: "#ffe0e3",
  ambar: "#f2b84b",
  // colores propios del video (ejemplo)
  uno: "#f2b84b",
  dos: "#4fd69c",
  inside: "#5aa9ff",
  outside: "#ff7a8a",
};

export const FUENTE = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
export const MONO = '"Cascadia Code", Consolas, "Courier New", monospace';

// Prefijo de los ids de composición: <PREFIJO>-<Version>-<es|en>. Cambiarlo por el nombre corto del video.
export const PREFIJO = "Video";

export const FPS = 30;
export const ANCHO = 1080; // vertical (TikTok / Shorts / Reels)
export const ALTO = 1920;

// Grilla de la música de fondo (si hay backing): ajustar al tema que se use. Los licks/ejemplos sonoros
// se ubican en múltiplos de SEG_COMPAS desde t = 0 (ver tools/mezcla.py --insertar).
export const BPM = 95; // tempo del backing del video: ajustarlo al tema que se use
export const TIEMPOS_POR_COMPAS = 4;
export const SEG_COMPAS = (60 / BPM) * TIEMPOS_POR_COMPAS;
