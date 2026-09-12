import express from "express";
import { createServer } from "https";
import { WebSocketServer } from "ws";
import fs from "fs";
import os from "os";
import path from "path";
import selfsigned from "selfsigned";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const GRABACIONES = path.join(__dirname, "grabaciones");

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

// -------------------------------------------------------------------- estatico
const app = express();

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
  for (const linea of req.body?.lineas || []) {
    console.log(`${new Date().toLocaleTimeString()}  [${etiqueta}] ${String(linea).slice(0, 500)}`);
  }
  res.sendStatus(204);
});

app.get("/api/grabaciones", (req, res) => {
  const archivos = fs
    .readdirSync(GRABACIONES)
    .filter((n) => !n.startsWith("."))
    .sort()
    .reverse()
    .map((n) => ({ nombre: n, bytes: fs.statSync(path.join(GRABACIONES, n)).size }));
  res.json(archivos);
});

const ips = ipsLocales();
fs.mkdirSync(GRABACIONES, { recursive: true });
const server = createServer(cargarCertificado(ips), app);
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
      const destino = path.join(GRABACIONES, `toma-${marcaDeTiempo()}${path.extname(archivo)}`);
      ese.end(() => {
        fs.renameSync(archivo, destino);
        log(origen, `guardado: ${path.basename(destino)} (${(total / 1e6).toFixed(1)} MB)`);
        enviar(ws, { type: "guardado", archivo: path.basename(destino), bytes: total });
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
  }
  console.log(`\nLas tomas se guardan en: ${GRABACIONES}\n`);
});
