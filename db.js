// Base de datos del editor: una fila por video procesado y su cinta de notas.
//
// SQLite con el modulo que trae Node (node:sqlite, sin dependencias). El
// archivo vive en datos/ y esta en .gitignore: el repo es publico y esto son
// las tomas de cada uno.
//
// Convencion de tiempos: TODO en segundos sobre la linea de tiempo de la
// mezcla de FL (la pista de audio que se sube). Nada se guarda en frames: un
// frame mide 33 ms, cambia con los fps del video y quedaria invalido si se
// re-sincroniza. El frame se calcula al final con
//     frame = round((t + offset_video_s) * fps)
// y la API lo devuelve calculado donde hace falta.
import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS video_processed (
  id                        TEXT PRIMARY KEY,   -- uuid; Remotion la usa como Sesion-<id>
  creado                    INTEGER NOT NULL,   -- ms epoch

  video_nombre              TEXT,               -- nombres originales, para mostrar
  audio_nombre              TEXT,               -- mezcla final de FL
  guitarra_nombre           TEXT,               -- pista de guitarra sola (opcional)
  video_archivo             TEXT,               -- nombres en fuentes/<id>/
  audio_archivo             TEXT,
  guitarra_archivo          TEXT,

  sync_estado               TEXT,               -- corriendo | lista | dudosa | error
  offset_video_s            REAL,               -- la mezcla empieza en este segundo del video
  offset_guitarra_s         REAL,               -- la guitarra sola empieza en este segundo de la mezcla
  confianza                 REAL,
  deriva_ppm                REAL,
  fps                       INTEGER,
  ancho                     INTEGER,
  alto                      INTEGER,
  duracion_frames           INTEGER,

  analisis_estado           TEXT,               -- corriendo | listo | error
  analisis_fuente           TEXT,               -- guitarra | mezcla (de donde salieron las notas)
  when_start_playing_guitar REAL,               -- s en la mezcla
  when_stop_playing_guitar  REAL,
  bpm                       REAL,
  primer_tiempo_s           REAL,               -- donde cae un "1" (s en la mezcla)

  accidentales              TEXT DEFAULT 'sostenidos',  -- sostenidos | bemoles
  swing                     REAL,               -- NULL = detectarlo; 0.5 = recto; 0.55-0.8 = fase de la corchea del contratiempo
  encuadre_x                REAL DEFAULT 0.5,   -- 0..1, que parte del video horizontal se ve en el vertical
  render_estado             TEXT,
  log                       TEXT
);

-- La cinta: nota por nota en el tiempo. La version 'cruda' es la del
-- transcriptor y no se toca nunca; la 'revisada' es la que escriben el agente
-- o la UI, y es la que usa la partitura si existe.
CREATE TABLE IF NOT EXISTS notas (
  video_id  TEXT NOT NULL REFERENCES video_processed(id) ON DELETE CASCADE,
  version   TEXT NOT NULL CHECK (version IN ('cruda', 'revisada')),
  t_s       REAL NOT NULL,                      -- ataque, s en la mezcla
  fin_s     REAL NOT NULL,
  midi      INTEGER NOT NULL,
  amp       REAL,
  cuerda    INTEGER,                            -- 1 = mi aguda; NULL = que la elija buildAlphaTab
  traste    INTEGER,
  nota      TEXT,                               -- por que el agente la cambio
  muerta    INTEGER                             -- 1 = nota muerta (chop): sin altura, midi = la cuerda al aire
);
CREATE INDEX IF NOT EXISTS notas_video ON notas(video_id, version, t_s);

-- Historial de partituras: cada generacion o correccion queda.
CREATE TABLE IF NOT EXISTS partituras (
  video_id         TEXT NOT NULL REFERENCES video_processed(id) ON DELETE CASCADE,
  creada           INTEGER NOT NULL,
  autor            TEXT NOT NULL,               -- buildAlphaTab | agente | ui
  alphatex         TEXT NOT NULL,
  inicio_compas_s  REAL,                        -- s en la mezcla donde empieza el compas 1 escrito (tick 0)
  swing_fase       REAL                         -- con swing, donde cae la corchea del contratiempo; el cursor la usa
);
`;

export function abrirDb(carpeta) {
  fs.mkdirSync(carpeta, { recursive: true });
  const db = new DatabaseSync(path.join(carpeta, "editor.sqlite"));
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  db.exec(ESQUEMA);
  // Columnas agregadas despues de crear la base: CREATE TABLE IF NOT EXISTS no las suma.
  const agregar = (tabla, columna, tipo) => {
    const hay = db.prepare(`SELECT name FROM pragma_table_info('${tabla}')`).all().some((c) => c.name === columna);
    if (!hay) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${tipo}`);
  };
  agregar("video_processed", "swing", "REAL");
  agregar("notas", "muerta", "INTEGER");
  agregar("partituras", "swing_fase", "REAL");

  const COLUMNAS = new Set(db.prepare("SELECT name FROM pragma_table_info('video_processed')").all().map((c) => c.name));

  return {
    crear(id) {
      db.prepare("INSERT INTO video_processed (id, creado) VALUES (?, ?)").run(id, Date.now());
      return this.leer(id);
    },
    leer(id) {
      return db.prepare("SELECT * FROM video_processed WHERE id = ?").get(id) ?? null;
    },
    listar() {
      return db.prepare("SELECT * FROM video_processed ORDER BY creado DESC").all();
    },
    // Solo columnas que existen: los nombres vienen del codigo, pero un typo
    // no tiene que convertirse en SQL arbitrario.
    actualizar(id, cambios) {
      const claves = Object.keys(cambios).filter((k) => COLUMNAS.has(k) && k !== "id");
      if (!claves.length) return this.leer(id);
      db.prepare(`UPDATE video_processed SET ${claves.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
        .run(...claves.map((k) => cambios[k] ?? null), id);
      return this.leer(id);
    },
    borrar(id) {
      db.prepare("DELETE FROM video_processed WHERE id = ?").run(id);
    },
    notas(id, version) {
      return db.prepare("SELECT t_s, fin_s, midi, amp, cuerda, traste, nota, muerta FROM notas WHERE video_id = ? AND version = ? ORDER BY t_s, midi")
        .all(id, version).map(({ muerta, ...n }) => (muerta ? { ...n, muerta: true } : n));
    },
    reemplazarNotas(id, version, notas) {
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM notas WHERE video_id = ? AND version = ?").run(id, version);
        const ins = db.prepare("INSERT INTO notas (video_id, version, t_s, fin_s, midi, amp, cuerda, traste, nota, muerta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const n of notas) {
          ins.run(id, version, n.t_s, n.fin_s, n.midi, n.amp ?? null, n.cuerda ?? null, n.traste ?? null, n.nota ?? null, n.muerta ? 1 : null);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    contarNotas(id, version) {
      return db.prepare("SELECT count(*) AS n FROM notas WHERE video_id = ? AND version = ?").get(id, version).n;
    },
    guardarPartitura(id, autor, alphatex, inicioCompasS, swingFase) {
      db.prepare("INSERT INTO partituras (video_id, creada, autor, alphatex, inicio_compas_s, swing_fase) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, Date.now(), autor, alphatex, inicioCompasS ?? null, swingFase ?? null);
    },
    ultimaPartitura(id) {
      return db.prepare("SELECT * FROM partituras WHERE video_id = ? ORDER BY creada DESC LIMIT 1").get(id) ?? null;
    },
  };
}
