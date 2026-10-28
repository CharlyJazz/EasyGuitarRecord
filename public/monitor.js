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
    // Video y audio llegan en el mismo stream, cada uno con su ontrack.
    // Reasignar el mismo stream recarga el <video> y corta el play() anterior.
    if (remote.srcObject === e.streams[0]) return;
    remote.srcObject = e.streams[0];
    reproducir("llego el track");
    decir("Recibiendo");
    setTimeout(() => estado.classList.add("oculto"), 2000);
    if (gestosEncendidos) arrancarGestos();
    arrancarSiHaceFalta();
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

// Ademas de pintar el panel, esto vigila si el video ya se estabilizo. WebRTC
// arranca bajo y sube el bitrate de a poco: grabar durante esa rampa es lo que
// metia los huecos que despues descuadran la toma en el editor. Medido sobre la
// toma del 18/09: hueco de 2.500 ms en el segundo 3, cero cuadros en el 4, y
// pasado el segundo 10 la captura queda clavada en 30 fps.
//
// Por eso la muestra corre siempre, aunque el panel este escondido: si solo
// midiera con el panel abierto, el arranque de la grabacion dependeria de si
// alguien aprieta S.
const MUESTRAS_ESTABLE = 3;      // segundos seguidos en verde que hacen falta
const FPS_MINIMO = 24;         // el tramo estable medido nunca bajo de 28; la rampa nunca paso de 16
const ESPERA_MAXIMA_MS = 10000;  // techo: antes perder calidad que perder la toma

let historialFps = [];
let esperandoDesde = 0;
let pcMedido = null;

function videoEstable() {
  return historialFps.length >= MUESTRAS_ESTABLE && historialFps.every((f) => f >= FPS_MINIMO);
}

