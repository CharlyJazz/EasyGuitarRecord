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
const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

// Los candidatos del telefono pueden llegar mientras todavia estamos
// procesando la oferta. addIceCandidate antes del setRemoteDescription tira,
// asi que los guardamos hasta tener descripcion remota.
let hayRemota = false;
const candidatosEnEspera = [];

pc.ontrack = (e) => {
  remote.srcObject = e.streams[0];
  decir("Recibiendo");
  setTimeout(() => estado.classList.add("oculto"), 2000);
};

ws.onopen = () => ws.send(JSON.stringify({ type: "register", role: "monitor" }));
ws.onerror = () => decir("No se pudo conectar al servidor", true);

ws.onmessage = async ({ data }) => {
  const msg = JSON.parse(data);

  if (msg.type === "offer") {
    decir("Oferta recibida, negociando...");
    await pc.setRemoteDescription(msg.offer);
    hayRemota = true;
    while (candidatosEnEspera.length) {
      await pc.addIceCandidate(candidatosEnEspera.shift());
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: "answer", to: "phone", answer }));
  } else if (msg.type === "ice" && msg.from !== "monitor") {
    if (hayRemota) await pc.addIceCandidate(msg.candidate);
    else candidatosEnEspera.push(msg.candidate);
  }
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

// Doble click o F para pantalla completa.
function alternarPantallaCompleta() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}
remote.addEventListener("dblclick", alternarPantallaCompleta);
window.addEventListener("keydown", (e) => {
  if (e.key === "f" || e.key === "F") alternarPantallaCompleta();
});
