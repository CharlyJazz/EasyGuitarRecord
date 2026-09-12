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
function hora() {
  return new Date().toLocaleTimeString();
}

function log(origen, ...resto) {
  console.log(`${hora()}  ${origen}  ${resto.join(" ")}`);
}

// -------------------------------------------------------------------- estatico
const app = express();

app.use((req, res, next) => {
  const origen = (req.socket.remoteAddress || "?").replace("::ffff:", "");
  log(origen, req.method, req.url);
  next();
});

app.use(express.static(path.join(__dirname, "public")));
// phone.js y monitor.js importan ../shared/config.js, que el navegador pide
// como /shared/config.js. Sin esto el modulo tira 404 y la pagina no arranca.
app.use("/shared", express.static(path.join(__dirname, "shared")));

const ips = ipsLocales();
const server = createServer(cargarCertificado(ips), app);
const wss = new WebSocketServer({ server });

// ------------------------------------------------------------------ signaling
// El servidor solo pasa texto (SDP/ICE). El video va peer-to-peer.
const peers = {};                                // { phone: ws, monitor: ws }
const pendientes = { phone: [], monitor: [] };   // mensajes para un peer que todavia no llego

function enviar(ws, texto) {
  if (ws && ws.readyState === ws.OPEN) ws.send(texto);
}

function avisarPeer(rol, presente) {
  // El telefono es el que emite la oferta. Si el monitor se cae y vuelve, el
  // telefono tiene que enterarse para renegociar; si no, la pagina de la PC
  // se queda en negro esperando una oferta que nunca va a llegar.
  const otro = rol === "phone" ? "monitor" : "phone";
  enviar(peers[otro], JSON.stringify({ type: "peer", role: rol, presente }));
}

wss.on("connection", (ws, req) => {
  const origen = (req.socket.remoteAddress || "?").replace("::ffff:", "");
  ws.origen = origen;
  ws.vivo = true;
  ws.on("pong", () => { ws.vivo = true; });

  log(origen, "WebSocket abierto");

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

      // Lo que quedo encolado mientras este rol no estaba.
      const cola = pendientes[msg.role] || [];
      while (cola.length) enviar(ws, cola.shift());

      // Presentacion cruzada, en los dos sentidos.
      avisarPeer(msg.role, true);
      const otro = msg.role === "phone" ? "monitor" : "phone";
      if (peers[otro]) enviar(ws, JSON.stringify({ type: "peer", role: otro, presente: true }));
      return;
    }

    const rol = msg.to === "monitor" ? "monitor" : "phone";
    if (peers[rol]) enviar(peers[rol], raw.toString());
    else if (pendientes[rol].length < 200) pendientes[rol].push(raw.toString());
  });

  ws.on("error", (err) => log(origen, "error de socket:", err.message));

  ws.on("close", (codigo, motivo) => {
    const texto = motivo && motivo.length ? motivo.toString() : "sin motivo";
    log(origen, `WebSocket cerrado (${ws.rol || "sin rol"}) codigo=${codigo} motivo=${texto}`);

    if (ws.rol && peers[ws.rol] === ws) {
      delete peers[ws.rol];
      // Lo que quedo encolado pertenece a una sesion que ya murio.
      pendientes.phone.length = 0;
      pendientes.monitor.length = 0;
      avisarPeer(ws.rol, false);
    }
  });
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
  console.log("");
});
