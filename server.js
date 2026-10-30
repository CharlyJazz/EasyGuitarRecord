import express from "express";
import { createServer } from "https";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import selfsigned from "selfsigned";
import { fileURLToPath } from "url";
import { finalizarToma, hayFfmpeg } from "./remux.js";
import { montarTransferencias } from "./transferencias.js";
import { montarEditor } from "./editor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const GRABACIONES = path.join(__dirname, "grabaciones");
const TRANSFERENCIAS = path.join(__dirname, "transferencias");
// El editor de Remotion es otro repo; por defecto, la carpeta hermana.
const EDITOR = process.env.GUITAR_EDITOR || path.join(__dirname, "..", "GuitarVideoEditorRemotion");

// ---------------------------------------------------------------- certificado
// Safari en iOS solo entrega getUserMedia en un "secure context": https, o
// localhost. Una IP de LAN sobre http NO cuenta -- navigator.mediaDevices
// directamente no existe. Por eso el servidor es https con un autofirmado.
const CERTS = path.join(__dirname, "certs");

function ipsLocales() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

function cargarCertificado(ips) {
  const key = path.join(CERTS, "key.pem");
  const cert = path.join(CERTS, "cert.pem");
  const marca = path.join(CERTS, "ips.json");

  // Si cambio la IP de la PC (otra WiFi, DHCP nuevo), el cert viejo ya no la
  // cubre y Safari lo rechaza sin ofrecer el "visitar de todas formas".
  if (fs.existsSync(key) && fs.existsSync(cert) && fs.existsSync(marca)) {
    const previas = JSON.parse(fs.readFileSync(marca, "utf8"));
    if (ips.every((ip) => previas.includes(ip))) {
      return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
    }
  }

  console.log("Generando certificado autofirmado para:", ips.join(", ") || "(sin IP de LAN)");
  const pems = selfsigned.generate([{ name: "commonName", value: "iphone-monitor" }], {
    days: 3650,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
          ...ips.map((ip) => ({ type: 7, ip })),
        ],
      },
    ],
  });

  fs.mkdirSync(CERTS, { recursive: true });
  fs.writeFileSync(key, pems.private);
  fs.writeFileSync(cert, pems.cert);
  fs.writeFileSync(marca, JSON.stringify(ips));
  return { key: pems.private, cert: pems.cert };
}

// ------------------------------------------------------------------- registro
function log(origen, ...resto) {
  console.log(`${new Date().toLocaleTimeString()}  ${origen}  ${resto.join(" ")}`);
}

// ------------------------------------------------------------ version de la UI
// Un hash de lo que el navegador ejecuta, public/ y shared/. Cada pagina lo
// recibe al cargar (/version.js) y lo manda con cada linea de log; si ya no es
// el del disco, la linea sale marcada VIEJA. Asi se ve en la terminal cual
// pagina quedo sin recargar despues de un cambio, en vez de adivinarlo.
function versionUI() {
  const hash = crypto.createHash("sha1");
  for (const dir of ["public", "shared"]) {
    const base = path.join(__dirname, dir);
    const archivos = fs
      .readdirSync(base, { recursive: true })
      .map(String)
      .filter((f) => /\.(js|mjs|html|css)$/.test(f))
      .sort();
    for (const f of archivos) {
      hash.update(`${dir}/${f}\0`);
      hash.update(fs.readFileSync(path.join(base, f)));
    }
  }
  return hash.digest("hex").slice(0, 7);
}

// -------------------------------------------------------------------- estatico
const app = express();

app.get("/version.js", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("application/javascript");
  res.send(`export const VERSION = "${versionUI()}";\n`);
});

