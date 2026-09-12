import { ICE_SERVERS } from "../shared/config.js";

const preview = document.getElementById("preview");
const estado = document.getElementById("estado");

function decir(texto, esError = false) {
  estado.textContent = texto;
  estado.classList.toggle("error", esError);
}

// wss cuando la pagina es https, que es siempre en este setup. Un ws:// desde
// una pagina https lo bloquea el navegador por mixed content.
const proto = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${proto}://${location.host}`);
const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

ws.onopen = () => ws.send(JSON.stringify({ type: "register", role: "phone" }));
ws.onerror = () => decir("No se pudo conectar al servidor", true);

ws.onmessage = async ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.type === "answer") {
    await pc.setRemoteDescription(msg.answer);
  } else if (msg.type === "ice" && msg.from !== "phone") {
    await pc.addIceCandidate(msg.candidate);
  }
};

pc.onicecandidate = (e) => {
  if (e.candidate) {
    ws.send(JSON.stringify({ type: "ice", to: "monitor", from: "phone", candidate: e.candidate }));
  }
};

pc.onconnectionstatechange = () => {
  const s = pc.connectionState;
  if (s === "connected") decir("Transmitiendo a la PC");
  else if (s === "failed" || s === "disconnected") decir(`Conexion ${s}`, true);
};

async function pedirCamara() {
  const base = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  try {
    // exact fuerza la trasera; si el iPhone no puede combinarla con esas
    // resoluciones tira OverconstrainedError, y ahi aflojamos a ideal.
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { exact: "environment" }, ...base },
      audio: false,
    });
  } catch (err) {
    if (err.name !== "OverconstrainedError") throw err;
    decir("Reintentando sin forzar resolucion...");
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
  }
}

async function start() {
  // Safari exige que esto salga de un gesto del usuario.
  if (!navigator.mediaDevices?.getUserMedia) {
    decir("Este navegador no expone la camara. Tiene que ser https.", true);
    return;
  }

  try {
    decir("Pidiendo camara...");
    const stream = await pedirCamara();

    preview.srcObject = stream;
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    const { width, height } = stream.getVideoTracks()[0].getSettings();
    decir(`Camara ${width}x${height} - negociando...`);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: "offer", to: "monitor", offer }));
  } catch (err) {
    decir(`${err.name}: ${err.message}`, true);
    armar(); // que pueda reintentar con otro toque
  }
}

function armar() {
  document.body.addEventListener("click", start, { once: true });
}

armar();
