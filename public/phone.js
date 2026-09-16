import { ICE_SERVERS } from "../shared/config.js";
import { crearSocket, mantenerPantallaEncendida } from "../shared/socket.js";
import { registrar, ponerEtiqueta } from "../shared/log.js";

ponerEtiqueta("iphone");

const preview = document.getElementById("preview");
const estado = document.getElementById("estado");

function decir(texto, esError = false) {
  estado.textContent = texto;
  estado.classList.toggle("error", esError);
  registrar(esError ? `AVISO ${texto}` : texto);
}

// El encoder arranca con un tope de un par de Mbps, pensado para internet.
// En una LAN sobra ancho de banda, asi que lo levantamos. maintain-resolution
// le dice que ante un apreton sacrifique fluidez antes que nitidez, que es lo
// que uno quiere cuando esta mirando el encuadre.
const BITRATE_MAXIMO = 12_000_000;

let stream = null;       // la camara se pide UNA vez y sobrevive a las caidas
let pc = null;
let monitorPresente = false;
let renegociando = false;

// ------------------------------------------------------------------ señalizacion
const socket = crearSocket({
  alAbrir: () => {
    socket.enviar({ type: "register", role: "phone" });
    // Si ya teniamos camara, esto es una reconexion: hay que rearmar el video.
    if (stream) renegociar("socket reconectado");
  },
  alMensaje: async ({ data }) => {
    const msg = JSON.parse(data);

    if (msg.type === "peer" && msg.role === "monitor") {
      monitorPresente = msg.presente;
      if (msg.presente && stream) renegociar("el monitor volvio");
      else if (!msg.presente) decir("Esperando al monitor de la PC...");
      return;
    }

    if (msg.type === "answer" && pc) {
      await pc.setRemoteDescription(msg.answer);
      await subirCalidad();
      return;
    }

    if (msg.type === "ice" && msg.from !== "phone" && pc) {
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch {
        // Candidato de una negociacion ya vencida: se descarta sin ruido.
      }
    }
  },
  alCambiarEstado: (est, detalle) => {
    // Igual que en el monitor: el video no pasa por el servidor, asi que la
    // señalizacion caida no significa que se corto la transmision.
    const videoVivo = !!pc && pc.connectionState === "connected";

    if (est === "abierto") {
      if (videoVivo) decir("Transmitiendo a la PC");
      return;
    }

    if (est === "reconectando" || est === "cerrado") {
      const intento = detalle?.intentos ? ` (intento ${detalle.intentos})` : "";
      decir(
        videoVivo
          ? `Sin servidor${intento} — seguis transmitiendo`
          : `Reconectando${intento}...`,
        !videoVivo
      );
    }
  },
});

// ------------------------------------------------------------------- webrtc
function nuevaConexion() {
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.close();
  }

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.enviar({ type: "ice", to: "monitor", from: "phone", candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === "connected") decir("Transmitiendo a la PC");
    else if (s === "failed") {
      decir("Se cayo el video, rearmando...", true);
      renegociar("la conexion fallo");
    } else if (s === "disconnected") {
      decir("Video interrumpido, esperando...", true);
      // disconnected suele recuperarse solo; si en 4 segundos no volvio,
      // rearmamos en vez de quedarnos colgados para siempre.
      setTimeout(() => {
        if (pc && pc.connectionState !== "connected") renegociar("no se recupero");
      }, 4000);
    }
  };

  return pc;
}

async function renegociar(motivo) {
  if (!stream || renegociando) return;
  if (!socket.listo) return;

  renegociando = true;
  try {
    decir(`Rearmando el video (${motivo})...`);
    const conexion = nuevaConexion();
    for (const track of stream.getTracks()) conexion.addTrack(track, stream);

    const offer = await conexion.createOffer();
    await conexion.setLocalDescription(offer);
    socket.enviar({ type: "offer", to: "monitor", offer });
  } catch (err) {
    decir(`No se pudo rearmar: ${err.message}`, true);
  } finally {
    renegociando = false;
  }
}

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

// ------------------------------------------------------------------- camara

// iOS, si no le decis lo contrario, mete la cadena de procesado de VOZ:
// cancelacion de eco, supresion de ruido y control automatico de ganancia.
// Para hablar esta bien; para una guitarra es destructivo, porque le come los
// transitorios del ataque y le bombea el volumen entre frase y frase. Estos
// tres false son lo que separa "se escucha" de "sirve para publicar".
const AUDIO_MUSICA = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  sampleRate: { ideal: 48000 },
  channelCount: { ideal: 2 },
};

async function pedirCamara() {
  const base = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };

  async function pedir(audio) {
    try {
      // exact fuerza la trasera; si el iPhone no puede combinarla con esas
      // resoluciones tira OverconstrainedError, y ahi aflojamos a ideal.
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { exact: "environment" }, ...base },
        audio,
      });
    } catch (err) {
      if (err.name !== "OverconstrainedError") throw err;
      decir("Reintentando sin forzar resolucion...");
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio,
      });
    }
  }

  try {
    return await pedir(AUDIO_MUSICA);
  } catch (err) {
    // getUserMedia es todo o nada: si negas el microfono, tambien perdes la
    // camara. Una toma muda es mucho mejor que ninguna toma, asi que se
    // reintenta sin audio en vez de dejarlo morir.
    if (err.name !== "NotAllowedError" && err.name !== "NotFoundError") throw err;
    decir(`Sin microfono (${err.name}): la toma va a salir muda.`, true);
    return await pedir(false);
  }
}

async function start() {
  // Safari exige que esto salga de un gesto del usuario.
  if (!navigator.mediaDevices?.getUserMedia) {
    decir("Este navegador no expone la camara. Tiene que ser https.", true);
    armar();
    return;
  }

  try {
    decir("Pidiendo camara...");
    stream = await pedirCamara();

    preview.srcObject = stream;
    // iOS no siempre arranca solo con autoplay aunque este muted+playsinline,
    // y cuando no arranca no avisa: queda un rectangulo negro.
    try {
      await preview.play();
    } catch (err) {
      decir(`El preview no arranco (${err.name}). El envio sigue igual.`, true);
    }

    // Sin esto la pantalla se bloquea sola, iOS suspende la pagina y se corta
    // la camara. Es la causa mas comun de "se desconecto de la nada".
    await mantenerPantallaEncendida((err) =>
      console.warn("wakeLock no disponible:", err.name)
    );

    // Una pista que muere (camara tomada por otra app, permiso revocado) no
    // dispara ningun evento de conexion: hay que mirarla aparte.
    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => {
        // Que se muera el microfono no es razon para tirar abajo el video.
        if (track.kind !== "video") {
          decir("Se corto el microfono: sigue el video, pero mudo.", true);
          return;
        }
        decir("La camara se cerro. Tocá para volver a pedirla.", true);
        stream = null;
        armar();
      });
    }

    const { width, height } = stream.getVideoTracks()[0].getSettings();
    decir(`Camara ${width}x${height} - negociando...`);

    await renegociar("primera conexion");
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
      `paused=${v.paused} pc=${pc ? pc.connectionState : "-"} ` +
      `socket=${socket.listo ? "ok" : "caido"} monitor=${monitorPresente}`
  );
});

function armar() {
  document.body.addEventListener("click", start, { once: true });
}

armar();