app.use((req, res, next) => {
  if (req.url !== "/api/log") {
    const origen = (req.socket.remoteAddress || "?").replace("::ffff:", "");
    log(origen, req.method, req.url);
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));
// phone.js y monitor.js importan ../shared/*.js, que el navegador pide como
// /shared/*.js. Sin esto el modulo tira 404 y la pagina no arranca.
app.use("/shared", express.static(path.join(__dirname, "shared")));
// MediaPipe servido desde el repo y no desde un CDN: anda sin internet y la
// version queda clavada por package-lock.
app.use("/vendor", express.static(path.join(__dirname, "node_modules/@mediapipe/tasks-vision")));
app.use("/modelos", express.static(path.join(__dirname, "modelos")));
app.use("/grabaciones", express.static(GRABACIONES));

// Los navegadores mandan aca sus logs: el monitor corre en Chrome en la PC y
// el emisor en Safari en el telefono, y no hay una sola consola donde mirar
// las dos puntas.
app.post("/api/log", express.json({ limit: "1mb" }), (req, res) => {
  const etiqueta = String(req.body?.etiqueta || "web").slice(0, 20);
  const suya = String(req.body?.version || "?").slice(0, 12);
  const vieja = suya !== versionUI() ? " VIEJA-recargar" : "";
  for (const linea of req.body?.lineas || []) {
    console.log(
      `${new Date().toLocaleTimeString()}  [${etiqueta} ${suya}${vieja}] ${String(linea).slice(0, 500)}`
    );
  }
  res.sendStatus(204);
});

// Un video suelto en la carpeta de grabaciones. Lo que importa es que no
// pueda salir de la carpeta (sin esto, un ".." en la ruta dejaria borrar
// cualquier archivo de la maquina), no que tenga el formato exacto de nombre
// que pone el servidor: antes se exigia toma-AAAA-MM-DD_HH-MM-SS.mp4 y una
// toma renombrada a mano (toma-...-volumen.mp4) aparecia en la galeria pero
// no se podia borrar. La galeria y el borrado usan esta misma regla, asi lo
// que se ve siempre se puede borrar.
function esVideoDeLaCarpeta(nombre) {
  return (
    nombre === path.basename(nombre) &&
    !nombre.startsWith(".") &&
    /\.(mp4|webm|mov)$/i.test(nombre)
  );
}
const PAPELERA = path.join(GRABACIONES, ".papelera");

// Borrar es mover a la papelera, no destruir. Una toma buena que se va por un
// clic de mas no se recupera de ninguna otra forma.
app.delete("/api/grabaciones/:nombre", (req, res) => {
  const nombre = req.params.nombre;
  if (!esVideoDeLaCarpeta(nombre)) {
    return res.status(400).json({ error: "nombre invalido" });
  }

  const origenArchivo = path.join(GRABACIONES, nombre);
  if (!fs.existsSync(origenArchivo)) {
    return res.status(404).json({ error: "no existe" });
  }

  fs.mkdirSync(PAPELERA, { recursive: true });
  let destino = path.join(PAPELERA, nombre);
  // Si ya hay una con ese nombre, no pisamos la anterior.
  if (fs.existsSync(destino)) {
    destino = path.join(PAPELERA, `${Date.now()}-${nombre}`);
  }

  fs.renameSync(origenArchivo, destino);
  log("api", `a la papelera: ${nombre}`);
  res.json({ ok: true, papelera: path.basename(destino) });
});

// Renombrar es para etiquetar la toma (acordes, lick...). Mismas reglas que el
// borrado para los dos nombres, y la extension no cambia: renombrar no
// convierte nada.
app.post("/api/grabaciones/:nombre/renombrar", express.json(), (req, res) => {
  const nombre = req.params.nombre;
  const nuevo = String(req.body?.nombre || "");
  if (!esVideoDeLaCarpeta(nombre) || !esVideoDeLaCarpeta(nuevo) || /[<>:"\/\\|?*\x00-\x1f]/.test(nuevo)) {
    return res.status(400).json({ error: "nombre invalido" });
  }
  if (path.extname(nombre).toLowerCase() !== path.extname(nuevo).toLowerCase()) {
    return res.status(400).json({ error: "no se puede cambiar la extension" });
  }

  const origenArchivo = path.join(GRABACIONES, nombre);
  const destino = path.join(GRABACIONES, nuevo);
  if (!fs.existsSync(origenArchivo)) {
    return res.status(404).json({ error: "no existe" });
  }
  // En Windows "Lick.mp4" y "lick.mp4" son el mismo archivo: cambiar solo
  // mayusculas no es pisar a otro.
  if (fs.existsSync(destino) && nombre.toLowerCase() !== nuevo.toLowerCase()) {
    return res.status(409).json({ error: "ya hay una toma con ese nombre" });
  }

  fs.renameSync(origenArchivo, destino);
  log("api", `renombrada: ${nombre} -> ${nuevo}`);
  res.json({ ok: true, nombre: nuevo });
});

// Abre el Explorador en la carpeta de grabaciones con la toma seleccionada.
// Lo hace el servidor porque el navegador no puede abrir carpetas locales; el
// monitor corre en esta misma PC, asi que la ventana aparece delante de uno.
app.post("/api/grabaciones/:nombre/mostrar", (req, res) => {
  const nombre = req.params.nombre;
  if (!esVideoDeLaCarpeta(nombre)) {
    return res.status(400).json({ error: "nombre invalido" });
  }
  const archivo = path.join(GRABACIONES, nombre);
  if (!fs.existsSync(archivo)) {
    return res.status(404).json({ error: "no existe" });
  }
  // Argumentos literales: explorer quiere /select,"ruta con espacios" tal
  // cual, y el escapado normal de Node le pone comillas a todo el argumento.
  // explorer.exe sale con codigo 1 aunque haya andado: no se mira.
  spawn("explorer.exe", [`/select,"${archivo}"`], {
    windowsVerbatimArguments: true,
    detached: true,
    stdio: "ignore",
  }).unref();
  log("api", `mostrar en carpeta: ${nombre}`);
  res.json({ ok: true });
});

app.get("/api/grabaciones", (req, res) => {
  const archivos = fs
    .readdirSync(GRABACIONES)
    .filter(esVideoDeLaCarpeta)
    .sort()
    .reverse()
    .map((n) => {
      const datos = fs.statSync(path.join(GRABACIONES, n));
      // mtime y no la fecha del nombre: un video copiado a mano no la trae, y
      // renombrar no la toca.
      return { nombre: n, bytes: datos.size, modificado: datos.mtimeMs };
    });
  res.json(archivos);
});

montarTransferencias(app, { carpeta: TRANSFERENCIAS, log });
montarEditor(app, {
  raiz: EDITOR,
  carpetas: { grabaciones: GRABACIONES, transferencias: TRANSFERENCIAS },
  // SQLite de las sesiones; en .gitignore (el repo es publico).
  datos: path.join(__dirname, "datos"),
  log,
});

const ips = ipsLocales();
fs.mkdirSync(GRABACIONES, { recursive: true });
const server = createServer(cargarCertificado(ips), app);
// Node corta solo cualquier pedido que pase de 5 minutos (requestTimeout).
// Subir un video de varios GB los pasa de largo y la transferencia se caia
// sin explicacion; aca no hay clientes hostiles, es la LAN de casa.
server.requestTimeout = 0;

const wss = new WebSocketServer({ server });

function enviar(ws, objeto) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(typeof objeto === "string" ? objeto : JSON.stringify(objeto));
  }
}