async function medir() {
  if (!pc) return;

  // Conexion nueva: el historial de la anterior no dice nada de esta, y
  // reusarlo dejaria arrancar la grabacion en plena rampa de la reconexion.
  if (pc !== pcMedido) {
    pcMedido = pc;
    historialFps = [];
    esperandoDesde = 0;
    previo = null;
  }

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

  historialFps.push(video.framesPerSecond ?? 0);
  if (historialFps.length > MUESTRAS_ESTABLE) historialFps.shift();

  if (panel.classList.contains("oculto")) return;

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
// La grabacion corre sola mientras haya video. Cada pulgar cierra la toma en
// curso y arranca la siguiente, sin que haya que decir "empeza" en ningun
// momento:
//
//   pulgar arriba -> guarda la toma y sigue grabando la proxima
//   pulgar abajo  -> la tira y empieza de nuevo
//
// Hubo una version con palma abierta para reiniciar y no sobrevivio: unos
// dedos sobre el diapason son cuatro dedos estirados, igual que una palma
// abierta, y reiniciaba las tomas solo.
const gestoTexto = document.getElementById("gestoTexto");
const gestoBarra = document.getElementById("gestoBarra");
const rec = document.getElementById("rec");
const reloj = document.getElementById("reloj");
const aviso = document.getElementById("aviso");

const ETIQUETA_GESTO = {
  pulgar_arriba: "pulgar arriba",
  pulgar_abajo: "pulgar abajo",
};

let detector = null;
// La carga en vuelo. ontrack salta una vez por track, y con el audio del
// telefono son dos: sin esto las dos llamadas veian `detector` vacio mientras
// el modelo cargaba y armaban dos reconocedores, que se turnaban el hilo
// principal con ~150 ms por inferencia y trababan el video.
let cargandoDetector = null;
let ocupado = false;   // evita que dos gestos seguidos se pisen

const grabador = crearGrabador({
  alEstado: (e) => {
    registrar(`grabacion: ${e.estado} ${e.archivo || e.detalle || ""}`);
    if (e.estado === "guardado") {
      // metodo "crudo" = ffmpeg no estaba o fallo, y el archivo quedo
      // fragmentado: se abre en un reproductor pero un editor lo rechaza.
      if (e.metodo === "crudo") {
        avisar(`Guardado SIN convertir: ${e.archivo} -- ${e.detalle}`, "malo");
      } else if (e.metodo === "remux") {
        // Fallo la recodificacion y quedo el archivo tal como llego: se abre en
        // cualquier lado, pero es VFR y el editor lo va a descuadrar.
        avisar(`Guardado VFR: ${e.archivo} -- ${e.detalle}`, "malo");
      } else {
        const como = e.detalle ? ` -- ${e.detalle}` : "";
        avisar(`Guardado: ${e.archivo} (${(e.bytes / 1e6).toFixed(1)} MB)${como}`, "bueno");
      }
      refrescarGaleria();
    } else if (e.estado === "procesando") {
      avisar("Cerrando la toma...");
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

// Se puede parar del todo desde la barra; mientras tanto, si hay video hay
// grabacion.
let enPausa = false;

function arrancarSiHaceFalta() {
  if (enPausa || grabador.grabando || !hayVideo()) {
    esperandoDesde = 0;
    return;
  }

  // No arrancar en la rampa de WebRTC. Con una toma ya en curso esto no cuesta
  // nada: al cerrar con el pulgar el historial ya esta lleno de muestras buenas
  // y la siguiente arranca en el mismo instante, sin hueco.
  if (!videoEstable()) {
    if (!esperandoDesde) esperandoDesde = performance.now();
    if (performance.now() - esperandoDesde < ESPERA_MAXIMA_MS) {
      avisar(`Esperando que el video se estabilice (${historialFps.map((f) => Math.round(f)).join("/") || "-"} fps)`);
      return;
    }
    // Se acabo la paciencia: mejor una toma con la rampa adentro que ninguna.
    registrar(`grabacion: arranca sin estabilizar tras ${ESPERA_MAXIMA_MS} ms (fps ${historialFps.join("/")})`);
    avisar("El video no se estabiliza, grabando igual", "malo");
  }

  esperandoDesde = 0;
  grabador.iniciar(remote.srcObject);
}

// Cerrar una toma y abrir la siguiente en el mismo paso: cualquier hueco entre
// las dos es material perdido, justo cuando uno acaba de decidir seguir.
async function cerrarYSeguir(accion) {
  if (grabador.grabando) await grabador.terminar(accion);
  arrancarSiHaceFalta();
}

async function alGesto(nombre) {
  registrar(`accion ${nombre}: grabando=${grabador.grabando} ocupado=${ocupado} ` +
    `video=${hayVideo()} pausa=${enPausa}`);
  if (ocupado) return;
  ocupado = true;
  try {
    if (!hayVideo()) {
      avisar("No hay video del telefono todavia", "malo");
      return;
    }
    if (nombre === "pulgar_arriba") await cerrarYSeguir("guardar");
    else if (nombre === "pulgar_abajo") await cerrarYSeguir("descartar");
  } finally {
    ocupado = false;
  }
}

// Con video y sin pausa, siempre tiene que haber una toma corriendo. Este
// reintento cubre el arranque, la vuelta de una reconexion y cualquier corte
// del grabador.
setInterval(arrancarSiHaceFalta, 1000);

function alCambiarCandidato(nombre, avance, crudo) {
  gestoBarra.style.width = `${Math.round(100 * avance)}%`;
  // El crudo va siempre a la vista: si el modelo ve la mano pero la llama
  // distinto, se nota sin abrir la consola. Antes esto decia ademas "via
  // modelo/geometria", pero al sacar el respaldo geometrico quedo una sola
  // fuente y el campo dejo de existir.
  const detalle = crudo
    ? `${crudo.categoria} ${crudo.score.toFixed(2)}`
    : "sin gesto";
  gestoTexto.textContent = nombre
    ? `${ETIQUETA_GESTO[nombre]}  ${Math.round(100 * avance)}%  (${detalle})`
    : `Listo  (${detalle})`;
}

async function arrancarGestos() {
  if (!gestosEncendidos) return;
  registrar(`arrancarGestos: detector=${detector ? "ya existe" : "hay que crearlo"} ` +
    `video=${remote.videoWidth}x${remote.videoHeight} ready=${remote.readyState}`);
  if (detector) {
    detector.arrancar();
    return;
  }
  if (cargandoDetector) return;
  try {
    gestoTexto.textContent = "Gestos: cargando modelo...";
    cargandoDetector = crearDetectorDeGestos({ video: remote, alGesto, alCambiarCandidato });
    detector = await cargandoDetector;
    detector.arrancar();
    gestoTexto.textContent = "Gestos: listos";
  } catch (err) {
    gestoTexto.textContent = `Gestos: no cargaron (${err.message})`;
    registrar(`gestos: NO CARGARON ${err.name}: ${err.message}`);
    registrar(`gestos: stack ${String(err.stack || "").slice(0, 400)}`);
    console.error(err);
  } finally {
    cargandoDetector = null;
  }
}



// El modelo de MediaPipe come CPU y no siempre hace falta: grabando con el
// teclado, o probando encuadres, molesta mas de lo que ayuda. La preferencia
// sobrevive al reload, porque si lo apagaste fue por algo y volver a
// encenderlo solo seria pelearse con la pagina.
const CLAVE_GESTOS = "iphone-monitor:gestos";
const btnGestos = document.getElementById("btnGestos");
let gestosEncendidos = leerPreferenciaGestos();

function leerPreferenciaGestos() {
  // Safari en modo privado tira al tocar localStorage; que eso no se lleve
  // puesta la pagina entera.
  try { return localStorage.getItem(CLAVE_GESTOS) !== "no"; } catch { return true; }
}

function pintarInterruptorGestos() {
  btnGestos.classList.toggle("encendido", gestosEncendidos);
  btnGestos.setAttribute("aria-pressed", String(gestosEncendidos));
  document.body.classList.toggle("sinGestos", !gestosEncendidos);
}

async function alternarGestos() {
  gestosEncendidos = !gestosEncendidos;
  try { localStorage.setItem(CLAVE_GESTOS, gestosEncendidos ? "si" : "no"); } catch {}
  pintarInterruptorGestos();
  registrar(`gestos: interruptor ${gestosEncendidos ? "encendido" : "apagado"}`);

  if (!gestosEncendidos) {
    // parar() solo corta el bucle; el detector queda vivo para que volver a
    // encenderlo no vuelva a bajar el modelo.
    detector?.parar();
    gestoTexto.textContent = "Gestos: apagados";
    gestoBarra.style.width = "0%";
    return;
  }
  if (hayVideo()) await arrancarGestos();
  else gestoTexto.textContent = "Gestos: esperando video";
}

btnGestos.addEventListener("click", alternarGestos);
pintarInterruptorGestos();
if (!gestosEncendidos) gestoTexto.textContent = "Gestos: apagados";


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

// "hace 2 minutos", "ayer". El refresco de cada 15 s lo mantiene al dia.
const relativo = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
const ESCALONES = [[60, "second"], [60, "minute"], [24, "hour"], [7, "day"], [4.35, "week"], [12, "month"], [Infinity, "year"]];

function haceCuanto(ms) {
  let valor = (ms - Date.now()) / 1000;
  if (Math.abs(valor) < 45) return "recien";
  for (const [tope, unidad] of ESCALONES) {
    if (Math.abs(valor) < tope) return relativo.format(Math.round(valor), unidad);
    valor /= tope;
  }
}

// Renombrar pone una etiqueta (acordes, lick...) DESPUES de la fecha:
// toma-2026-09-12_16-28-31-lick.mp4. La fecha se queda porque ordena la
// galeria, evita choques entre dos "lick" y es la hora con la que se junta
// la toma con su audio de FL Studio.
const PARTES_DE_TOMA = /^(toma-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})(?:-(.*))?(\.[^.]+)$/;

function etiquetaDe(nombre) {
  const m = nombre.match(PARTES_DE_TOMA);
  return m ? m[2] || "" : nombre.replace(/\.[^.]+$/, "");
}

function nombreConEtiqueta(nombre, etiqueta) {
  const limpia = etiqueta.replace(/[<>:"\/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, " ").trim();
  const m = nombre.match(PARTES_DE_TOMA);
  if (m) return limpia ? `${m[1]}-${limpia}${m[3]}` : `${m[1]}${m[3]}`;
  // Un video que no salio de aca: no hay fecha que conservar.
  return limpia ? `${limpia}${nombre.match(/\.[^.]+$/)[0]}` : nombre;
}

async function renombrarToma(nombre, etiqueta) {
  const nuevo = nombreConEtiqueta(nombre, etiqueta);
  if (nuevo === nombre) return;
  try {
    const respuesta = await fetch(`/api/grabaciones/${encodeURIComponent(nombre)}/renombrar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre: nuevo }),
    });
    if (!respuesta.ok) {
      const detalle = await respuesta.json().catch(() => ({}));
      throw new Error(detalle.error || respuesta.status);
    }
    registrar(`galeria: ${nombre} -> ${nuevo}`);
  } catch (err) {
    avisar(`No se pudo renombrar: ${err.message}`, "malo");
    registrar(`galeria: fallo el renombrado de ${nombre}: ${err.message}`);
  }
}

// Mientras hay un menu abierto o un nombre a medio escribir, el refresco
// periodico no reconstruye la grilla: se llevaria puesto lo que uno esta haciendo.
let galeriaOcupada = false;

function cerrarMenus() {
  for (const menu of galeriaGrid.querySelectorAll(".menu.abierto")) menu.classList.remove("abierto");
  galeriaOcupada = false;
}
document.addEventListener("click", cerrarMenus);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") cerrarMenus(); });

function editarNombre(toma, titulo) {
  const entrada = document.createElement("input");
  entrada.value = etiquetaDe(toma.nombre);
  entrada.placeholder = "acordes, lick...";
  entrada.addEventListener("click", (e) => e.stopPropagation());
  titulo.replaceWith(entrada);
  entrada.focus();
  entrada.select();
  galeriaOcupada = true;

  let terminado = false;
  const terminar = async (guardar) => {
    if (terminado) return;
    terminado = true;
    if (guardar) await renombrarToma(toma.nombre, entrada.value);
    galeriaOcupada = false;
    refrescarGaleria();
  };
  entrada.addEventListener("keydown", (e) => {
    if (e.key === "Enter") terminar(true);
    else if (e.key === "Escape") terminar(false);
  });
  entrada.addEventListener("blur", () => terminar(true));
}

function abrirToma(nombre) {
  // Ventana propia y no una pestaña: la idea es mirarla al lado del monitor.
  window.open(`/grabaciones/${encodeURIComponent(nombre)}`, nombre, "width=900,height=640");
}

// Sin confirmacion a proposito: esto no borra, mueve a grabaciones/.papelera.
// Descartando tomas de a diez, un dialogo por cada una molesta mas de lo que
// protege, y lo que protege de verdad es que el archivo siga estando.
async function borrarToma(nombre) {
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
  if (galeriaOcupada) return;
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
    // Arriba la etiqueta si tiene (si no, la fecha de la toma); abajo hace
    // cuanto y el peso. La fecha exacta queda en el tooltip.
    const etiqueta = etiquetaDe(toma.nombre);
    const titulo = document.createElement("b");
    titulo.textContent = etiqueta || cuando(toma.nombre);
    const detalle = document.createElement("span");
    detalle.textContent = `${haceCuanto(toma.modificado)} · ${tamaño(toma.bytes)}`;
    tarjeta.title = `${toma.nombre}\n${new Date(toma.modificado).toLocaleString()}`;
    pie.append(titulo, detalle);

    // Las acciones van en un menu detras del engranaje.
    const menu = document.createElement("div");
    menu.className = "menu";
    menu.addEventListener("click", (e) => e.stopPropagation());

    // Descargar es un ancla comun con download: el navegador lo resuelve solo
    // y respeta el nombre del archivo.
    const bajar = document.createElement("a");
    bajar.href = `/grabaciones/${encodeURIComponent(toma.nombre)}`;
    bajar.download = toma.nombre;
    bajar.textContent = "⬇ Guardar";
    bajar.title = "Descargar una copia";
    bajar.addEventListener("click", cerrarMenus);

    const renombrar = document.createElement("button");
    renombrar.textContent = "✎ Renombrar";
    renombrar.title = "Ponerle una etiqueta: acordes, lick...";
    renombrar.addEventListener("click", () => {
      cerrarMenus();
      editarNombre(toma, titulo);
    });

    const carpeta = document.createElement("button");
    carpeta.textContent = "📁 Mostrar en carpeta";
    carpeta.title = "Abrir el Explorador con la toma seleccionada";
    carpeta.addEventListener("click", async () => {
      cerrarMenus();
      try {
        const respuesta = await fetch(`/api/grabaciones/${encodeURIComponent(toma.nombre)}/mostrar`, {
          method: "POST",
        });
        if (!respuesta.ok) {
          const detalle = await respuesta.json().catch(() => ({}));
          throw new Error(detalle.error || respuesta.status);
        }
      } catch (err) {
        avisar(`No se pudo abrir la carpeta: ${err.message}`, "malo");
      }
    });

    const borrar = document.createElement("button");
    borrar.className = "borrar";
    borrar.textContent = "🗑 Borrar";
    borrar.title = "Mover a la papelera";
    borrar.addEventListener("click", () => {
      cerrarMenus();
      borrarToma(toma.nombre);
    });

    menu.append(bajar, renombrar, carpeta, borrar);

    const acciones = document.createElement("div");
    acciones.className = "acciones";
    const opciones = document.createElement("button");
    opciones.textContent = "⚙";
    opciones.title = "Guardar, renombrar, mostrar en carpeta o borrar";
    opciones.addEventListener("click", (e) => {
      e.stopPropagation();   // si no, tambien abriria la ventana de la toma
      const yaAbierto = menu.classList.contains("abierto");
      cerrarMenus();
      if (!yaAbierto) {
        // ~135px de menu: si no entran debajo de la fila, se abre para arriba.
        const fila = tarjeta.getBoundingClientRect();
        const lista = galeriaGrid.getBoundingClientRect();
        menu.classList.toggle("arriba", fila.bottom + 140 > lista.bottom);
        menu.classList.add("abierto");
        galeriaOcupada = true;
      }
    });
    acciones.append(opciones);

    tarjeta.append(mini, pie, acciones, menu);
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
const btnPausa = document.getElementById("btnPausa");
const btnGuardar = document.getElementById("btnGuardar");
const btnDescartar = document.getElementById("btnDescartar");

btnGuardar.addEventListener("click", () => alGesto("pulgar_arriba"));
btnDescartar.addEventListener("click", () => alGesto("pulgar_abajo"));
btnPausa.addEventListener("click", alternarPausa);

async function alternarPausa() {
  enPausa = !enPausa;
  if (enPausa) {
    // Parar no es guardar ni tirar: la toma en curso se descarta, que es lo
    // unico honesto cuando uno corta sin decidir.
    if (grabador.grabando) await grabador.terminar("descartar");
    avisar("Grabacion detenida", "");
  } else {
    arrancarSiHaceFalta();
  }
  registrar(`pausa: ${enPausa}`);
}

document.getElementById("btnGaleria")
  .addEventListener("click", () => document.body.classList.toggle("sinGaleria"));
document.getElementById("btnStats").addEventListener("click", alternarEstadisticas);
document.getElementById("btnPantalla").addEventListener("click", alternarPantallaCompleta);

// Un boton que no se puede usar tiene que verse asi, en vez de no hacer nada
// al tocarlo.
function pintarBotones() {
  const grabando = grabador.grabando;

  btnPausa.textContent = enPausa ? "● Reanudar" : "■ Parar";
  btnPausa.classList.toggle("principal", enPausa);
  btnPausa.disabled = !hayVideo() && !enPausa;
  btnGuardar.disabled = !grabando;
  btnDescartar.disabled = !grabando;
}
setInterval(pintarBotones, 250);
pintarBotones();

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  const tecla = e.key.toLowerCase();

  if (tecla === "p") alternarPausa();
  else if (tecla === "g") alGesto("pulgar_arriba");
  else if (tecla === "d") alGesto("pulgar_abajo");
  else if (tecla === "s") alternarEstadisticas();
  else if (tecla === "f") alternarPantallaCompleta();
  else if (tecla === "v") document.body.classList.toggle("sinGaleria");
  else if (tecla === "h") document.body.classList.toggle("sinCabecera");
});
