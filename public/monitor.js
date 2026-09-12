import { ICE_SERVERS } from "../shared/config.js";
import { crearSocket } from "../shared/socket.js";
import { crearDetectorDeGestos } from "./gestos.js";
import { crearGrabador } from "./grabacion.js";
import { registrar, ponerEtiqueta } from "../shared/log.js";

ponerEtiqueta("monitor");

const remote = document.getElementById("remote");
const estado = document.getElementById("estado");

function decir(texto, esError = false) {
  estado.textContent = texto;
  estado.classList.toggle("error", esError);
  estado.classList.remove("oculto");
}

const tocarParaVer = document.getElementById("tocarParaVer");

// El elemento tiene que estar silenciado o Chrome no lo deja arrancar solo, y
// se queda en pausa mostrando negro con los cuadros ya cargados.
remote.muted = true;

async function reproducir(motivo) {
  if (!remote.srcObject) return;
  try {
    await remote.play();
    tocarParaVer.classList.remove("visible");
    registrar(`video: reproduciendo (${motivo})`);
  } catch (err) {
    // Este error es el que explica la pantalla negra: no se traga nunca.
    registrar(`video: play() rechazado (${motivo}): ${err.name} ${err.message}`);
    tocarParaVer.classList.add("visible");
  }
}

tocarParaVer.addEventListener("click", () => reproducir("clic del usuario"));

// Vigilancia: si el elemento queda en pausa con cuadros disponibles, algo lo
// freno y hay que insistir. Sin esto la pagina se queda negra en silencio.
setInterval(() => {
  if (remote.srcObject && remote.paused && remote.readyState >= 2) {
    registrar(`video: quedo en pausa (ready=${remote.readyState}), reintentando`);
    reproducir("estaba en pausa");
  }
}, 2000);

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
    reproducir("llego el track");
    decir("Recibiendo");
    setTimeout(() => estado.classList.add("oculto"), 2000);
    arrancarGestos();
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
    // El video va peer-to-peer: una vez negociado no pasa por el servidor, y
    // sigue andando igual aunque la señalizacion se caiga. Decir "se corto la
    // conexion" mientras el video se ve perfecto solo asusta al pedo.
    const videoVivo = !!pc && pc.connectionState === "connected";

    if (est === "abierto") {
      if (videoVivo) {
        decir("Recibiendo");
        setTimeout(() => estado.classList.add("oculto"), 2000);
      }
      return;
    }

    if (est === "reconectando" || est === "cerrado") {
      const intento = detalle?.intentos ? ` (intento ${detalle.intentos})` : "";
      decir(
        videoVivo
          ? `Sin servidor${intento} — el video sigue andando`
          : `Reconectando al servidor${intento}...`,
        !videoVivo   // rojo solo cuando de verdad perdiste algo
      );
    }
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

function alternarEstadisticas() {
  panel.classList.toggle("oculto");
  previo = null;   // el calculo de bitrate necesita dos muestras seguidas
}

// Doble click o F para pantalla completa.
function alternarPantallaCompleta() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}
remote.addEventListener("dblclick", alternarPantallaCompleta);

// --------------------------------------------------------- gestos y grabacion
// palma abierta -> empezar, o reiniciar la toma en curso
// pulgar arriba -> guardar
// pulgar abajo  -> descartar
const gestoTexto = document.getElementById("gestoTexto");
const gestoBarra = document.getElementById("gestoBarra");
const rec = document.getElementById("rec");
const reloj = document.getElementById("reloj");
const aviso = document.getElementById("aviso");

const ETIQUETA_GESTO = {
  high_five: "palma abierta",
  pulgar_arriba: "pulgar arriba",
  pulgar_abajo: "pulgar abajo",
};

let detector = null;
let ocupado = false;   // evita que dos gestos seguidos se pisen

const grabador = crearGrabador({
  alEstado: (e) => {
    registrar(`grabacion: ${e.estado} ${e.archivo || e.detalle || ""}`);
    if (e.estado === "guardado") {
      avisar(`Guardado: ${e.archivo} (${(e.bytes / 1e6).toFixed(1)} MB)`, "bueno");
      refrescarGaleria();
    } else if (e.estado === "descartado") {
      avisar("Toma descartada", "malo");
    } else if (e.estado === "error") {
      avisar(`Error de grabacion: ${e.detalle}`, "malo");
    }
  },
});

let temporizadorAviso = null;
function avisar(texto, tono = "") {
  aviso.textContent = texto;
  aviso.className = `visible ${tono}`;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { aviso.className = ""; }, 3500);
}