// ------------------------------------------------------------------ signaling
// El servidor solo pasa texto (SDP/ICE). El video va peer-to-peer.
const peers = {};                                // { phone: ws, monitor: ws }
const pendientes = { phone: [], monitor: [] };   // mensajes para un peer que todavia no llego

function avisarPeer(rol, presente) {
  // El telefono es el que emite la oferta. Si el monitor se cae y vuelve, el
  // telefono tiene que enterarse para renegociar; si no, la pagina de la PC
  // se queda en negro esperando una oferta que nunca va a llegar.
  const otro = rol === "phone" ? "monitor" : "phone";
  enviar(peers[otro], { type: "peer", role: rol, presente });
}

function manejarSignaling(ws, origen) {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // basura, la ignoramos en vez de tumbar el proceso
    }

    if (msg.type === "register") {
      // Si el mismo rol ya estaba tomado, la conexion vieja es un fantasma:
      // el navegador reconecto antes de que se notara la caida de la anterior.
      const anterior = peers[msg.role];
      if (anterior && anterior !== ws) {
        log(origen, `reemplaza a un ${msg.role} anterior`);
        anterior.terminate();
      }

      peers[msg.role] = ws;
      ws.rol = msg.role;
      log(origen, `conectado como ${msg.role}`);

      const cola = pendientes[msg.role] || [];
      while (cola.length) enviar(ws, cola.shift());

      avisarPeer(msg.role, true);
      const otro = msg.role === "phone" ? "monitor" : "phone";
      if (peers[otro]) enviar(ws, { type: "peer", role: otro, presente: true });
      return;
    }

    const rol = msg.to === "monitor" ? "monitor" : "phone";
    if (peers[rol]) enviar(peers[rol], raw.toString());
    else if (pendientes[rol].length < 200) pendientes[rol].push(raw.toString());
  });

  ws.on("close", (codigo, motivo) => {
    const texto = motivo && motivo.length ? motivo.toString() : "sin motivo";
    log(origen, `cerrado (${ws.rol || "sin rol"}) codigo=${codigo} motivo=${texto}`);

    if (ws.rol && peers[ws.rol] === ws) {
      delete peers[ws.rol];
      // Lo que quedo encolado pertenece a una sesion que ya murio.
      pendientes.phone.length = 0;
      pendientes.monitor.length = 0;
      avisarPeer(ws.rol, false);
    }
  });
}

