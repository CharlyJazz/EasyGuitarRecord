// Deteccion de gestos de mano sobre el video que llega del telefono.
//
// Corre en la PC y no en el iPhone a proposito: el telefono ya esta capturando
// y codificando H.264, y sumarle inferencia lo calienta y lo hace bajar la
// calidad del video que justamente queremos mirar. Ademas la grabacion vive
// aca, asi que gesto y grabacion quedan en el mismo lado, sin viaje de ida y
// vuelta por la red.
//
// El modelo es el Gesture Recognizer de MediaPipe, que ya trae entrenadas las
// categorias que necesitamos. No hay clasificador propio ni entrenamiento.

import { FilesetResolver, GestureRecognizer } from "/vendor/vision_bundle.mjs";
import { registrar } from "../shared/log.js";
import { dedosEstirados, tamañoMano, DEDOS_PARA_PALMA } from "./geometria.js";

// Nombres del modelo -> nombres nuestros.
const TRADUCCION = {
  Open_Palm: "high_five",
  Thumb_Up: "pulgar_arriba",
  Thumb_Down: "pulgar_abajo",
};

// Hay que sostener el gesto: una mano que pasa delante de la camara tocando no
// puede disparar una accion.
//
// La palma abierta pide bastante mas que los pulgares, y no es capricho:
// reiniciar tira la toma en curso, mientras que guardar y descartar son
// decisiones que uno toma cuando ya termino de tocar. Ademas una mano abierta
// aparece sola todo el tiempo mientras se toca; un pulgar, no.
const SOSTENIDO_POR_GESTO = {
  high_five: 1600,
  pulgar_arriba: 700,
  pulgar_abajo: 700,
};
const SOSTENIDO_MS = 700;
// Pero exigir cuadros CONSECUTIVOS por encima del umbral no funciona. Medido
// sobre el video real, Open_Palm oscila entre 0.53 y 0.68: cruza el umbral un
// cuadro y vuelve a caer, y el contador se reiniciaba siempre. Se vota sobre
// una ventana de tiempo, como el suavizador del prototipo de GuitarCam:
// alcanza con que la mayoria de la ventana coincida.
const VENTANA_MS = 1000;
const FRACCION_MINIMA = 0.55;
// Despues de disparar, ignoramos todo un rato: si no, un high five sostenido
// dispararia veinte veces por segundo.
const ENFRIAMIENTO_MS = 1500;
// Por debajo de esto el clasificador esta adivinando. Baja de 0.6 a 0.45 por
// lo mismo: el puntaje real de un gesto bien hecho vive en esa banda.
const CONFIANZA_MINIMA = 0.45;
// Inferir en cada cuadro es desperdicio: 12 por segundo alcanza de sobra.
const INTERVALO_MS = 80;
const RESUMEN_MS = 1000;

// Cuantos votos iguales hacen falta dentro de la ventana, por gesto.
function votosNecesarios(nombre) {
  const sostenido = SOSTENIDO_POR_GESTO[nombre] ?? SOSTENIDO_MS;
  return Math.ceil((sostenido / INTERVALO_MS) * FRACCION_MINIMA);
}
const VENTANA_EFECTIVA_MS = Math.max(...Object.values(SOSTENIDO_POR_GESTO)) + 400;

// Un high five se hace cerca de la camara, a proposito. Una mano que anda por
// ahi tocando queda chica en el cuadro. Medido sobre sesiones reales, este
// corte separa una cosa de la otra sin pedirle al usuario que se acerque mas
// de lo natural.
const TAMAÑO_MINIMO_MANO = 0.10;

