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
    await subirCalidad();
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

// El encoder arranca con un tope de un par de Mbps, pensado para internet.
// En una LAN sobra ancho de banda, asi que lo levantamos. maintain-resolution
// le dice que ante un apreton sacrifique fluidez antes que nitidez, que es lo
// que uno quiere cuando esta mirando el encuadre.
const BITRATE_MAXIMO = 12_000_000;

async function subirCalidad() {
  const emisor = pc.getSenders().find((s) => s.track && s.track.kind === "video");
  if (!emisor) return;

  try {
    const params = emisor.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = BITRATE_MAXIMO;
    params.encodings[0].maxFramerate = 30;
    delete params.encodings[0].scaleResolutionDownBy;
    params.degradationPreference = "maintain-resolution";
    await emisor.setParameters(params);
  } catch (err) {
    // Safari ignora parte de esto segun la version; no es fatal.
    console.warn("setParameters:", err);
  }
}

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

    // iOS no siempre arranca solo con autoplay aunque este muted+playsinline,
    // y cuando no arranca no avisa: queda un rectangulo negro.
    try {
      await preview.play();
    } catch (err) {
      decir(`El preview no arranco (${err.name}). El envio sigue igual.`, true);
    }

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

// Un toque sobre el cartel muestra el estado real del elemento de video.
// Sin consola en el telefono, esta es la unica forma de ver por que no pinta.
estado.addEventListener("click", (e) => {
  e.stopPropagation();
  const v = preview;
  decir(
    `video ${v.videoWidth}x${v.videoHeight} readyState=${v.readyState} ` +
      `paused=${v.paused} pistas=${v.srcObject ? v.srcObject.getTracks().length : 0}`
  );
});

function armar() {
  document.body.addEventListener("click", start, { once: true });
}

armar();
