// Puente con el editor de video en Remotion (otro repo, local).
//
// Cada video que se edita es una fila de `video_processed` (db.js) con un
// uuid. Ese uuid es el que usa el proyecto de Remotion: la sesion aparece en
// el Studio como la composicion `Sesion-<uuid>`, y lo propio de esa toma vive
// en `src/sesiones/<uuid>.tsx` del editor.
//
// El flujo, paso por paso (la UI es public/editor.html):
//   1. subir   video (manos) + audio de FL (mezcla) + guitarra sola (opcional)
//   2. sync    tools/sync/nueva_toma.py: donde cae la mezcla en el video y la
//              guitarra en la mezcla (GCC-PHAT)
//   3-5. analizar  tools/transcribir/analizar.py: la cinta de notas cruda,
//              inicio/fin de la guitarra, BPM y donde cae el "1"
//   6. revisar tools/transcribir/revisar.py propone la cinta revisada con
//              reglas; despues la revisan el agente (por esta API) o la UI
//   7. partitura  buildAlphaTab (tools/partitura.mjs del editor) -> alphaTex
//   8. Remotion   el server exporta public/sesiones/<id>/partitura.json
//
// Remotion no lee SQLite: cada vez que cambia algo que la composicion usa, se
// reescribe ese JSON. La base es la fuente de verdad.
//
// Donde esta el editor: variable GUITAR_EDITOR, o por defecto la carpeta
// hermana `../GuitarVideoEditorRemotion`.
import express from "express";
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import path from "path";
import { pathToFileURL } from "url";
import { abrirDb } from "./db.js";

const PUERTO_STUDIO = 3100;
const EXT_VIDEO = /\.(mp4|mov|m4v|webm)$/i;
const EXT_AUDIO = /\.(wav|mp3|flac|aif|aiff|m4a|ogg)$/i;
const TIPOS = ["video", "audio", "guitarra"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Lo que la UI (o el agente) puede cambiar a mano en una sesion.
// [min, max] para los números. Antes se convertía con Number(): "" y true pasaban como 0 y 1.
const EDITABLES = {
  when_start_playing_guitar: [0, 3600],
  when_stop_playing_guitar: [0, 3600],
  bpm: [20, 400],
  swing: [0.5, 0.8], // null = detectarlo; 0,5 = recto; si no, la fase de la corchea del contratiempo
  primer_tiempo_s: [-60, 3600],
  encuadre_x: [0, 1],
  accidentales: ["sostenidos", "bemoles"],
};

function nombreSeguro(crudo) {
  const solo = path.basename(String(crudo || "").trim());
  const limpio = solo.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+/, "");
  return limpio.slice(0, 180) || null;
}

// La cinta que llega por PUT. Las posiciones tienen que dar la altura de la nota: buildAlphaTab
// ignoraría una equivocada, pero es mejor que el que la escribió se entere.
const AFINACION = [64, 59, 55, 50, 45, 40];
function errorNota(n, i) {
  const donde = `nota ${i}`;
  if (!n || typeof n !== "object" || Array.isArray(n)) return `${donde}: no es un objeto`;
  const { t_s, fin_s, midi, amp, cuerda, traste, nota, muerta } = n;
  if (!Number.isFinite(t_s) || t_s < 0 || t_s > 3600) return `${donde}: t_s tiene que ser un número entre 0 y 3600`;
  if (!Number.isFinite(fin_s) || fin_s < t_s || fin_s > t_s + 60) return `${donde}: fin_s tiene que ir de t_s a t_s + 60`;
  if (muerta != null && typeof muerta !== "boolean") return `${donde}: muerta es true o false`;
  // Nota muerta (chop): sin altura, solo la cuerda. midi se guarda como la cuerda al aire.
  if (muerta) {
    if (!Number.isInteger(cuerda) || cuerda < 1 || cuerda > 6) return `${donde}: una nota muerta necesita cuerda (1 a 6)`;
    if (traste != null) return `${donde}: una nota muerta no lleva traste`;
    if (nota != null && (typeof nota !== "string" || nota.length > 500)) return `${donde}: nota es texto de hasta 500 caracteres`;
    return null;
  }
  if (!Number.isInteger(midi) || midi < 40 || midi > 88) return `${donde}: midi tiene que ser entero entre 40 (E2) y 88 (E6)`;
  if (amp != null && (!Number.isFinite(amp) || amp < 0 || amp > 1)) return `${donde}: amp va de 0 a 1`;
  if ((cuerda == null) !== (traste == null)) return `${donde}: cuerda y traste van juntos`;
  if (cuerda != null) {
    if (!Number.isInteger(cuerda) || cuerda < 1 || cuerda > 6) return `${donde}: cuerda va de 1 (mi aguda) a 6`;
    if (!Number.isInteger(traste) || traste < 0 || traste > 22) return `${donde}: traste va de 0 a 22`;
    if (AFINACION[cuerda - 1] + traste !== midi) return `${donde}: ${traste}.${cuerda} no da midi ${midi} (da ${AFINACION[cuerda - 1] + traste})`;
  }
  if (nota != null && (typeof nota !== "string" || nota.length > 500)) return `${donde}: nota es texto de hasta 500 caracteres`;
  return null;
}

