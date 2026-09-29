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

// Pero casi todo el tiempo no hay ningun pulgar: se esta tocando. Despues de
// REPOSO_TRAS_MS sin ver uno se pasa a mirar cada INTERVALO_DORMIDO_MS, y el
// primer pulgar que aparezca vuelve al ritmo normal. Cada inferencia bloquea
// el hilo principal y el <video> no pinta mientras tanto, asi que esto es lo
// que deja fluido el monitor. El costo: un gesto tarda hasta
// INTERVALO_DORMIDO_MS mas en disparar.
const REPOSO_TRAS_MS = 3000;
const INTERVALO_DORMIDO_MS = 1000;

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
// Ese numero supone 12 inferencias por segundo, y no siempre las hay: con la
// GPU ocupada (otra app, dos detectores) bajan a 3-4 y en la ventana nunca
// entran 5 votos, asi que la barra topaba en 80% y no disparaba jamas. Lo que
// se exige es la misma fraccion de lo que *de verdad* se infirio en la ventana,
// con un piso de votos y un piso de tiempo sostenido para que una mano que pasa
// no alcance.
const VOTOS_MINIMOS = 3;
const SOSTENIDO_MINIMO_MS = 400;

function votosNecesarios(inferidosEnVentana) {
  const proporcional = Math.ceil(
    inferidosEnVentana * (SOSTENIDO_MS / VENTANA_MS) * FRACCION_MINIMA
  );
  return Math.min(VOTOS_NECESARIOS, Math.max(VOTOS_MINIMOS, proporcional));
}

// Despues de disparar ignoramos todo un rato: si no, un pulgar sostenido
// dispararia doce veces por segundo.
const ENFRIAMIENTO_MS = 1500;
// Por debajo de esto el clasificador esta adivinando.
const CONFIANZA_MINIMA = 0.45;
const RESUMEN_MS = 1000;

// El clasificador no alcanza para el pulgar arriba. Con la guitarra delante lo
// llama "None" 0.6-0.9 casi siempre y acierta un cuadro suelto con 0.5 (medido
// 2026-09-28), mientras que el pulgar abajo sale con 0.8. Y no hay segunda
// opcion que mirar: devuelve una sola categoria por mano. Lo que si sale bien
// son los 21 puntos de la mano, asi que el pulgar se reconoce tambien por
// geometria: los cuatro dedos cerrados y el pulgar estirado en vertical, por
// encima (o por debajo) de todo el resto de la mano.
//
// Puntos (MediaPipe): 0 muneca, 2-4 pulgar (MCP, IP, punta), 5/9/13/17 base de
// cada dedo, 6/10/14/18 PIP, 8/12/16/20 puntas.
const DEDOS = [[8, 6], [12, 10], [16, 14], [20, 18]];
const DEDOS_CERRADOS_MINIMOS = 3;
// El pulgar, medido desde su base, tiene que ser al menos esta fraccion del
// largo muneca -> base del medio: si no, no esta estirado.
const PULGAR_LARGO_MINIMO = 0.6;
// Y apuntar arriba o abajo: el tramo vertical, al menos esto por el horizontal.
const PULGAR_VERTICALIDAD = 1.5;
// La punta por fuera del resto de la mano, en fraccion del tamano de la mano.
const PULGAR_SOBRESALE = 0.15;
const SCORE_GEOMETRICO = 0.9;