function pintarReloj() {
  rec.classList.toggle("activo", grabador.grabando);
  if (!grabador.grabando) return;
  const s = Math.floor(grabador.segundos);
  reloj.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
setInterval(pintarReloj, 250);

function hayVideo() {
  return remote.srcObject && remote.srcObject.getVideoTracks().some((t) => t.readyState === "live");
}

async function empezarToma(reinicio) {
  if (!hayVideo()) {
    avisar("No hay video del telefono todavia", "malo");
    return;
  }
  if (grabador.grabando) await grabador.terminar("descartar");
  if (grabador.iniciar(remote.srcObject)) {
    avisar(reinicio ? "Toma reiniciada" : "Grabando", "");
  }
}

async function alGesto(nombre) {
  registrar(`accion ${nombre}: grabando=${grabador.grabando} ocupado=${ocupado} ` +
    `video=${hayVideo()} formato=${grabador.formato?.mimeType || "ninguno"}`);
  if (ocupado) return;
  ocupado = true;
  try {
    if (nombre === "high_five") {
      await empezarToma(grabador.grabando);
    } else if (nombre === "pulgar_arriba") {
      if (!grabador.grabando) avisar("No hay ninguna toma grabando", "malo");
      else await grabador.terminar("guardar");
    } else if (nombre === "pulgar_abajo") {
      if (!grabador.grabando) avisar("No hay ninguna toma grabando", "malo");
      else await grabador.terminar("descartar");
    }
  } finally {
    ocupado = false;
  }
}

function alCambiarCandidato(nombre, avance, crudo) {
  gestoBarra.style.width = `${Math.round(100 * avance)}%`;
  // El crudo va siempre a la vista: si el modelo ve la mano pero la llama
  // distinto, o si el que la reconocio fue el respaldo geometrico, se nota sin
  // abrir la consola.
  const detalle = crudo
    ? `${crudo.categoria} ${crudo.score.toFixed(2)} via ${crudo.origen}`
    : "sin gesto";
  gestoTexto.textContent = nombre
    ? `${ETIQUETA_GESTO[nombre]}  ${Math.round(100 * avance)}%  (${detalle})`
    : `Listo  (${detalle})`;
}

async function arrancarGestos() {
  registrar(`arrancarGestos: detector=${detector ? "ya existe" : "hay que crearlo"} ` +
    `video=${remote.videoWidth}x${remote.videoHeight} ready=${remote.readyState}`);
  if (detector) {
    detector.arrancar();
    return;
  }
  try {
    gestoTexto.textContent = "Gestos: cargando modelo...";
    detector = await crearDetectorDeGestos({ video: remote, alGesto, alCambiarCandidato });
    detector.arrancar();
    gestoTexto.textContent = "Gestos: listos";
  } catch (err) {
    gestoTexto.textContent = `Gestos: no cargaron (${err.message})`;
    registrar(`gestos: NO CARGARON ${err.name}: ${err.message}`);
    registrar(`gestos: stack ${String(err.stack || "").slice(0, 400)}`);
    console.error(err);
  }
}



// --------------------------------------------------------------------- galeria
// Las tomas guardadas, a la izquierda. Un clic abre la toma en su propia
// ventana, para poder revisarla sin cortar el monitoreo en vivo.
const galeriaGrid = document.getElementById("galeriaGrid");
const galeriaCuenta = document.getElementById("galeriaCuenta");

function tamaño(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}

// El nombre ya trae la fecha: toma-2026-09-12_16-28-31.mp4
function cuando(nombre) {
  const m = nombre.match(/^toma-\d{4}-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[1]} ${m[3]}:${m[4]}:${m[5]}` : nombre;
}

function abrirToma(nombre) {
  // Ventana propia y no una pestaña: la idea es mirarla al lado del monitor.
  window.open(`/grabaciones/${encodeURIComponent(nombre)}`, nombre, "width=900,height=640");
}

async function borrarToma(nombre) {
  if (!confirm(`¿Mover a la papelera?

${nombre}`)) return;

  try {
    const respuesta = await fetch(`/api/grabaciones/${encodeURIComponent(nombre)}`, {
      method: "DELETE",
    });
    if (!respuesta.ok) {
      const detalle = await respuesta.json().catch(() => ({}));
      throw new Error(detalle.error || respuesta.status);
    }
    registrar(`galeria: ${nombre} a la papelera`);
    avisar("Movida a grabaciones/.papelera", "");
    refrescarGaleria();
  } catch (err) {
    avisar(`No se pudo borrar: ${err.message}`, "malo");
    registrar(`galeria: fallo el borrado de ${nombre}: ${err.message}`);
  }
}

async function refrescarGaleria() {
  let tomas;
  try {
    const respuesta = await fetch("/api/grabaciones");
    tomas = await respuesta.json();
  } catch (err) {
    registrar(`galeria: no se pudo listar (${err.message})`);
    return;
  }

  galeriaCuenta.textContent = tomas.length ? `${tomas.length}` : "";
  galeriaGrid.textContent = "";

  if (!tomas.length) {
    const vacio = document.createElement("div");
    vacio.id = "galeriaVacia";
    vacio.textContent = "Todavia no hay tomas guardadas. Palma abierta para empezar una, pulgar arriba para guardarla.";
    galeriaGrid.append(vacio);
    return;
  }

  for (const toma of tomas) {
    const tarjeta = document.createElement("div");
    tarjeta.className = "toma";
    tarjeta.title = toma.nombre;

    // El fragmento #t=0.5 hace que el navegador muestre ese instante como
    // miniatura, sin tener que generar ni guardar imagenes aparte.
    const mini = document.createElement("video");
    mini.src = `/grabaciones/${encodeURIComponent(toma.nombre)}#t=0.5`;
    mini.preload = "metadata";
    mini.muted = true;
    mini.playsInline = true;

    const pie = document.createElement("div");
    pie.className = "pie";
    const titulo = document.createElement("b");
    titulo.textContent = cuando(toma.nombre);
    const detalle = document.createElement("span");
    detalle.textContent = tamaño(toma.bytes);
    pie.append(titulo, detalle);

    const acciones = document.createElement("div");
    acciones.className = "acciones";

    // Descargar es un ancla comun con download: el navegador lo resuelve solo
    // y respeta el nombre del archivo.
    const bajar = document.createElement("a");
    bajar.href = `/grabaciones/${encodeURIComponent(toma.nombre)}`;
    bajar.download = toma.nombre;
    bajar.textContent = "⬇ Guardar";
    bajar.title = "Descargar una copia";
    bajar.addEventListener("click", (e) => e.stopPropagation());

    const borrar = document.createElement("button");
    borrar.className = "borrar";
    borrar.textContent = "🗑 Borrar";
    borrar.title = "Mover a la papelera";
    borrar.addEventListener("click", (e) => {
      e.stopPropagation();   // si no, tambien abriria la ventana de la toma
      borrarToma(toma.nombre);
    });

    acciones.append(bajar, borrar);
    tarjeta.append(mini, pie, acciones);
    tarjeta.addEventListener("click", () => abrirToma(toma.nombre));
    galeriaGrid.append(tarjeta);
  }
}