export async function crearDetectorDeGestos({ video, alGesto, alCambiarCandidato }) {
  registrar("gestos: cargando wasm desde /vendor/wasm");
  const t0 = performance.now();
  const fileset = await FilesetResolver.forVisionTasks("/vendor/wasm");
  registrar(`gestos: wasm listo en ${(performance.now() - t0).toFixed(0)} ms`);

  async function construir(delegate) {
    return GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: "/modelos/gesture_recognizer.task", delegate },
      runningMode: "VIDEO",
      // Dos manos: con la guitarra encima, cual queda libre depende del momento.
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  let reconocedor;
  let delegado = "GPU";
  const t1 = performance.now();
  try {
    reconocedor = await construir("GPU");
  } catch (err) {
    registrar(`gestos: GPU fallo (${err.message}), probando CPU`);
    delegado = "CPU";
    reconocedor = await construir("CPU");
  }
  registrar(
    `gestos: modelo cargado con ${delegado} en ${(performance.now() - t1).toFixed(0)} ms, ` +
      `votos: palma ${votosNecesarios("high_five")}, pulgares ` +
      `${votosNecesarios("pulgar_arriba")}, ventana ${VENTANA_EFECTIVA_MS} ms`
  );

  let corriendo = false;
  let ultimaInferencia = 0;
  let ultimoTimestamp = 0;

  const votos = [];            // { ts, nombre } de la ventana
  let bloqueadoHasta = 0;
  let yaDisparado = null;      // hay que soltar el gesto antes de repetirlo
  let ultimoAnunciado = null;

  // Para el resumen periodico del log.
  let ultimoResumen = 0;
  let inferencias = 0;
  let cuadrosSaltados = 0;
  let manosVistas = 0;
  let mejorNombre = "-";
  let mejorScore = 0;
  let msInferencia = 0;
  let dedosUltimo = -1;
  let tamañoUltimo = 0;
  let porGeometria = 0;

  // Lee un cuadro y devuelve el gesto crudo, mirando todas las manos.
  function leerGesto(resultado) {
    let elegido = null;   // { nombre, categoria, score, origen }

    const manos = resultado.gestures || [];
    for (let i = 0; i < manos.length; i += 1) {
      const c = manos[i]?.[0];
      if (!c) continue;
      if (c.score > mejorScore) {
        mejorScore = c.score;
        mejorNombre = c.categoryName;
      }
      const nombre = c.score >= CONFIANZA_MINIMA ? TRADUCCION[c.categoryName] : undefined;
      if (nombre && (!elegido || c.score > elegido.score)) {
        elegido = { nombre, categoria: c.categoryName, score: c.score, origen: "modelo" };
      }
    }

    if (elegido) return elegido;

    // El clasificador no se decidio. Para la palma abierta preguntamos a la
    // geometria, que es la unica de las tres que le cuesta.
    for (const puntos of resultado.landmarks || []) {
      const n = dedosEstirados(puntos);
      const tamaño = tamañoMano(puntos);
      dedosUltimo = n;
      tamañoUltimo = tamaño;
      if (n >= DEDOS_PARA_PALMA && tamaño >= TAMAÑO_MINIMO_MANO) {
        porGeometria += 1;
        return {
          nombre: "high_five",
          categoria: `dedos:${n} tam:${tamaño.toFixed(2)}`,
          score: 1,
          origen: "geometria",
        };
      }
    }

    return null;
  }

  function resumir(ahora) {
    if (ahora - ultimoResumen < RESUMEN_MS) return;
    const lapso = (ahora - ultimoResumen) / 1000;
    ultimoResumen = ahora;

    const conteo = contar();
    registrar(
      `gestos: ${(inferencias / lapso).toFixed(1)}/s  ${msInferencia.toFixed(1)} ms  ` +
        `manos=${manosVistas}/${inferencias}  top=${mejorNombre} ${mejorScore.toFixed(2)}  ` +
        `dedos=${dedosUltimo} tam=${tamañoUltimo.toFixed(2)} geom=${porGeometria}  ` +
        `votos=${conteo.ganador || "-"} ${conteo.cuenta}/${votosNecesarios(conteo.ganador)}  ` +
        `video=${video.videoWidth}x${video.videoHeight} paused=${video.paused} ` +
        `saltados=${cuadrosSaltados}`
    );

    inferencias = 0;
    cuadrosSaltados = 0;
    manosVistas = 0;
    mejorNombre = "-";
    mejorScore = 0;
    porGeometria = 0;
  }

  function contar() {
    const cuentas = new Map();
    for (const v of votos) {
      if (!v.nombre) continue;
      cuentas.set(v.nombre, (cuentas.get(v.nombre) || 0) + 1);
    }
    // Gana el que esta mas cerca de SU propio requisito, no el que tiene mas
    // votos: la palma pide bastante mas que los pulgares, asi que comparar
    // cuentas crudas dejaria a un pulgar listo esperando detras de una palma
    // que todavia no alcanza.
    let ganador = null;
    let cuenta = 0;
    let mejorAvance = 0;
    for (const [nombre, n] of cuentas) {
      const avance = n / votosNecesarios(nombre);
      if (avance > mejorAvance) {
        mejorAvance = avance;
        ganador = nombre;
        cuenta = n;
      }
    }
    return { ganador, cuenta };
  }

  function procesar(ahora) {
    if (!corriendo) return;
    requestAnimationFrame(procesar);

    if (ahora - ultimaInferencia < INTERVALO_MS) return;

    if (!video.videoWidth || video.readyState < 2) {
      cuadrosSaltados += 1;
      resumir(ahora);
      return;
    }
    ultimaInferencia = ahora;

    // recognizeForVideo exige timestamps estrictamente crecientes.
    const ts = Math.max(Math.round(ahora), ultimoTimestamp + 1);
    ultimoTimestamp = ts;

    let resultado;
    const antes = performance.now();
    try {
      resultado = reconocedor.recognizeForVideo(video, ts);
    } catch (err) {
      registrar(`gestos: recognizeForVideo fallo: ${err.message}`);
      resumir(ahora);
      return;
    }
    msInferencia = performance.now() - antes;
    inferencias += 1;
    if (resultado.landmarks?.length) manosVistas += 1;
    else dedosUltimo = -1;

    const crudo = leerGesto(resultado);

    // Un voto por inferencia, y afuera lo que se salio de la ventana.
    votos.push({ ts: ahora, nombre: crudo ? crudo.nombre : null });
    while (votos.length && ahora - votos[0].ts > VENTANA_EFECTIVA_MS) votos.shift();

    resumir(ahora);

    const { ganador, cuenta } = contar();

    const necesarios = votosNecesarios(ganador);
    if (alCambiarCandidato) {
      alCambiarCandidato(ganador, Math.min(1, cuenta / necesarios), crudo);
    }

    // Se solto el gesto que ya habia disparado: ya puede volver a hacerse.
    if (yaDisparado && (!ganador || ganador !== yaDisparado)) yaDisparado = null;

    if (ganador !== ultimoAnunciado) {
      ultimoAnunciado = ganador;
      if (ganador) registrar(`gestos: juntando votos para ${ganador}`);
    }

    if (!ganador || cuenta < necesarios) return;
    if (ahora < bloqueadoHasta) return;
    if (yaDisparado === ganador) return;

    yaDisparado = ganador;
    bloqueadoHasta = ahora + ENFRIAMIENTO_MS;
    votos.length = 0;   // la ventana ya se uso; la siguiente empieza limpia
    registrar(`gestos: DISPARA ${ganador} (${crudo?.origen || "?"} ${crudo?.categoria || ""})`);
    alGesto(ganador);
  }

  return {
    arrancar() {
      if (corriendo) return;
      corriendo = true;
      ultimoResumen = performance.now();
      votos.length = 0;
      registrar("gestos: bucle arrancado");
      requestAnimationFrame(procesar);
    },
    parar() {
      corriendo = false;
      registrar("gestos: bucle detenido");
    },
    get activo() {
      return corriendo;
    },
    get delegado() {
      return delegado;
    },
  };
}
