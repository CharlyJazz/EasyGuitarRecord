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

// Nombres del modelo -> nombres nuestros.
const TRADUCCION = {
  Open_Palm: "high_five",
  Thumb_Up: "pulgar_arriba",
  Thumb_Down: "pulgar_abajo",
};

// Una mano que pasa tocando delante de la camara no puede disparar una accion.
// Hay que sostener el gesto.
const SOSTENIDO_MS = 700;
// Despues de disparar, ignoramos todo un rato: si no, un high five sostenido
// dispararia veinte veces por segundo.
const ENFRIAMIENTO_MS = 1500;
// Por debajo de esto el modelo esta adivinando.
const CONFIANZA_MINIMA = 0.6;
// Inferir en cada cuadro es desperdicio: 12 por segundo alcanza de sobra para
// un gesto que hay que sostener 700 ms.
const INTERVALO_MS = 80;
// Cada cuanto resumir en el log lo que el modelo esta viendo.
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
      numHands: 1,
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
  registrar(`gestos: modelo cargado con ${delegado} en ${(performance.now() - t1).toFixed(0)} ms`);

  let corriendo = false;
  let ultimaInferencia = 0;
  let ultimoTimestamp = 0;

  let candidato = null;        // gesto que se esta sosteniendo ahora
  let candidatoDesde = 0;
  let bloqueadoHasta = 0;
  let yaDisparado = null;      // hay que soltar el gesto antes de repetirlo

  // Para el resumen periodico del log.
  let ultimoResumen = 0;
  let inferencias = 0;
  let cuadrosSaltados = 0;
  let manosVistas = 0;
  let mejorNombre = "-";
  let mejorScore = 0;
  let msInferencia = 0;

  function resumir(ahora) {
    if (ahora - ultimoResumen < RESUMEN_MS) return;
    const lapso = (ahora - ultimoResumen) / 1000;
    ultimoResumen = ahora;

    registrar(
      `gestos: ${(inferencias / lapso).toFixed(1)}/s  ${msInferencia.toFixed(1)} ms  ` +
        `manos=${manosVistas}/${inferencias}  top=${mejorNombre} ${mejorScore.toFixed(2)}  ` +
        `umbral=${CONFIANZA_MINIMA}  video=${video.videoWidth}x${video.videoHeight} ` +
        `ready=${video.readyState} paused=${video.paused}  saltados=${cuadrosSaltados}`
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

    const mano = resultado.gestures?.[0]?.[0];
    if (resultado.landmarks?.length) manosVistas += 1;

    // Se registra el crudo, antes del umbral y de la traduccion: si el modelo
    // ve la mano pero llama distinto al gesto, aca se ve.
    if (mano && mano.score > mejorScore) {
      mejorScore = mano.score;
      mejorNombre = mano.categoryName;
    }
    resumir(ahora);

    const nombre = mano && mano.score >= CONFIANZA_MINIMA ? TRADUCCION[mano.categoryName] : undefined;

    if (!nombre) {
      if (candidato) registrar(`gestos: se solto ${candidato}`);
      candidato = null;
      yaDisparado = null;   // solto el gesto: ya puede volver a hacerlo
      if (alCambiarCandidato) alCambiarCandidato(null, 0, mano);
      return;
    }

    if (nombre !== candidato) {
      candidato = nombre;
      candidatoDesde = ahora;
      registrar(`gestos: empieza a sostener ${nombre} (${mano.categoryName} ${mano.score.toFixed(2)})`);
    }

    const sostenido = ahora - candidatoDesde;
    if (alCambiarCandidato) {
      alCambiarCandidato(candidato, Math.min(1, sostenido / SOSTENIDO_MS), mano);
    }

    if (sostenido < SOSTENIDO_MS) return;
    if (ahora < bloqueadoHasta) {
      return;
    }
    if (yaDisparado === nombre) return;

    yaDisparado = nombre;
    bloqueadoHasta = ahora + ENFRIAMIENTO_MS;
    candidatoDesde = ahora;
    registrar(`gestos: DISPARA ${nombre}`);
    alGesto(nombre);
  }

  return {
    arrancar() {
      if (corriendo) return;
      corriendo = true;
      ultimoResumen = performance.now();
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
