// WebSocket que se vuelve a conectar solo.
//
// El caso que hay que cubrir no es "se cayo la WiFi": en iOS alcanza con que
// la pantalla se bloquee o Safari pase a segundo plano para que el sistema
// suspenda la pagina y mate el socket. Al volver hay que rearmar todo sin que
// el usuario tenga que recargar nada.

const ESPERA_INICIAL_MS = 500;
const ESPERA_MAXIMA_MS = 5000;

export function crearSocket({ ruta = "", alAbrir, alMensaje, alCambiarEstado }) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}${ruta}`;

  let ws = null;
  let espera = ESPERA_INICIAL_MS;
  let temporizador = null;
  let cerradoAdrede = false;
  let intentos = 0;

  function avisar(estado, detalle) {
    if (alCambiarEstado) alCambiarEstado(estado, detalle);
  }

  function conectar() {
    clearTimeout(temporizador);
    if (cerradoAdrede) return;

    intentos += 1;
    avisar(intentos === 1 ? "conectando" : "reconectando", { intentos });

    ws = new WebSocket(url);

    ws.onopen = () => {
      espera = ESPERA_INICIAL_MS; // backoff limpio para la proxima caida
      intentos = 0;
      avisar("abierto");
      if (alAbrir) alAbrir();
    };

    ws.onmessage = (evento) => {
      if (alMensaje) alMensaje(evento);
    };

    // onclose llega siempre, tambien despues de un error, asi que el reintento
    // vive solo aca y no se duplica.
    ws.onclose = (evento) => {
      if (cerradoAdrede) return;
      avisar("cerrado", { codigo: evento.code, motivo: evento.reason });
      reintentar();
    };

    ws.onerror = () => {
      // El detalle del error no se expone por seguridad; el cierre siguiente
      // es el que trae el codigo.
    };
  }

  function reintentar() {
    clearTimeout(temporizador);
    // Crecimiento geometrico con techo: reconecta rapido cuando fue un
    // parpadeo, y no martilla al servidor cuando esta realmente caido.
    temporizador = setTimeout(conectar, espera);
    espera = Math.min(espera * 2, ESPERA_MAXIMA_MS);
  }

  // Volver del bloqueo de pantalla es el momento exacto en que hay que
  // reconectar, sin esperar al backoff.
  function despertar() {
    if (document.visibilityState !== "visible") return;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      espera = ESPERA_INICIAL_MS;
      conectar();
    }
  }

  document.addEventListener("visibilitychange", despertar);
  window.addEventListener("online", despertar);
  window.addEventListener("pageshow", despertar);

  conectar();

  return {
    enviar(objeto) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(objeto));
        return true;
      }
      return false; // el que llama decide si vale la pena reintentar
    },
    get listo() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
    cerrar() {
      cerradoAdrede = true;
      clearTimeout(temporizador);
      if (ws) ws.close();
    },
  };
}

// Mantener la pantalla encendida mientras se transmite. Sin esto, iOS bloquea
// la pantalla sola, suspende la pagina y corta la camara: desde el otro lado
// se ve identico a una caida de red.
export async function mantenerPantallaEncendida(alFallar) {
  if (!("wakeLock" in navigator)) return null;

  let bloqueo = null;

  async function pedir() {
    try {
      bloqueo = await navigator.wakeLock.request("screen");
      bloqueo.addEventListener("release", () => { bloqueo = null; });
    } catch (err) {
      if (alFallar) alFallar(err);
    }
  }

  // iOS suelta el wake lock al pasar a segundo plano y no lo devuelve solo.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !bloqueo) pedir();
  });

  await pedir();
  return () => bloqueo && bloqueo.release();
}
