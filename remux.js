// Convierte lo que escupe el MediaRecorder en un MP4 que los editores acepten.
//
// Hay DOS problemas distintos, y hacen falta dos arreglos:
//
// 1) EL ENVOLTORIO. El MediaRecorder de Chrome/Edge con `video/mp4;codecs=avc1`
//    no escribe un MP4 normal: escribe un **MP4 fragmentado** (fMP4). Tiene que
//    hacerlo, porque emite el archivo de a trozos sin saber de antemano cuanto
//    va a durar. La diferencia esta en la estructura de cajas:
//
//      fragmentado:  ftyp | moov (vacio, duration=0) | moof+mdat | moof+mdat | ...
//      normal:       ftyp | moov (indice completo)   | mdat
//
//    En el fragmentado el `moov` no trae la tabla de muestras (`stbl`: stts/
//    stsz/stco), asi que **no hay indice**. Los reproductores de streaming lo
//    toleran; DaVinci Resolve no importa fMP4 y lo reporta como archivo dañado.
//    (Medido: el moov del crudo declara `duration=0` y ffprobe devuelve
//    `nb_frames=N/A`.)
//
// 2) EL RITMO. El MediaRecorder escribe los tiempos de llegada **reales** de
//    WebRTC, que es adaptativo por diseño y baja los fps cuando la conexion
//    arranca o se congestiona. El archivo queda **VFR** (tasa variable) y los
//    editores necesitan una tasa fija.
//
//    Medido sobre 5 tomas: entre 28 y 124 intervalos distintos entre cuadros
//    (un archivo de tasa fija tiene 1), y la tasa que el archivo *declara* sale
//    distinta en cada toma -- 60, 30, 20, 47, 29.97, 59.94 -- porque se deriva
//    del hueco mas corto que aparezca. Una toma medida declaraba 60 fps y tenia
//    22,46 reales; conformada a lo que declara, 70 s de material entran en 26.
//
//    El daño se concentra en los primeros ~10 segundos, mientras WebRTC levanta
//    el bitrate: en la toma del 18/09 hay un hueco de 2.500 ms en el segundo 3 y
//    el segundo 4 no tiene ni un cuadro. Pasado el segundo 10, 133 de 141
//    segundos estan exactos en 30 fps. Por eso ademas del arreglo de aca, el
//    monitor no arranca a grabar hasta que el video se estabiliza (monitor.js).
//
// El arreglo de (1) es un remux y el de (2) es una recodificacion, asi que la
// segunda se come a la primera: al recodificar se reescriben las cajas igual.
// `-fps_mode cfr` **duplica cuadros en los huecos en vez de comprimir el
// tiempo**, que es lo unico que sirve para sincronizar: la duracion real se
// conserva. Los segundos flojos se ven congelados, pero en sync.
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";

// Permite apuntar a un binario concreto si no esta en el PATH.
const FFMPEG = process.env.FFMPEG || "ffmpeg";

// La captura se pide en 1080p30 (phone.js), y el tramo estable de las tomas
// medidas da 30,04 fps/seg de promedio: 30 clavados, no 29,97.
const FPS_SALIDA = Number(process.env.FPS_SALIDA) || 30;

// Escotilla de salida: CFR=0 vuelve al remux por copia de antes. Es 0,14 s en
// vez de ~13, pero devuelve el archivo VFR y el problema de sincronizacion con
// el. Sirve para material que no se va a editar.
const FORZAR_CFR = process.env.CFR !== "0";

// Sonoridad a la que se lleva el audio de cada toma, en LUFS. -14 es lo que
// normalizan YouTube, Instagram y TikTok. NORMALIZAR=0 deja el audio intacto.
const LUFS_OBJETIVO = Number(process.env.LUFS_OBJETIVO) || -14;
const NORMALIZAR = process.env.NORMALIZAR !== "0";

// Techo de ganancia: por arriba de esto lo que se sube es ruido de fondo, no
// guitarra. Y por debajo de -70 LUFS la toma es silencio (o no tiene mic).
const GANANCIA_MAXIMA_DB = 40;
const LUFS_SILENCIO = -70;

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

// `-encoders` dice que el binario trae nvenc compilado, NO que haya una placa
// NVIDIA de este lado. Por eso esto solo elige por donde *empezar*: si falla en
// tiempo de ejecucion, finalizarToma() reintenta con libx264.
let encoderPreferido = null;

function elegirEncoder() {
  if (encoderPreferido === null) {
    encoderPreferido = "libx264";
    try {
      const r = spawnSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" });
      if (r.status === 0 && r.stdout.includes("h264_nvenc")) encoderPreferido = "h264_nvenc";
    } catch {}
  }
  return encoderPreferido;
}