refrescarGaleria();
// Por si alguien mueve archivos a mano en la carpeta.
setInterval(refrescarGaleria, 15000);



// En pantalla completa uno esta mirando el encuadre: fuera la galeria y la
// barra de botones, que para eso quedan los gestos y las teclas.
document.addEventListener("fullscreenchange", () => {
  const completa = !!document.fullscreenElement;
  document.body.classList.toggle("sinGaleria", completa);
  document.body.classList.toggle("sinCabecera", completa);
});

// ------------------------------------------------------------------- cabecera
// Los mismos comandos que los gestos, a mano. Sirve para probar sin ponerse
// delante de la camara, y para cuando uno ya esta sentado frente a la PC.
const btnGrabar = document.getElementById("btnGrabar");
const btnGuardar = document.getElementById("btnGuardar");
const btnDescartar = document.getElementById("btnDescartar");

btnGrabar.addEventListener("click", () => alGesto("high_five"));
btnGuardar.addEventListener("click", () => alGesto("pulgar_arriba"));
btnDescartar.addEventListener("click", () => alGesto("pulgar_abajo"));

document.getElementById("btnGaleria")
  .addEventListener("click", () => document.body.classList.toggle("sinGaleria"));
document.getElementById("btnStats").addEventListener("click", alternarEstadisticas);
document.getElementById("btnPantalla").addEventListener("click", alternarPantallaCompleta);

// Un boton que no se puede usar tiene que verse asi, en vez de no hacer nada
// al tocarlo.
function pintarBotones() {
  const grabando = grabador.grabando;
  const listo = hayVideo();

  btnGrabar.disabled = !listo;
  btnGrabar.textContent = grabando ? "⟲ Reiniciar" : "● Grabar";
  btnGuardar.disabled = !grabando;
  btnDescartar.disabled = !grabando;
}
setInterval(pintarBotones, 250);
pintarBotones();

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  const tecla = e.key.toLowerCase();

  if (tecla === "r") alGesto("high_five");
  else if (tecla === "g") alGesto("pulgar_arriba");
  else if (tecla === "d") alGesto("pulgar_abajo");
  else if (tecla === "s") alternarEstadisticas();
  else if (tecla === "f") alternarPantallaCompleta();
  else if (tecla === "v") document.body.classList.toggle("sinGaleria");
  else if (tecla === "h") document.body.classList.toggle("sinCabecera");
});
