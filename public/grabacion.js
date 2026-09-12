// Graba el stream que llega del telefono y lo escribe en la PC.
//
// Los trozos del MediaRecorder salen por WebSocket a medida que se generan y
// el servidor los va escribiendo a disco. No se junta el video entero en
// memoria: una toma de varios minutos a 12 Mbps son cientos de MB, y ademas
// asi una toma descartada no deja nada dando vueltas.

import { crearSocket } from "../shared/socket.js";

const BITRATE_GRABACION = 12_000_000;
// Un trozo por segundo: si algo se corta, se pierde a lo sumo un segundo.
const TROZO_MS = 1000;

// El primer formato soportado gana. MP4 es mas comodo para editar despues;
// WebM es el que siempre esta.
const FORMATOS = [
  { mimeType: "video/mp4;codecs=avc1", extension: "mp4" },
  { mimeType: "video/webm;codecs=vp9", extension: "webm" },
  { mimeType: "video/webm;codecs=vp8", extension: "webm" },
  { mimeType: "video/webm", extension: "webm" },
];

function elegirFormato() {
  for (const f of FORMATOS) {
    if (MediaRecorder.isTypeSupported(f.mimeType)) return f;
  }
  return null;
}

export function crearGrabador({ alEstado }) {
  const formato = elegirFormato();
  let grabador = null;
  let arranque = 0;

  const socket = crearSocket({
    ruta: "/grabacion",
    alMensaje: ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.type === "conservado") {
        alEstado({ estado: "conservado", archivo: msg.archivo, bytes: msg.bytes });
      } else if (msg.type === "guardado") {
        alEstado({ estado: "guardado", archivo: msg.archivo, bytes: msg.bytes });
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
