// Carpeta compartida entre el telefono y la PC, por la WiFi de casa.
//
// Reemplaza el viaje por WeTransfer, que es lento no por el archivo sino por
// el camino: sube el video entero a un servidor en internet y despues lo baja.
// Aca los bytes van directo de un aparato al otro por la red local.
//
// Es **una sola carpeta y va para los dos lados**: lo que sube el telefono
// aparece en `transferencias/` en la PC, y lo que la PC deja ahi aparece en la
// lista del telefono para bajar. Nada se recomprime en el camino: se copian
// los bytes tal cual.
//
// Lo que SI puede tocar la calidad pasa antes de que el archivo salga del
// telefono: en *Ajustes -> Fotos -> Transferir a Mac o PC*, la opcion
// "Automatico" convierte los HEVC a H.264 al exportarlos. Hay que ponerlo en
// **"Conservar originales"**; desde aca no hay forma de impedirlo.
import express from "express";
import fs from "fs";
import path from "path";

// Un nombre que llega de afuera no se usa nunca tal cual: `../../` en el
// nombre dejaria escribir o borrar cualquier archivo de la maquina.
function nombreSeguro(crudo) {
  const solo = path.basename(String(crudo || "").trim());
  // Reservados de Windows (: * ? " < > |) y los de control.
  const limpio = solo.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+/, "");
  return limpio.slice(0, 180) || null;
}

// Si ya hay un archivo con ese nombre no se pisa: "toma.mp4" -> "toma-2.mp4".
function libre(carpeta, nombre) {
  const ext = path.extname(nombre);
  const base = path.basename(nombre, ext);
  let intento = nombre;
  let n = 2;
  while (fs.existsSync(path.join(carpeta, intento))) {
    intento = `${base}-${n}${ext}`;
    n += 1;
  }
  return intento;
}

export function montarTransferencias(app, { carpeta, log = () => {} }) {
  fs.mkdirSync(carpeta, { recursive: true });

  app.get("/api/transferencias", (req, res) => {
    const archivos = fs
      .readdirSync(carpeta)
      .filter((n) => !n.startsWith("."))
      .map((n) => {
        const st = fs.statSync(path.join(carpeta, n));
        return { nombre: n, bytes: st.size, fecha: st.mtimeMs };
      })
      .sort((a, b) => b.fecha - a.fecha);
    res.json(archivos);
  });

  // El archivo viaja como cuerpo crudo del POST y el nombre en un header, en
  // vez de multipart/form-data. Asi no hace falta un parser de formularios y,
  // sobre todo, el cuerpo se puede mandar a disco a medida que llega: un video
  // de varios GB no entra en memoria.
  app.post("/api/transferencias", (req, res) => {
    const nombre = nombreSeguro(decodeURIComponent(req.get("x-nombre") || ""));
    if (!nombre) return res.status(400).json({ error: "falta el nombre" });

    const destino = libre(carpeta, nombre);
    // Se escribe con un nombre oculto y se renombra al terminar: si la subida
    // se corta a la mitad, no queda un archivo truncado con pinta de sano.
    const parcial = path.join(carpeta, `.subiendo-${Date.now()}-${destino}`);
    const final = path.join(carpeta, destino);

    const escritor = fs.createWriteStream(parcial);
    let bytes = 0;
    const arranque = Date.now();

    req.on("data", (c) => (bytes += c.length));

    const abortar = (motivo) => {
      escritor.destroy();
      fs.promises.unlink(parcial).catch(() => {});
      log("transferencia", `subida cortada: ${destino} (${motivo})`);
      if (!res.headersSent) res.status(500).json({ error: motivo });
    };

    req.on("aborted", () => abortar("el telefono corto la conexion"));
    escritor.on("error", (e) => abortar(e.message));

    req.pipe(escritor);

    escritor.on("finish", () => {
      if (req.aborted) return;
      fs.renameSync(parcial, final);
      const seg = (Date.now() - arranque) / 1000;
      const mb = bytes / 1e6;
      log("transferencia", `recibido: ${destino} (${mb.toFixed(1)} MB en ` +
        `${seg.toFixed(1)} s, ${(mb / Math.max(seg, 0.001)).toFixed(1)} MB/s)`);
      res.json({ ok: true, nombre: destino, bytes });
    });
  });

  // Descarga. `res.download` pone Content-Disposition: attachment -- sin eso
  // Safari abre el video en el reproductor en vez de guardarlo en Archivos --
  // y por debajo usa sendFile, que respeta Range: una descarga cortada se
  // reanuda y el teléfono puede previsualizar sin bajar el archivo entero.
  app.get("/api/transferencias/:nombre", (req, res) => {
    const nombre = nombreSeguro(req.params.nombre);
    if (!nombre) return res.sendStatus(400);
    const ruta = path.join(carpeta, nombre);
    if (!fs.existsSync(ruta)) return res.sendStatus(404);
    res.download(ruta, nombre);
  });

  app.delete("/api/transferencias/:nombre", (req, res) => {
    const nombre = nombreSeguro(req.params.nombre);
    if (!nombre) return res.sendStatus(400);
    const ruta = path.join(carpeta, nombre);
    if (!fs.existsSync(ruta)) return res.sendStatus(404);
    fs.unlinkSync(ruta);
    log("transferencia", `borrado: ${nombre}`);
    res.json({ ok: true });
  });

  // Para previsualizar en linea (sin forzar la descarga) desde la PC.
  app.use("/transferencias", express.static(carpeta, { dotfiles: "ignore" }));
}
