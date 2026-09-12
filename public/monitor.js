import { ICE_SERVERS } from "../shared/config.js";

const remote = document.getElementById("remote");
const estado = document.getElementById("estado");

function decir(texto, esError = false) {
  estado.textContent = texto;
  estado.classList.toggle("error", esError);
  estado.classList.remove("oculto");
}

const proto = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${proto}://${location.host}`);

let pc = null;
// Los candidatos del telefono pueden llegar mientras todavia estamos
// procesando la oferta. addIceCandidate antes del setRemoteDescription tira,
// asi que los guardamos hasta tener descripcion remota.
let hayRemota = false;
let candidatosEnEspera = [];

// Cada oferta nueva es una sesion nueva: si recargas la pagina del telefono,
// la conexion vieja ya no sirve y reusarla deja el monitor en negro.
function nuevaConexion() {
  if (pc) pc.close();
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
      ws.send(JSON.stringify({ type: "ice", to: "phone", from: "monitor", candidate: e.candidate }));
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === "failed" || s === "disconnected") decir(`Conexion ${s}`, true);
  };

  return pc;
}

ws.onopen = () => ws.send(JSON.stringify({ type: "register", role: "monitor" }));
ws.onerror = () => decir("No se pudo conectar al servidor", true);
ws.onclose = () => decir("Se corto la conexion con el servidor", true);

ws.onmessage = async ({ data }) => {
  const msg = JSON.parse(data);

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
    ws.send(JSON.stringify({ type: "answer", to: "phone", answer }));
  } else if (msg.type === "ice" && msg.from !== "monitor") {
    if (pc && hayRemota) await pc.addIceCandidate(msg.candidate);
    else candidatosEnEspera.push(msg.candidate);
  }
};

// Doble click o F para pantalla completa.
function alternarPantallaCompleta() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}
remote.addEventListener("dblclick", alternarPantallaCompleta);
window.addEventListener("keydown", (e) => {
  if (e.key === "f" || e.key === "F") alternarPantallaCompleta();
});
