// Manda los logs del navegador a la consola del servidor.
//
// El monitor corre en Chrome en la PC y el emisor en Safari en el telefono: no
// hay una sola consola donde mirar las dos puntas. Esto junta todo en la
// terminal donde corre `npm start`.

const cola = [];
let temporizador = null;
let etiqueta = "web";

export function ponerEtiqueta(nombre) {
  etiqueta = nombre;
}

function vaciar() {
  temporizador = null;
  if (!cola.length) return;

  const lineas = cola.splice(0, cola.length);
  // keepalive para que las ultimas lineas salgan aunque la pagina se este
  // cerrando, que es justo cuando mas interesa el log.
  fetch("/api/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ etiqueta, lineas }),
    keepalive: true,
  }).catch(() => {
    // Si el servidor no esta, no hay nada que hacer y no vale la pena romper
    // la pagina por un log.
  });
}

export function registrar(...partes) {
  const texto = partes
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ");

  console.log(`[${etiqueta}]`, texto);
  cola.push(texto);
  if (cola.length > 200) cola.splice(0, cola.length - 200);

  // Agrupado: una linea por cuadro inundaria la red y la terminal.
  if (!temporizador) temporizador = setTimeout(vaciar, 400);
}

// Los errores que nadie atrapa son los que mas cuesta ver en el telefono.
window.addEventListener("error", (e) => {
  registrar(`ERROR ${e.message} (${e.filename}:${e.lineno})`);
});
window.addEventListener("unhandledrejection", (e) => {
  registrar(`PROMESA RECHAZADA ${e.reason?.message || e.reason}`);
});
window.addEventListener("pagehide", vaciar);
