// Deteccion de gestos de mano sobre el video que llega del telefono.
//
// Corre en la PC y no en el iPhone a proposito: el telefono ya esta capturando
// y codificando H.264, y sumarle inferencia lo calienta y lo hace bajar la
// calidad del video que justamente queremos mirar. Ademas la grabacion vive
// aca, asi que gesto y grabacion quedan en el mismo lado, sin viaje de ida y
// vuelta por la red.
//
// Solo dos gestos, los dos pulgares. Hubo una version con palma abierta para
// reiniciar y no sobrevivio al uso real: unos dedos sobre el diapason son
// cuatro dedos estirados, o sea lo mismo que una palma abierta, y reiniciaba
// las tomas solo. Los pulgares no aparecen por accidente tocando la guitarra,
// y el clasificador los reconoce con confianza alta y estable.

import { FilesetResolver, GestureRecognizer } from "/vendor/vision_bundle.mjs";
import { registrar } from "../shared/log.js";

// Nombres del modelo -> nombres nuestros.
const TRADUCCION = {
  Thumb_Up: "pulgar_arriba",
  Thumb_Down: "pulgar_abajo",
};

// Inferir en cada cuadro es desperdicio: 12 por segundo alcanza de sobra para
// un gesto que hay que sostener 700 ms.
const INTERVALO_MS = 80;

// Hay que sostener el gesto: una mano que pasa delante de la camara tocando no
// puede disparar una accion.
const SOSTENIDO_MS = 700;
// Pero exigir cuadros CONSECUTIVOS por encima del umbral no funciona: el
// puntaje oscila y cruza el umbral de a un cuadro, asi que un contador de
// consecutivos se reinicia siempre y no dispara nunca. Se vota sobre una
// ventana de tiempo, como el suavizador del prototipo de GuitarCam: alcanza
// con que la mayoria de la ventana coincida.
const VENTANA_MS = 1000;
const FRACCION_MINIMA = 0.55;
const VOTOS_NECESARIOS = Math.ceil((SOSTENIDO_MS / INTERVALO_MS) * FRACCION_MINIMA);

// Despues de disparar ignoramos todo un rato: si no, un pulgar sostenido
// dispararia doce veces por segundo.
const ENFRIAMIENTO_MS = 1500;
// Por debajo de esto el clasificador esta adivinando.
const CONFIANZA_MINIMA = 0.45;
const RESUMEN_MS = 1000;

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
      `${VOTOS_NECESARIOS} votos en ${VENTANA_MS} ms`
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

  // Devuelve el gesto del cuadro mirando todas las manos, o null.
  function leerGesto(resultado) {
    let elegido = null;

    for (const mano of resultado.gestures || []) {
      const c = mano?.[0];
      if (!c) continue;

      // El crudo se registra antes del umbral y de la traduccion: si el modelo
      // ve la mano pero la llama distinto, en el log se ve.
      if (c.score > mejorScore) {
        mejorScore = c.score;
        mejorNombre = c.categoryName;
      }

      const nombre = c.score >= CONFIANZA_MINIMA ? TRADUCCION[c.categoryName] : undefined;
      if (nombre && (!elegido || c.score > elegido.score)) {
        elegido = { nombre, categoria: c.categoryName, score: c.score };
      }
    }

    return elegido;
  }

  function contar() {
    const cuentas = new Map();
    for (const v of votos) {
      if (!v.nombre) continue;
      cuentas.set(v.nombre, (cuentas.get(v.nombre) || 0) + 1);
    }

    let ganador = null;
    let cuenta = 0;
    for (const [nombre, n] of cuentas) {
      if (n > cuenta) {
        ganador = nombre;
        cuenta = n;
      }
    }
    return { ganador, cuenta };
  }

  function resumir(ahora) {
    if (ahora - ultimoResumen < RESUMEN_MS) return;
    const lapso = (ahora - ultimoResumen) / 1000;
    ultimoResumen = ahora;

    const { ganador, cuenta } = contar();
    registrar(
      `gestos: ${(inferencias / lapso).toFixed(1)}/s  ${msInferencia.toFixed(1)} ms  ` +
        `manos=${manosVistas}/${inferencias}  top=${mejorNombre} ${mejorScore.toFixed(2)}  ` +
        `votos=${ganador || "-"} ${cuenta}/${VOTOS_NECESARIOS}  ` +
        `video=${video.videoWidth}x${video.videoHeight} paused=${video.paused} ` +
        `saltados=${cuadrosSaltados}`
    );

    inferencias = 0;
    cuadrosSaltados = 0;
    manosVistas = 0;
    mejorNombre = "-";
    mejorScore = 0;
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

    const crudo = leerGesto(resultado);

    // Un voto por inferencia, y afuera lo que se salio de la ventana.
    votos.push({ ts: ahora, nombre: crudo ? crudo.nombre : null });
    while (votos.length && ahora - votos[0].ts > VENTANA_MS) votos.shift();

    resumir(ahora);

    const { ganador, cuenta } = contar();
    if (alCambiarCandidato) {
      alCambiarCandidato(ganador, Math.min(1, cuenta / VOTOS_NECESARIOS), crudo);
    }

    // Se solto el gesto que ya habia disparado: ya puede volver a hacerse.
    if (yaDisparado && ganador !== yaDisparado) yaDisparado = null;

    if (ganador !== ultimoAnunciado) {
      ultimoAnunciado = ganador;
      if (ganador) registrar(`gestos: juntando votos para ${ganador}`);
    }

    if (!ganador || cuenta < VOTOS_NECESARIOS) return;
    if (ahora < bloqueadoHasta) return;
    if (yaDisparado === ganador) return;

    yaDisparado = ganador;
    bloqueadoHasta = ahora + ENFRIAMIENTO_MS;
    votos.length = 0;   // la ventana ya se uso; la siguiente empieza limpia
    registrar(`gestos: DISPARA ${ganador} (${crudo.categoria} ${crudo.score.toFixed(2)})`);
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
  };
}
