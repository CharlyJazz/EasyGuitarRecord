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

// -------------------------------------------------------------------- estatico
const app = express();
app.use(express.static(path.join(__dirname, "public")));
// phone.js y monitor.js importan ../shared/config.js, que el navegador pide
// como /shared/config.js. Sin esto el modulo tira 404 y la pagina no arranca.
app.use("/shared", express.static(path.join(__dirname, "shared")));

const ips = ipsLocales();
const server = createServer(cargarCertificado(ips), app);
const wss = new WebSocketServer({ server });

// ------------------------------------------------------------------ signaling
// El servidor solo pasa texto (SDP/ICE). El video va peer-to-peer.
const peers = {};                            // { phone: ws, monitor: ws }
const pendientes = { phone: [], monitor: [] };   // mensajes para un peer que todavia no llego

function enviar(ws, texto) {
  if (ws && ws.readyState === ws.OPEN) ws.send(texto);
}

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // basura, la ignoramos en vez de tumbar el proceso
    }

    if (msg.type === "register") {
      peers[msg.role] = ws;
      ws.rol = msg.role;
      console.log(`conectado: ${msg.role}`);
      // Si el telefono mando su oferta y sus candidatos ICE antes de que
      // existiera el monitor, se perderian para siempre. Los guardamos en
      // orden y los entregamos al registrarse.
      const cola = pendientes[msg.role] || [];
      while (cola.length) enviar(ws, cola.shift());
      return;
    }

    const rol = msg.to === "monitor" ? "monitor" : "phone";
    if (peers[rol]) enviar(peers[rol], raw.toString());
    else if (pendientes[rol].length < 200) pendientes[rol].push(raw.toString());
  });

  ws.on("close", () => {
    if (ws.rol && peers[ws.rol] === ws) {
      delete peers[ws.rol];
      console.log(`desconectado: ${ws.rol}`);
      // Lo que quedo encolado pertenece a una sesion que ya murio.
      pendientes.phone.length = 0;
      pendientes.monitor.length = 0;
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\nEn la PC (Chrome/Edge):  https://localhost:${PORT}/monitor.html`);
  for (const ip of ips) {
    console.log(`En el iPhone (Safari):   https://${ip}:${PORT}/phone.html`);
  }
  console.log(
    "\nLas dos paginas van a avisar que el certificado no es de confianza:\n" +
      "  Chrome/Edge -> Configuracion avanzada -> Continuar a ...\n" +
      "  Safari      -> Mostrar detalles -> visitar este sitio web\n" +
      "Se acepta una sola vez por dispositivo.\n"
  );
});