// Los puntos vienen normalizados a 0-1 en cada eje, y el video es vertical:
// sin pasarlos a pixeles, "vertical" y "horizontal" no se pueden comparar.
function pulgarPorGeometria(puntos, ancho, alto) {
  if (!puntos || puntos.length < 21) return null;
  const p = puntos.map((q) => ({ x: q.x * ancho, y: q.y * alto }));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  const mano = dist(p[0], p[9]);
  if (mano < 1) return null;

  let cerrados = 0;
  for (const [punta, pip] of DEDOS) {
    if (dist(p[punta], p[0]) < dist(p[pip], p[0])) cerrados += 1;
  }
  if (cerrados < DEDOS_CERRADOS_MINIMOS) return null;

  const dx = p[4].x - p[2].x;
  const dy = p[4].y - p[2].y;
  if (Math.hypot(dx, dy) < PULGAR_LARGO_MINIMO * mano) return null;
  if (Math.abs(dy) < PULGAR_VERTICALIDAD * Math.abs(dx)) return null;

  const resto = p.filter((_, i) => i > 4);
  const margen = PULGAR_SOBRESALE * mano;
  // En la imagen la y crece hacia abajo.
  if (dy < 0 && p[4].y < Math.min(...resto.map((q) => q.y)) - margen) return "Thumb_Up";
  if (dy > 0 && p[4].y > Math.max(...resto.map((q) => q.y)) + margen) return "Thumb_Down";
  return null;
}

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
  let ultimoPulgar = 0;        // ultima vez que se vio un pulgar, aunque sea un cuadro
  let dormido = false;

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
  let porGeometria = 0;        // cuadros del resumen en que voto la geometria
  let msInferencia = 0;

  // Devuelve el gesto del cuadro mirando todas las manos, o null.
  function leerGesto(resultado) {
    let elegido = null;

    const manos = resultado.gestures || [];
    for (let i = 0; i < manos.length; i++) {
      const c = manos[i]?.[0];
      if (!c) continue;

      // El crudo se registra antes del umbral y de la traduccion: si el modelo
      // ve la mano pero la llama distinto, en el log se ve.
      if (c.score > mejorScore) {
        mejorScore = c.score;
        mejorNombre = c.categoryName;
      }

      let candidato = c.score >= CONFIANZA_MINIMA && TRADUCCION[c.categoryName] ? c : null;
      if (!candidato) {
        const geometrico = pulgarPorGeometria(
          resultado.landmarks?.[i],
          video.videoWidth,
          video.videoHeight
        );
        if (geometrico) {
          candidato = { categoryName: geometrico, score: SCORE_GEOMETRICO };
          porGeometria += 1;
        }
      }

      if (candidato && (!elegido || candidato.score > elegido.score)) {
        elegido = {
          nombre: TRADUCCION[candidato.categoryName],
          categoria: candidato.categoryName,
          score: candidato.score,
        };
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
    const primero = ganador ? votos.find((v) => v.nombre === ganador).ts : 0;
    return { ganador, cuenta, necesarios: votosNecesarios(votos.length), primero };
  }

  function resumir(ahora) {
    if (ahora - ultimoResumen < RESUMEN_MS) return;
    const lapso = (ahora - ultimoResumen) / 1000;
    ultimoResumen = ahora;

    const { ganador, cuenta, necesarios } = contar();
    registrar(
      `gestos: ${(inferencias / lapso).toFixed(1)}/s  ${msInferencia.toFixed(1)} ms  ` +
        `manos=${manosVistas}/${inferencias}  top=${mejorNombre} ${mejorScore.toFixed(2)}  geom=${porGeometria}  ` +
        `votos=${ganador || "-"} ${cuenta}/${necesarios}  ` +
        `video=${video.videoWidth}x${video.videoHeight} paused=${video.paused} ` +
        `saltados=${cuadrosSaltados}${dormido ? "  DORMIDO" : ""}`
    );

    inferencias = 0;
    cuadrosSaltados = 0;
    manosVistas = 0;
    mejorNombre = "-";
    mejorScore = 0;
    porGeometria = 0;
  }

  function procesar(ahora) {
    if (!corriendo) return;
    requestAnimationFrame(procesar);

    if (ahora - ultimaInferencia < (dormido ? INTERVALO_DORMIDO_MS : INTERVALO_MS)) return;

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

    if (crudo) {
      ultimoPulgar = ahora;
      if (dormido) {
        dormido = false;
        registrar(`gestos: despierto (vi ${crudo.nombre})`);
      }
    } else if (!dormido && ahora - ultimoPulgar > REPOSO_TRAS_MS) {
      dormido = true;
      registrar(`gestos: dormido, mirando cada ${INTERVALO_DORMIDO_MS} ms`);
    }

    // Un voto por inferencia, y afuera lo que se salio de la ventana.
    votos.push({ ts: ahora, nombre: crudo ? crudo.nombre : null });
    while (votos.length && ahora - votos[0].ts > VENTANA_MS) votos.shift();

    resumir(ahora);

    const { ganador, cuenta, necesarios, primero } = contar();
    // La barra llena solo cuando de verdad dispararia: votos y tiempo, los dos.
    const sostenido = ganador ? Math.min(1, (ahora - primero) / SOSTENIDO_MINIMO_MS) : 0;
    if (alCambiarCandidato) {
      alCambiarCandidato(ganador, Math.min(1, cuenta / necesarios, sostenido), crudo);
    }

    // Se solto el gesto que ya habia disparado: ya puede volver a hacerse.
    if (yaDisparado && ganador !== yaDisparado) yaDisparado = null;

    if (ganador !== ultimoAnunciado) {
      ultimoAnunciado = ganador;
      if (ganador) registrar(`gestos: juntando votos para ${ganador}`);
    }

    if (!ganador || cuenta < necesarios || sostenido < 1) return;
    if (ahora < bloqueadoHasta) return;
    if (yaDisparado === ganador) return;

    yaDisparado = ganador;
    bloqueadoHasta = ahora + ENFRIAMIENTO_MS;
    votos.length = 0;   // la ventana ya se uso; la siguiente empieza limpia
    registrar(`gestos: DISPARA ${ganador} (${cuenta}/${necesarios} votos${crudo ? `, ${crudo.categoria} ${crudo.score.toFixed(2)}` : ""})`);
    alGesto(ganador);
  }

  return {
    arrancar() {
      if (corriendo) return;
      corriendo = true;
      ultimoResumen = performance.now();
      // Arranca despierto: quien lo prende suele querer usarlo ya.
      ultimoPulgar = ultimoResumen;
      dormido = false;
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
