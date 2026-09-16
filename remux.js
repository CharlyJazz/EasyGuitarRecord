// Convierte lo que escupe el MediaRecorder en un MP4 que los editores acepten.
//
// El MediaRecorder de Chrome/Edge con `video/mp4;codecs=avc1` no escribe un MP4
// normal: escribe un **MP4 fragmentado** (fMP4). Tiene que hacerlo, porque
// emite el archivo de a trozos sin saber de antemano cuanto va a durar. La
// diferencia esta en la estructura de cajas:
//
//   fragmentado:  ftyp | moov (vacio, duration=0) | moof+mdat | moof+mdat | ...
//   normal:       ftyp | moov (indice completo)   | mdat
//
// En el fragmentado el `moov` no trae la tabla de muestras (`stbl`: stts/stsz/
// stco), asi que **no hay indice**: la duracion real esta repartida en cada
// `moof` y solo se conoce recorriendo el archivo entero. Los reproductores de
// streaming lo toleran; DaVinci Resolve no importa fMP4 y lo reporta como
// archivo dañado. (Medido: el moov del crudo declara `duration=0` y ffprobe
// devuelve `nb_frames=N/A`.)
//
// El arreglo es un **remux**, no una recodificacion: se reescriben las cajas
// con el indice completo adelante y se copian los mismos paquetes H.264 tal
// cual. No se vuelve a comprimir nada, asi que no se pierde un solo bit de
// calidad y tarda decimas de segundo aunque la toma pese cientos de MB.
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";

// Permite apuntar a un binario concreto si no esta en el PATH.
const FFMPEG = process.env.FFMPEG || "ffmpeg";

let disponible = null;

export function hayFfmpeg() {
  if (disponible === null) {
    try {
      disponible = spawnSync(FFMPEG, ["-version"], { stdio: "ignore" }).status === 0;
    } catch {
      disponible = false;
    }
  }
  return disponible;
}

function correr(args) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => resolve({ ok: false, err: e.message }));
    p.on("close", (code) => resolve({ ok: code === 0, err: err.trim().split("\n").slice(-3).join(" ") }));
  });
}

/**
 * Deja la toma lista para editar. Devuelve { destino, metodo, detalle }.
 *
 * - `.mp4` del MediaRecorder: remux sin recodificar (copia de streams).
 * - `.webm` (VP8/VP9, el respaldo si el navegador no da MP4): Resolve tampoco
 *   lee WebM, y VP9 no se puede meter en un MP4 copiando, asi que ahi si hay
 *   que recodificar a H.264. Es lento, pero es la unica salida.
 * - Sin ffmpeg: se guarda el crudo tal cual y se avisa, antes que perder la toma.
 */
export async function finalizarToma(parcial, destinoBase) {
  const esWebm = path.extname(parcial).toLowerCase() === ".webm";
  const destino = `${destinoBase}.mp4`;

  if (!hayFfmpeg()) {
    const crudo = `${destinoBase}${path.extname(parcial)}`;
    fs.renameSync(parcial, crudo);
    return {
      destino: crudo,
      metodo: "crudo",
      detalle: "sin ffmpeg: el archivo queda fragmentado y los editores lo van a rechazar",
    };
  }

  const args = esWebm
    ? ["-v", "error", "-y", "-i", parcial,
       "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
       "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", destino]
    : ["-v", "error", "-y", "-i", parcial,
       "-c", "copy", "-movflags", "+faststart", destino];

  const r = await correr(args);

  if (!r.ok) {
    // Si falla, mejor dejar el crudo que no dejar nada.
    const crudo = `${destinoBase}${path.extname(parcial)}`;
    try { fs.renameSync(parcial, crudo); } catch {}
    try { if (fs.existsSync(destino)) fs.unlinkSync(destino); } catch {}
    return { destino: crudo, metodo: "crudo", detalle: `ffmpeg fallo: ${r.err}` };
  }

  fs.unlinkSync(parcial);
  return {
    destino,
    metodo: esWebm ? "recodificado" : "remux",
    detalle: esWebm ? "webm recodificado a H.264" : "",
  };
}
