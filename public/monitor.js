import { ICE_SERVERS } from "../shared/config.js";
import { crearSocket } from "../shared/socket.js";

const remote = document.getElementById("remote");
const estado = document.getElementById("estado");

function decir(texto, esError = false) {
  estado.textContent = texto;
  estado.classList.toggle("error", esError);
  estado.classList.remove("oculto");
}

let pc = null;
// Los candidatos del telefono pueden llegar mientras todavia estamos
// procesando la oferta. addIceCandidate antes del setRemoteDescription tira,
// asi que los guardamos hasta tener descripcion remota.
let hayRemota = false;
let candidatosEnEspera = [];

// Cada oferta nueva es una sesion nueva: si el telefono se reconecta, la
// conexion vieja ya no sirve y reusarla deja el monitor en negro.
function nuevaConexion() {
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.close();
  }
  hayRemota = false;
  candidatosEnEspera = [];

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.ontrack = (e) => {
    remote.srcObject = e.streams[0];
    remote.play().catch(() => {});
    decir("Recibiendo");
    setTimeout(() => estado.classList.add("oculto"), 2000);
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.enviar({ type: "ice", to: "phone", from: "monitor", candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    // El que rearma es el telefono, que es el que emite la oferta. Aca solo
    // informamos; si no vuelve, el aviso de "peer" lo va a disparar.
    if (s === "failed") decir("Se cayo el video, esperando al telefono...", true);
    else if (s === "disconnected") decir("Video interrumpido...", true);
  };

  return pc;
}

const socket = crearSocket({
  alAbrir: () => socket.enviar({ type: "register", role: "monitor" }),
  alMensaje: async ({ data }) => {
    const msg = JSON.parse(data);

    if (msg.type === "peer" && msg.role === "phone") {
      if (!msg.presente) decir("El telefono se desconecto, esperando...", true);
      else decir("El telefono volvio, negociando...");
      return;
    }

    if (msg.type === "offer") {
      decir("Oferta recibida, negociando...");
      const conexion = nuevaConexion();
      await conexion.setRemoteDescription(msg.offer);
      hayRemota = true;
      while (candidatosEnEspera.length) {
        await conexion.addIceCandidate(candidatosEnEspera.shift());
      }
      const answer = await conexion.createAnswer();
      await conexion.setLocalDescription(answer);
      socket.enviar({ type: "answer", to: "phone", answer });
      return;
    }

    if (msg.type === "ice" && msg.from !== "monitor") {
      if (pc && hayRemota) {
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch {
          // Candidato de una negociacion vencida.
        }
      } else {
        candidatosEnEspera.push(msg.candidate);
      }
    }
  },
  alCambiarEstado: (est, detalle) => {
    if (est === "reconectando") decir(`Reconectando al servidor (intento ${detalle.intentos})...`, true);
    else if (est === "cerrado") decir("Se corto la conexion con el servidor, reintentando...", true);
  },
});

// ------------------------------------------------------------ estadisticas
// Lo que realmente esta llegando, no lo que pedimos. Tecla S para verlo.
const panel = document.getElementById("stats");
let previo = null;

async function medir() {
  if (!pc || panel.classList.contains("oculto")) return;

  const reporte = await pc.getStats();
  let video = null;
  let codec = null;
  const codecs = new Map();

  reporte.forEach((s) => {
    if (s.type === "codec") codecs.set(s.id, s);
    if (s.type === "inbound-rtp" && s.kind === "video") video = s;
  });
  if (!video) return;
  if (video.codecId) codec = codecs.get(video.codecId);

  let kbps = 0;
  if (previo && video.timestamp > previo.timestamp) {
    const segundos = (video.timestamp - previo.timestamp) / 1000;
    kbps = ((video.bytesReceived - previo.bytesReceived) * 8) / segundos / 1000;
  }
  previo = video;

  const nombreCodec = codec ? codec.mimeType.replace("video/", "") : "?";
  const perdidos = video.packetsLost ?? 0;
  const recibidos = video.packetsReceived ?? 0;
  const porcentajePerdida = recibidos ? (100 * perdidos) / (recibidos + perdidos) : 0;

  panel.textContent =
    `${video.frameWidth || "?"}x${video.frameHeight || "?"}  ` +
    `${(video.framesPerSecond ?? 0).toFixed(0)} fps\n` +
    `${(kbps / 1000).toFixed(2)} Mbps   ${nombreCodec}\n` +
    `perdida ${porcentajePerdida.toFixed(2)}%   jitter ${((video.jitter ?? 0) * 1000).toFixed(0)} ms\n` +
    `descartados ${video.framesDropped ?? 0}   nack ${video.nackCount ?? 0}`;
}

setInterval(medir, 1000);

window.addEventListener("keydown", (e) => {
  if (e.key === "s" || e.key === "S") {
    panel.classList.toggle("oculto");
    previo = null;
  }
});

// Doble click o F para pantalla completa.
function alternarPantallaCompleta() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}
remote.addEventListener("dblclick", alternarPantallaCompleta);
window.addEventListener("keydown", (e) => {
  if (e.key === "f" || e.key === "F") alternarPantallaCompleta();
});