// Medido sobre una toma real de 152 s en 1080p: nvenc tarda 13,3 s. libx264 en
// `veryfast` es varias veces mas lento, pero no depende de la GPU.
function argsDeVideo(encoder) {
  return encoder === "h264_nvenc"
    ? ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "20",
       "-b:v", "0", "-maxrate", "25M", "-bufsize", "50M"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"];
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

// El microfono se pide con autoGainControl en false (phone.js): el AGC de iOS
// bombea el volumen entre frase y frase y le come el ataque a la guitarra. El
// precio es que el mic crudo del iPhone llega muy bajo. Medido en la toma del
// 07/10: -47,9 LUFS integrado, pico -27,1 dBFS -- 34 dB por debajo de lo que
// suena un video publicado, y sin nada que lo este limitando.
//
// El arreglo es UNA ganancia fija para toda la toma (la que la lleva al
// objetivo) mas un limitador que solo atrapa los picos que pasarian de -1 dB.
// No es un AGC: la ganancia no se mueve, asi que no bombea. Se probo tambien
// con un compresor delante y aplastaba la dinamica (LRA 6,1 -> 2,7) sin llegar
// al objetivo; solo ganancia + limitador da -14,4 LUFS, pico -0,9, LRA 5,0.
function medirLufs(archivo) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-nostats", "-i", archivo, "-vn",
      "-af", "ebur128=framelog=quiet", "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", () => resolve(null));
    p.on("close", () => {
      // El resumen final trae "I: -47.9 LUFS"; las lineas por cuadro no salen
      // con framelog=quiet.
      const m = [...err.matchAll(/I:\s+(-?[\d.]+|-inf) LUFS/g)].pop();
      resolve(m && m[1] !== "-inf" ? Number(m[1]) : null);
    });
  });
}

async function argsDeAudio(parcial, esWebm) {
  const recodificar = (filtro) => [...(filtro ? ["-af", filtro] : []), "-c:a", "aac", "-b:a", "192k"];
  const sinTocar = esWebm ? recodificar(null) : ["-c:a", "copy"];

  if (!NORMALIZAR) return { audio: sinTocar, nota: "" };

  const lufs = await medirLufs(parcial);
  if (lufs === null || lufs < LUFS_SILENCIO) return { audio: sinTocar, nota: "audio sin señal, no se normaliza" };

  const ganancia = Math.min(LUFS_OBJETIVO - lufs, GANANCIA_MAXIMA_DB);
  if (ganancia < 0.5) return { audio: sinTocar, nota: `audio ${lufs.toFixed(1)} LUFS, ya alcanza` };

  const filtro = `volume=${ganancia.toFixed(1)}dB,alimiter=limit=-1dB:attack=5:release=60:level=false`;
  return { audio: recodificar(filtro), nota: `audio ${lufs.toFixed(1)} LUFS +${ganancia.toFixed(1)} dB` };
}

/**
 * Deja la toma lista para editar. Devuelve { destino, metodo, detalle }.
 *
 * Se intenta en orden, y el primero que sale bien gana:
 *
 * 1. CFR con el encoder preferido (nvenc si hay, si no libx264).
 * 2. CFR con libx264, por si el primero era nvenc y no hay placa.
 * 3. Remux por copia: arregla el envoltorio pero deja el archivo VFR. Peor,
 *    pero infinitamente mejor que perder la toma.
 * 4. El crudo tal cual, avisando.
 *
 * El `.webm` (VP8/VP9, el respaldo si el navegador no da MP4) nunca puede
 * copiarse a un MP4, asi que ahi el paso 3 no existe.
 */
export async function finalizarToma(parcial, destinoBase) {
  const esWebm = path.extname(parcial).toLowerCase() === ".webm";
  const destino = `${destinoBase}.mp4`;

  const guardarCrudo = (detalle) => {
    const crudo = `${destinoBase}${path.extname(parcial)}`;
    try { fs.renameSync(parcial, crudo); } catch {}
    try { if (fs.existsSync(destino)) fs.unlinkSync(destino); } catch {}
    return { destino: crudo, metodo: "crudo", detalle };
  };

  if (!hayFfmpeg()) {
    return guardarCrudo("sin ffmpeg: el archivo queda fragmentado y los editores lo van a rechazar");
  }

  // La sincronizacion se arregla del lado del video, no moviendo el audio: el
  // filtro de volumen no cambia ni un tiempo. El del WebM es Opus y no entra en
  // un MP4, asi que ese se recodifica siempre.
  const { audio, nota } = await argsDeAudio(parcial, esWebm);
  const conNota = (texto) => (nota ? `${texto}; ${nota}` : texto);

  const intentos = [];

  if (FORZAR_CFR || esWebm) {
    const primero = elegirEncoder();
    intentos.push({ encoder: primero });
    if (primero !== "libx264") intentos.push({ encoder: "libx264" });
  }

  if (!esWebm) intentos.push({ encoder: null });   // remux por copia

  let ultimoError = "";

  for (const { encoder } of intentos) {
    const args = encoder
      ? ["-v", "error", "-y", "-i", parcial,
         "-fps_mode", "cfr", "-r", String(FPS_SALIDA),
         ...argsDeVideo(encoder), "-pix_fmt", "yuv420p", ...audio,
         "-movflags", "+faststart", destino]
      : ["-v", "error", "-y", "-i", parcial,
         "-c:v", "copy", ...audio, "-movflags", "+faststart", destino];

    const r = await correr(args);
    if (!r.ok) {
      ultimoError = r.err;
      continue;
    }

    fs.unlinkSync(parcial);

    if (!encoder) {
      return {
        destino,
        metodo: "remux",
        detalle: conNota(ultimoError
          ? `sin recodificar: el archivo queda VFR (${ultimoError})`
          : "sin recodificar: el archivo queda VFR"),
      };
    }
    return {
      destino,
      metodo: "cfr",
      detalle: conNota(`${FPS_SALIDA} fps constantes (${encoder})`),
    };
  }

  return guardarCrudo(`ffmpeg fallo: ${ultimoError}`);
}
