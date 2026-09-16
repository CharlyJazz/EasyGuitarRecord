// Graba el stream que llega del telefono y lo escribe en la PC.
//
// Los trozos del MediaRecorder salen por WebSocket a medida que se generan y
// el servidor los va escribiendo a disco. No se junta el video entero en
// memoria: una toma de varios minutos a 12 Mbps son cientos de MB, y ademas
// asi una toma descartada no deja nada dando vueltas.

import { crearSocket } from "../shared/socket.js";

const BITRATE_GRABACION = 12_000_000;
// AAC a 192k. El techo real lo pone el Opus del WebRTC, no este numero, pero
// de menos empeora lo que llego.
const BITRATE_AUDIO = 192_000;
// Un trozo por segundo: si algo se corta, se pierde a lo sumo un segundo.
const TROZO_MS = 1000;

// El primer formato soportado gana. MP4 es mas comodo para editar despues;
// WebM es el que siempre esta.
// Cada fila trae la variante con audio y la de solo video. El mimeType que se
// le pasa al MediaRecorder es un contrato cerrado: si enumera codecs, graba
// SOLO los que enumera. "video/mp4;codecs=avc1" no es "mp4 con H.264", es
// "mp4 con H.264 y nada mas", y por eso el audio se perdia aca aunque llegara.
const FORMATOS = [
  { conAudio: "video/mp4;codecs=avc1,mp4a.40.2", soloVideo: "video/mp4;codecs=avc1", extension: "mp4" },
  { conAudio: "video/webm;codecs=vp9,opus", soloVideo: "video/webm;codecs=vp9", extension: "webm" },
  { conAudio: "video/webm;codecs=vp8,opus", soloVideo: "video/webm;codecs=vp8", extension: "webm" },
  { conAudio: "video/webm", soloVideo: "video/webm", extension: "webm" },
];

// Pedir un codec de audio cuando el stream no trae microfono queda librado a
// la buena voluntad del navegador, asi que se pregunta antes.
function elegirFormato(conAudio) {
  for (const f of FORMATOS) {
    const mimeType = conAudio ? f.conAudio : f.soloVideo;
    if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType, extension: f.extension };
  }
  return null;
}

export function crearGrabador({ alEstado }) {
  let formato = elegirFormato(false);
  let grabador = null;
  let arranque = 0;

  const socket = crearSocket({
    ruta: "/grabacion",
    alMensaje: ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.type === "guardado") {
        alEstado({
          estado: "guardado",
          archivo: msg.archivo,
          bytes: msg.bytes,
          metodo: msg.metodo,
          detalle: msg.detalle,
        });
      } else if (msg.type === "procesando") {
        alEstado({ estado: "procesando" });
      } else if (msg.type === "descartado") {
        alEstado({ estado: "descartado" });
      } else if (msg.type === "grabando") {
        alEstado({ estado: "grabando" });
      }
    },
    alCambiarEstado: (est) => {
      if (est === "cerrado" && grabador) {
        // Se cayo el canal en medio de una toma: el parcial del servidor se
        // borra solo al cerrarse el socket, asi que aca solo hay que frenar.
        detener();
        alEstado({ estado: "error", detalle: "se corto el canal de grabacion" });
      }
    },
  });

  function detener() {
    if (grabador && grabador.state !== "inactive") grabador.stop();
    grabador = null;
  }

  return {
    get formato() {
      return formato;
    },
    get grabando() {
      return !!grabador && grabador.state === "recording";
    },
    get segundos() {
      return arranque ? (performance.now() - arranque) / 1000 : 0;
    },

    iniciar(stream) {
      // El formato se decide aca y no al cargar el modulo: depende de si el
      // telefono mando microfono en esta sesion.
      formato = elegirFormato(stream.getAudioTracks().length > 0) || formato;

      if (!formato) {
        alEstado({ estado: "error", detalle: "el navegador no puede grabar video" });
        return false;
      }
      if (!socket.listo) {
        alEstado({ estado: "error", detalle: "sin canal de grabacion" });
        return false;
      }
      detener();

      socket.enviar({ type: "iniciar", extension: formato.extension });

      grabador = new MediaRecorder(stream, {
        mimeType: formato.mimeType,
        videoBitsPerSecond: BITRATE_GRABACION,
        audioBitsPerSecond: BITRATE_AUDIO,
      });

      grabador.ondataavailable = (e) => {
        if (e.data && e.data.size) socket.enviarBinario(e.data);
      };
      grabador.onerror = (e) => {
        alEstado({ estado: "error", detalle: e.error?.name || "fallo el grabador" });
        detener();
      };

      grabador.start(TROZO_MS);
      arranque = performance.now();
      return true;
    },

    // stop() dispara un ultimo ondataavailable; hay que esperarlo antes de
    // pedir el cierre, o se pierde el final de la toma.
    async terminar(accion) {
      if (!grabador) return;
      const ese = grabador;
      grabador = null;
      arranque = 0;

      if (ese.state !== "inactive") {
        await new Promise((r) => {
          ese.addEventListener("stop", r, { once: true });
          ese.stop();
        });
      }
      socket.enviar({ type: accion });
    },
  };
}