function puertoAbierto(puerto) {
  return new Promise((resolve) => {
    const s = net.connect(puerto, "127.0.0.1");
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}

export function montarEditor(app, { raiz, carpetas, datos, log = () => {} }) {
  // carpetas: { grabaciones, transferencias } -- de donde se puede elegir un
  // archivo que ya esta en la PC sin volver a subirlo.
  const FUENTES = path.join(raiz, "fuentes");
  const disponible = () => fs.existsSync(path.join(raiz, "tools", "sync", "nueva_toma.py"));
  const dir = (id) => path.join(FUENTES, id);
  const db = abrirDb(datos);

  // buildAlphaTab vive en el repo del editor; se carga una vez, al usarlo.
  let partitura = null;
  const cargarPartitura = async () =>
    (partitura ??= await import(pathToFileURL(path.join(raiz, "tools", "partitura.mjs")).href));

  // El mismo parser que dibuja en Remotion y en la página: si no lo lee, no se guarda.
  let alphaTab = null;
  async function validarAlphatex(tex) {
    alphaTab ??= await import(pathToFileURL(path.join(raiz, "node_modules", "@coderline", "alphatab", "dist", "alphaTab.mjs")).href);
    const imp = new alphaTab.importer.AlphaTexImporter();
    try {
      imp.initFromString(tex, new alphaTab.Settings());
      imp.readScore();
      return null;
    } catch (e) {
      const c = e.cause ?? e;
      const d = ["lexerDiagnostics", "parserDiagnostics", "semanticDiagnostics"]
        .flatMap((k) => c[k]?.items ?? [])
        .find((x) => x.severity === alphaTab.importer.AlphaTexDiagnosticsSeverity?.Error) ??
        ["lexerDiagnostics", "parserDiagnostics", "semanticDiagnostics"].flatMap((k) => c[k]?.items ?? []).at(-1);
      return d ? `${d.message} (linea ${d.start?.line}, columna ${d.start?.col})` : e.message;
    }
  }

  // Los procesos que corren ahora. Si el servidor se reinicia a mitad de uno,
  // el estado que quedo en la base ("corriendo") ya no es verdad.
  const corriendo = new Set();
  const ocupada = (id) => corriendo.has(id);

  // Un error dentro de un handler async es una promesa rechazada que Express 4 no ve, y Node 24
  // mata el proceso: un PUT con {"notas":[null]} tiraba abajo todo el camera mirror (medido).
  // Sincronizar, analizar y renderizar responden antes de terminar; si fallan después, la etapa
  // quedaba en "corriendo" para siempre: se marca "error" con el motivo en el log.
  const seguro = (fn, etapa) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch((e) => {
      log("editor", `${req.method} ${req.path}: ${e.message}`);
      const id = req.params.id;
      if (etapa && id && db.leer(id)) db.actualizar(id, { [etapa]: "error", log: String(e.stack || e).slice(-6000) });
      if (!res.headersSent) res.status(500).json({ error: e.message });
    });

  function lanzar(id, titulo, comando, args, opciones) {
    corriendo.add(id);
    const salida = [`$ ${titulo}\n`];
    return new Promise((resolve) => {
      const hijo = spawn(comando, args, {
        ...opciones,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", TF_CPP_MIN_LOG_LEVEL: "3" },
        windowsHide: true,
      });
      const juntar = (b) => {
        // TensorFlow y librosa llenan stderr de avisos que no le sirven a nadie.
        const texto = b.toString("utf8").split("\n")
          .filter((l) => !/warn|pkg_resources|Predicting MIDI|^\s*import /i.test(l)).join("\n");
        salida.push(texto);
        db.actualizar(id, { log: salida.join("").slice(-6000) });
      };
      hijo.stdout.on("data", juntar);
      hijo.stderr.on("data", juntar);
      hijo.on("error", (e) => juntar(Buffer.from(`\n${e.message}\n`)));
      hijo.on("close", (codigo) => {
        corriendo.delete(id);
        resolve(codigo);
      });
    });
  }

  // ------------------------------------------------------------- export
  // Lo que Remotion necesita para dibujar la partitura sobre el video.
  function exportar(id) {
    const s = db.leer(id);
    const carpeta = path.join(raiz, "public", "sesiones", id);
    if (!fs.existsSync(carpeta)) return;
    const p = db.ultimaPartitura(id);
    const datosRemotion = {
      offsetVideoS: s.offset_video_s,
      bpm: s.bpm,
      encuadreX: s.encuadre_x ?? 0.5,
      partitura: p ? { alphatex: p.alphatex, inicioCompasS: p.inicio_compas_s, swingFase: p.swing_fase ?? null, autor: p.autor, creada: p.creada } : null,
    };
    fs.writeFileSync(path.join(carpeta, "partitura.json"), JSON.stringify(datosRemotion, null, 2));
  }

  function vista(s) {
    // Lo que va a la UI: la fila + los frames calculados (nada se guarda en frames).
    const frame = (t) => (t == null || s.offset_video_s == null || !s.fps ? null : Math.round((t + s.offset_video_s) * s.fps));
    const p = db.ultimaPartitura(s.id);
    return {
      ...s,
      alias: s.id.slice(0, 8),
      when_start_playing_guitar_frame: frame(s.when_start_playing_guitar),
      when_stop_playing_guitar_frame: frame(s.when_stop_playing_guitar),
      notas_crudas: db.contarNotas(s.id, "cruda"),
      notas_revisadas: db.contarNotas(s.id, "revisada"),
      partitura: p ? { autor: p.autor, creada: p.creada } : null,
      renderListo: fs.existsSync(path.join(raiz, "out", `${s.id}.mp4`)),
      corriendo: ocupada(s.id),
    };
  }

  function verificar(req, res, next) {
    if (!disponible()) {
      return res.status(503).json({ error: `No encuentro el editor en ${raiz}. Configura GUITAR_EDITOR.` });
    }
    if (req.params.id !== undefined && (!UUID.test(req.params.id) || !db.leer(req.params.id))) {
      return res.sendStatus(404);
    }
    next();
  }

  const libre = (req, res, next) =>
    ocupada(req.params.id) ? res.status(409).json({ error: "la sesion esta procesando" }) : next();

  // ------------------------------------------------------------- sesiones
  app.get("/api/editor", (req, res) => {
    if (!disponible()) return res.json({ disponible: false, raiz });
    const sesiones = db.listar().map((s) => {
      for (const clave of ["sync_estado", "analisis_estado", "render_estado"]) {
        if (s[clave] === "corriendo" && !ocupada(s.id)) s[clave] = "cortado";
      }
      return vista(s);
    });
    res.json({ disponible: true, raiz, sesiones });
  });

  app.get("/api/editor/sesiones/:id", verificar, (req, res) => res.json(vista(db.leer(req.params.id))));

  app.post("/api/editor/sesiones", verificar, (req, res) => {
    const id = crypto.randomUUID();
    fs.mkdirSync(dir(id), { recursive: true });
    db.crear(id);
    log("editor", `sesion nueva: ${id}`);
    res.json({ id });
  });

  app.delete("/api/editor/sesiones/:id", verificar, libre, (req, res) => {
    const { id } = req.params;
    db.borrar(id);
    for (const ruta of [dir(id), path.join(raiz, "public", "sesiones", id)]) {
      fs.rmSync(ruta, { recursive: true, force: true });
    }
    fs.rmSync(path.join(raiz, "out", `${id}.mp4`), { force: true });
    lanzar(id, "generar-sesiones", process.execPath, [path.join("tools", "generar-sesiones.mjs")], { cwd: raiz });
    log("editor", `sesion borrada: ${id}`);
    res.json({ ok: true });
  });

  // Cambios a mano: BPM, donde cae el "1", inicio/fin, encuadre, alteraciones.
  app.patch("/api/editor/sesiones/:id", verificar, express.json(), (req, res) => {
    const cambios = {};
    for (const [clave, tipo] of Object.entries(EDITABLES)) {
      if (!(clave in (req.body || {}))) continue;
      const v = req.body[clave];
      if (typeof tipo[0] === "number") {
        const [min, max] = tipo;
        if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)) {
          return res.status(400).json({ error: `${clave} tiene que ser un numero entre ${min} y ${max}` });
        }
        cambios[clave] = v;
      } else if (!tipo.includes(v)) {
        return res.status(400).json({ error: `${clave} tiene que ser ${tipo.join(" o ")}` });
      } else cambios[clave] = v;
    }
    db.actualizar(req.params.id, cambios);
    exportar(req.params.id);
    res.json(vista(db.leer(req.params.id)));
  });

  // Lo que ya esta en la PC: tomas del monitor y lo que paso el telefono.
  app.get("/api/editor/archivos", (req, res) => {
    const archivos = [];
    for (const [carpeta, ruta] of Object.entries(carpetas)) {
      if (!fs.existsSync(ruta)) continue;
      for (const nombre of fs.readdirSync(ruta)) {
        if (nombre.startsWith(".")) continue;
        const tipo = EXT_VIDEO.test(nombre) ? "video" : EXT_AUDIO.test(nombre) ? "audio" : null;
        if (!tipo) continue;
        archivos.push({ carpeta, nombre, tipo, fecha: fs.statSync(path.join(ruta, nombre)).mtimeMs });
      }
    }
    res.json(archivos.sort((a, b) => b.fecha - a.fecha));
  });

  // ------------------------------------------------------------- 1. subir
  // Mismo esquema que las transferencias: cuerpo crudo y nombre en x-nombre,
  // asi un video de varios GB va a disco sin pasar por memoria.
  app.post("/api/editor/sesiones/:id/:tipo(video|audio|guitarra)", verificar, libre, (req, res) => {
    const { id, tipo } = req.params;
    const original = nombreSeguro(decodeURIComponent(req.get("x-nombre") || ""));
    if (!original) return res.status(400).json({ error: "falta el nombre" });

    const destino = path.join(dir(id), `${tipo}${path.extname(original).toLowerCase()}`);
    const parcial = path.join(dir(id), `.subiendo-${tipo}`);
    fs.mkdirSync(dir(id), { recursive: true });
    const escritor = fs.createWriteStream(parcial);
    const abortar = (motivo) => {
      escritor.destroy();
      fs.promises.unlink(parcial).catch(() => {});
      if (!res.headersSent) res.status(500).json({ error: motivo });
    };
    req.on("aborted", () => abortar("se corto la conexion"));
    escritor.on("error", (e) => abortar(e.message));
    req.pipe(escritor);
    escritor.on("finish", () => {
      if (req.aborted) return;
      reemplazar(id, tipo, parcial, destino, original);
      res.json(vista(db.leer(id)));
    });
  });

  app.post("/api/editor/sesiones/:id/:tipo(video|audio|guitarra)/desde", verificar, libre, express.json(), seguro(async (req, res) => {
    const { id, tipo } = req.params;
    const base = carpetas[req.body?.carpeta];
    const nombre = nombreSeguro(req.body?.nombre);
    if (!base || !nombre || !fs.existsSync(path.join(base, nombre))) return res.sendStatus(404);
    const destino = path.join(dir(id), `${tipo}${path.extname(nombre).toLowerCase()}`);
    const parcial = path.join(dir(id), `.copiando-${tipo}`);
    fs.mkdirSync(dir(id), { recursive: true });
    await fs.promises.copyFile(path.join(base, nombre), parcial);
    reemplazar(id, tipo, parcial, destino, nombre);
    res.json(vista(db.leer(id)));
  }));

  app.delete("/api/editor/sesiones/:id/guitarra", verificar, libre, (req, res) => {
    const { id } = req.params;
    for (const viejo of fs.readdirSync(dir(id))) {
      if (viejo.startsWith("guitarra.")) fs.unlinkSync(path.join(dir(id), viejo));
    }
    db.actualizar(id, { guitarra_nombre: null, guitarra_archivo: null, sync_estado: null });
    res.json(vista(db.leer(id)));
  });

  function reemplazar(id, tipo, parcial, destino, original) {
    // Un video .mov reemplazado por un .mp4 dejaria los dos: se borra el anterior.
    for (const viejo of fs.readdirSync(dir(id))) {
      if (viejo.startsWith(`${tipo}.`)) fs.unlinkSync(path.join(dir(id), viejo));
    }
    fs.renameSync(parcial, destino);
    // Cambio una fuente: lo sincronizado y analizado antes ya no vale.
    db.actualizar(id, { [`${tipo}_nombre`]: original, [`${tipo}_archivo`]: path.basename(destino), sync_estado: null, analisis_estado: null });
    log("editor", `${id}: ${tipo} = ${original}`);
  }

  // ------------------------------------------------------------- 2. sync
  app.post("/api/editor/sesiones/:id/sincronizar", verificar, libre, express.json(), seguro(async (req, res) => {
    const { id } = req.params;
    const s = db.leer(id);
    if (!s.video_archivo || !s.audio_archivo) return res.status(400).json({ error: "faltan el video o el audio" });

    const args = ["run", "python", "nueva_toma.py", id, path.join(dir(id), s.video_archivo), path.join(dir(id), s.audio_archivo)];
    if (s.guitarra_archivo) args.push("--guitarra", path.join(dir(id), s.guitarra_archivo));
    if (req.body?.force) args.push("--force");
    db.actualizar(id, { sync_estado: "corriendo", log: "" });
    res.json(vista(db.leer(id)));

    // 2 = sync.py no confio en el resultado y no escribio nada
    const codigo = await lanzar(id, "sincronizar", "uv", args, { cwd: path.join(raiz, "tools", "sync") });
    const estado = codigo === 0 ? "lista" : codigo === 2 ? "dudosa" : "error";
    const cambios = { sync_estado: estado };
    if (estado === "lista") {
      const toma = JSON.parse(fs.readFileSync(path.join(raiz, "public", "sesiones", id, "toma.json"), "utf8"));
      Object.assign(cambios, {
        offset_video_s: toma.sync.offsetSeconds,
        offset_guitarra_s: toma.sync.guitarraOffsetSeconds ?? null,
        confianza: toma.sync.confidence,
        deriva_ppm: toma.sync.driftPpm,
        fps: toma.fps,
        ancho: toma.width,
        alto: toma.height,
        duracion_frames: toma.durationInFrames,
      });
    }
    db.actualizar(id, cambios);
    if (estado === "lista") exportar(id);
    log("editor", `${id}: sincronizacion ${estado}`);
  }, "sync_estado"));

  // ------------------------------------------------------- 3-6. analizar
  // Cinta cruda + inicio/fin + BPM + "1", y la revision por reglas encima.
  app.post("/api/editor/sesiones/:id/analizar", verificar, libre, seguro(async (req, res) => {
    const { id } = req.params;
    const s = db.leer(id);
    if (s.sync_estado !== "lista") return res.status(400).json({ error: "primero hay que sincronizar" });

    const salida = path.join(dir(id), "analisis.json");
    const revisada = path.join(dir(id), "revisada.json");
    const args = ["run", "python", "analizar.py", "--mezcla", path.join(dir(id), s.audio_archivo), "--out", salida];
    if (s.guitarra_archivo) {
      args.push("--guitarra", path.join(dir(id), s.guitarra_archivo), "--offset-guitarra", String(s.offset_guitarra_s ?? 0));
    }
    db.actualizar(id, { analisis_estado: "corriendo", log: "" });
    res.json(vista(db.leer(id)));

    const cwd = path.join(raiz, "tools", "transcribir");
    let codigo = await lanzar(id, "analizar", "uv", args, { cwd });
    if (codigo === 0) codigo = await lanzar(id, "revisar (reglas)", "uv", ["run", "python", "revisar.py", salida, revisada], { cwd });
    if (codigo !== 0) {
      db.actualizar(id, { analisis_estado: "error" });
      return;
    }
    const a = JSON.parse(fs.readFileSync(salida, "utf8"));
    const r = JSON.parse(fs.readFileSync(revisada, "utf8"));
    db.reemplazarNotas(id, "cruda", a.notas);
    db.reemplazarNotas(id, "revisada", r.notas);
    db.actualizar(id, {
      analisis_estado: "listo",
      analisis_fuente: a.fuente,
      when_start_playing_guitar: a.inicio_s ?? null,
      when_stop_playing_guitar: a.fin_s ?? null,
      bpm: a.tempo?.bpm ?? null,
      primer_tiempo_s: a.primer_tiempo_s ?? null,
    });
    await generarPartitura(id, "buildAlphaTab");
    log("editor", `${id}: analisis listo (${a.notas.length} notas crudas, ${r.notas.length} revisadas)`);
  }, "analisis_estado"));

  // ----------------------------------------------------------- 6. cinta
  // La cinta por la API: es por donde la lee y la corrige el agente.
  app.get("/api/editor/sesiones/:id/notas", verificar, (req, res) => {
    const version = req.query.version === "cruda" ? "cruda" : "revisada";
    const s = db.leer(req.params.id);
    const fps = s.fps || 30;
    res.json(db.notas(req.params.id, version).map((n) => ({
      ...n,
      frame: s.offset_video_s == null ? null : Math.round((n.t_s + s.offset_video_s) * fps),
    })));
  });

  app.put("/api/editor/sesiones/:id/notas", verificar, libre, express.json({ limit: "5mb" }), seguro(async (req, res) => {
    const notas = req.body?.notas;
    if (!Array.isArray(notas) || !notas.length || notas.length > 5000) {
      return res.status(400).json({ error: "notas: [{t_s, fin_s, midi, amp?, cuerda?, traste?, nota?}], de 1 a 5000" });
    }
    const error = notas.map(errorNota).find(Boolean);
    if (error) return res.status(400).json({ error });
    // Solo los campos conocidos: lo demás (frame, que es calculado) no se guarda.
    db.reemplazarNotas(req.params.id, "revisada", notas.map(({ t_s, fin_s, midi, amp, cuerda, traste, nota, muerta }) =>
      (muerta ? { t_s, fin_s, midi: AFINACION[cuerda - 1], amp, cuerda, traste: null, nota, muerta: true } : { t_s, fin_s, midi, amp, cuerda, traste, nota })));
    const r = await generarPartitura(req.params.id, req.body.autor === "ui" ? "ui" : "agente");
    res.json({ ...vista(db.leer(req.params.id)), avisos: r?.avisos ?? [] });
  }));

  // ------------------------------------------------------- 7. partitura
  async function generarPartitura(id, autor) {
    const s = db.leer(id);
    const notas = db.notas(id, "revisada");
    if (!s.bpm || s.primer_tiempo_s == null || !notas.length) return null;
    const { buildAlphaTab } = await cargarPartitura();
    const r = buildAlphaTab({
      bpm: s.bpm,
      primerTiempoS: s.primer_tiempo_s,
      notas,
      accidentales: s.accidentales || "sostenidos",
      swing: s.swing ?? null,
      inicioS: s.when_start_playing_guitar ?? undefined,
      finS: s.when_stop_playing_guitar ?? undefined,
    });
    db.guardarPartitura(id, autor, r.alphatex, r.inicioCompasS, r.swingFase);
    exportar(id);
    return r;
  }

  app.post("/api/editor/sesiones/:id/partitura", verificar, libre, seguro(async (req, res) => {
    const r = await generarPartitura(req.params.id, "buildAlphaTab");
    if (!r) return res.status(400).json({ error: "falta analizar (BPM, el \"1\" o la cinta)" });
    res.json({ ...vista(db.leer(req.params.id)), compases: r.compases });
  }));

  app.get("/api/editor/sesiones/:id/partitura", verificar, (req, res) => {
    const p = db.ultimaPartitura(req.params.id);
    if (!p) return res.sendStatus(404);
    res.json(p);
  });

  // alphaTex escrito a mano (el agente o la UI): queda en el historial.
  app.put("/api/editor/sesiones/:id/partitura", verificar, libre, express.json({ limit: "2mb" }), seguro(async (req, res) => {
    const { alphatex, autor } = req.body || {};
    if (typeof alphatex !== "string" || !alphatex.trim()) return res.status(400).json({ error: "falta alphatex" });
    // Uno que alphaTab no entiende dejaba el video sin partitura, sin error en ningún lado.
    const problema = await validarAlphatex(alphatex);
    if (problema) return res.status(400).json({ error: `alphaTex invalido: ${problema}` });
    const anterior = db.ultimaPartitura(req.params.id);
    db.guardarPartitura(req.params.id, autor === "ui" ? "ui" : "agente", alphatex, anterior?.inicio_compas_s ?? null, anterior?.swing_fase ?? null);
    exportar(req.params.id);
    res.json(vista(db.leer(req.params.id)));
  }));

  // ---------------------------------------------------------- 8. render
  app.post("/api/editor/sesiones/:id/render", verificar, libre, seguro(async (req, res) => {
    const { id } = req.params;
    if (db.leer(id).sync_estado !== "lista") return res.status(400).json({ error: "primero hay que sincronizar" });
    db.actualizar(id, { render_estado: "corriendo", log: "" });
    res.json(vista(db.leer(id)));
    const codigo = await lanzar(id, "render", process.execPath, [path.join("tools", "render.mjs"), id], { cwd: raiz });
    db.actualizar(id, { render_estado: codigo === 0 ? "listo" : "error" });
    log("editor", `${id}: render ${codigo === 0 ? "listo" : "con error"}`);
  }, "render_estado"));

  app.get("/api/editor/sesiones/:id/render", verificar, (req, res) => {
    const ruta = path.join(raiz, "out", `${req.params.id}.mp4`);
    if (!fs.existsSync(ruta)) return res.sendStatus(404);
    res.download(ruta, `${req.params.id.slice(0, 8)}.mp4`);
  });

  // La vista previa de la partitura en la pagina usa el mismo alphaTab que
  // Remotion, servido desde el editor: una sola version para los dos.
  app.use("/alphatab", express.static(path.join(raiz, "node_modules", "@coderline", "alphatab", "dist")));

  // El Studio de Remotion corre aparte, en la PC. Si no esta levantado se
  // lanza desacoplado: sobrevive a este servidor y no se lanza dos veces.
  app.post("/api/editor/studio", verificar, seguro(async (req, res) => {
    if (!(await puertoAbierto(PUERTO_STUDIO))) {
      const hijo = spawn(process.execPath,
        [path.join(raiz, "node_modules", "@remotion", "cli", "remotion-cli.js"),
          "studio", "src/index.ts", "--port", String(PUERTO_STUDIO), "--no-open"],
        { cwd: raiz, detached: true, stdio: "ignore", windowsHide: true });
      hijo.unref();
      log("editor", "lanzando el Studio de Remotion");
      for (let i = 0; i < 60 && !(await puertoAbierto(PUERTO_STUDIO)); i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    res.json({ url: `http://localhost:${PUERTO_STUDIO}` });
  }));

  // JSON roto, cuerpo demasiado grande, etc.: la página espera JSON, no el HTML de Express.
  app.use("/api/editor", (err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.type === "entity.too.large" ? "el cuerpo es demasiado grande" : err.message });
  });
}