// ----------------------------------------------------------------- grabaciones
// Los trozos del MediaRecorder se escriben a disco a medida que llegan. Una
// toma de varios minutos a 12 Mbps son cientos de MB: juntarla entera en
// memoria para mandarla de una sola vez es pedir que reviente.
function marcaDeTiempo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function manejarGrabacion(ws, origen) {
  log(origen, "canal de grabacion abierto");

  let escritor = null;
  let parcial = null;
  let bytes = 0;

  function descartar() {
    const archivo = parcial;
    parcial = null;
    if (!escritor) {
      if (archivo && fs.existsSync(archivo)) fs.unlinkSync(archivo);
      return;
    }
    const ese = escritor;
    escritor = null;
    ese.end(() => {
      if (archivo && fs.existsSync(archivo)) fs.unlinkSync(archivo);
    });
  }

  ws.on("message", (raw, esBinario) => {
    if (esBinario) {
      if (escritor) {
        escritor.write(raw);
        bytes += raw.length;
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "iniciar") {
      descartar(); // por si quedo una toma a medio grabar
      const extension = msg.extension === "mp4" ? "mp4" : "webm";
      parcial = path.join(GRABACIONES, `.parcial-${Date.now()}.${extension}`);
      escritor = fs.createWriteStream(parcial);
      bytes = 0;
      log(origen, `grabando -> ${path.basename(parcial)}`);
      enviar(ws, { type: "grabando" });
      return;
    }

    if (msg.type === "guardar") {
      if (!parcial || !escritor) return;
      const archivo = parcial;
      const ese = escritor;
      const total = bytes;
      parcial = null;
      escritor = null;
      // Sin extension: la pone finalizarToma(), que siempre deja un .mp4 salvo
      // que ffmpeg falte o falle.
      const destinoBase = path.join(GRABACIONES, `toma-${marcaDeTiempo()}`);
      ese.end(async () => {
        // El remux de una toma larga tarda un momento; que el monitor no crea
        // que se colgo.
        enviar(ws, { type: "procesando" });
        const r = await finalizarToma(archivo, destinoBase);
        const nombre = path.basename(r.destino);
        log(origen, `guardado: ${nombre} (${(total / 1e6).toFixed(1)} MB, ${r.metodo})` +
          (r.detalle ? ` -- ${r.detalle}` : ""));
        enviar(ws, {
          type: "guardado",
          archivo: nombre,
          bytes: total,
          metodo: r.metodo,
          detalle: r.detalle,
        });
      });
      return;
    }

    if (msg.type === "descartar") {
      if (!parcial) return;
      log(origen, "toma descartada");
      descartar();
      enviar(ws, { type: "descartado" });
    }
  });

  // Si la pagina se cierra en medio de una toma, el parcial no sirve de nada.
  ws.on("close", () => {
    log(origen, "canal de grabacion cerrado");
    descartar();
  });
}

wss.on("connection", (ws, req) => {
  const origen = (req.socket.remoteAddress || "?").replace("::ffff:", "");
  ws.origen = origen;
  ws.vivo = true;
  ws.on("pong", () => { ws.vivo = true; });
  ws.on("error", (err) => log(origen, "error de socket:", err.message));

  log(origen, "WebSocket abierto", req.url);

  if ((req.url || "").startsWith("/grabacion")) manejarGrabacion(ws, origen);
  else manejarSignaling(ws, origen);
});

// Sin esto, un iPhone que se duerme o se va de la red deja un socket colgado:
// el servidor lo sigue creyendo conectado y le manda mensajes al vacio. El
// ping/pong lo detecta en ~30 segundos.
const LATIDO_MS = 15000;
const latido = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.vivo === false) {
      log(ws.origen || "?", `sin respuesta al ping, cerrando (${ws.rol || "sin rol"})`);
      ws.terminate();
      continue;
    }
    ws.vivo = false;
    ws.ping();
  }
}, LATIDO_MS);

wss.on("close", () => clearInterval(latido));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\nEn la PC (Chrome/Edge):  https://localhost:${PORT}/monitor.html`);
  for (const ip of ips) {
    console.log(`En el iPhone (Safari):   https://${ip}:${PORT}/phone.html`);
    console.log(`Pasar archivos:          https://${ip}:${PORT}/transferir.html`);
  }
  console.log(`Editor (en la PC):       https://localhost:${PORT}/editor.html`);
  console.log(`\nLas tomas se guardan en:  ${GRABACIONES}`);
  console.log(`Los archivos que se pasan: ${TRANSFERENCIAS}`);
  if (!hayFfmpeg()) {
    console.log(
      "\n  AVISO: no se encontro ffmpeg en el PATH.\n" +
      "  Las tomas van a quedar en MP4 fragmentado, que DaVinci y la mayoria de\n" +
      "  los editores rechazan. Instalalo (winget install Gyan.FFmpeg) o apunta\n" +
      "  la variable FFMPEG al binario."
    );
  }
  console.log("");
});
