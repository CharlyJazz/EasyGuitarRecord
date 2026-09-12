// Baja los modelos de MediaPipe que no van al repo.
//
// La URL es VERSIONADA a proposito: la variante /latest/ es mutable y cambiaria
// el modelo bajo los pies entre dos clones del repo.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESTINO = path.join(__dirname, "..", "modelos");

const MODELOS = [
  {
    nombre: "gesture_recognizer.task",
    url: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
  },
];

fs.mkdirSync(DESTINO, { recursive: true });

for (const modelo of MODELOS) {
  const destino = path.join(DESTINO, modelo.nombre);
  if (fs.existsSync(destino)) {
    console.log(`ya esta: ${modelo.nombre}`);
    continue;
  }

  process.stdout.write(`bajando ${modelo.nombre}... `);
  const respuesta = await fetch(modelo.url);
  if (!respuesta.ok) {
    console.log("");
    throw new Error(`${modelo.url} respondio ${respuesta.status}`);
  }

  const bytes = Buffer.from(await respuesta.arrayBuffer());
  fs.writeFileSync(destino, bytes);
  console.log(`${(bytes.length / 1e6).toFixed(1)} MB`);
}
