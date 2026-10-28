// Sube archivos del telefono a la PC (y los baja) por la red local.
//
// Se usa XMLHttpRequest y no fetch a proposito: fetch no informa el progreso
// de **subida**, y sin barra un video de 2 GB parece colgado. XHR manda el
// File tal cual como cuerpo (`xhr.send(file)`), que ademas es streaming: el
// archivo no se carga entero en memoria del telefono.

const cola = document.getElementById("cola");
const vacioCola = document.getElementById("vacioCola");
const lista = document.getElementById("lista");
const soltar = document.getElementById("soltar");
const inputMedia = document.getElementById("inputMedia");
const inputArchivos = document.getElementById("inputArchivos");

const tamano = (b) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` :
  b >= 1e3 ? `${(b / 1e3).toFixed(0)} kB` : `${b} B`;

function duracion(seg) {
  if (!isFinite(seg) || seg < 0) return "";
  const m = Math.floor(seg / 60);
  const s = Math.round(seg % 60);
  return m ? `${m} min ${s} s` : `${s} s`;
}

// "hace 2 minutos", "ayer", "hace 3 dias". Intl.RelativeTimeFormat ya viene en
// el navegador (Safari 14+) y hace lo mismo que timeago.js, sin dependencia.
const relativo = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
const UNIDADES = [
  ["year", 365 * 864e5], ["month", 30 * 864e5], ["week", 7 * 864e5],
  ["day", 864e5], ["hour", 36e5], ["minute", 6e4],
];

function hace(fecha) {
  const ms = fecha - Date.now();
  if (Math.abs(ms) < 45e3) return "recién";
  for (const [unidad, largo] of UNIDADES) {
    if (Math.abs(ms) >= largo) return relativo.format(Math.round(ms / largo), unidad);
  }
  return relativo.format(Math.round(ms / 6e4), "minute");
}

// --------------------------------------------------------------- wake lock
// iOS suspende la pagina cuando la pantalla se bloquea, y ahi se corta la
// subida a medio camino. Mientras haya cola, se pide mantener la pantalla
// despierta; iOS suelta el permiso al pasar a segundo plano y no lo devuelve
// solo, asi que se vuelve a pedir al reaparecer.
let bloqueo = null;

async function pedirBloqueo() {
  if (!("wakeLock" in navigator) || bloqueo) return;
  try {
    bloqueo = await navigator.wakeLock.request("screen");
    bloqueo.addEventListener("release", () => (bloqueo = null));
  } catch {
    bloqueo = null; // sin permiso; la subida igual sigue si la pantalla queda prendida
  }
}

function soltarBloqueo() {
  bloqueo?.release().catch(() => {});
  bloqueo = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && pendientes.length) pedirBloqueo();
});

// ------------------------------------------------------------------ subida
const pendientes = [];
let subiendo = false;

function encolar(archivos) {
  for (const archivo of archivos) pendientes.push(archivo);
  if (pendientes.length) {
    vacioCola.hidden = true;
    pedirBloqueo();
  }
  siguiente();
}

function siguiente() {
  if (subiendo) return;
  const archivo = pendientes.shift();
  if (!archivo) {
    subiendo = false;
    soltarBloqueo();
    if (!cola.querySelector(".tarjeta")) vacioCola.hidden = false;
    return;
  }
  subiendo = true;
  subir(archivo).finally(() => {
    subiendo = false;
    refrescar();
    siguiente();
  });
}

function subir(archivo) {
  const tarjeta = document.createElement("div");
  tarjeta.className = "tarjeta";
  tarjeta.innerHTML =
    `<div class="fila"><div class="nombre"></div></div>` +
    `<div class="meta"></div><div class="barra"><i></i></div>`;
  tarjeta.querySelector(".nombre").textContent = archivo.name;
  const meta = tarjeta.querySelector(".meta");
  const barra = tarjeta.querySelector(".barra > i");
  meta.textContent = `${tamano(archivo.size)} - esperando`;
  cola.prepend(tarjeta);

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const arranque = performance.now();

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const frac = e.loaded / e.total;
      barra.style.width = `${(frac * 100).toFixed(1)}%`;
      const seg = (performance.now() - arranque) / 1000;
      const vel = e.loaded / Math.max(seg, 0.001);
      const resta = (e.total - e.loaded) / Math.max(vel, 1);
      meta.textContent =
        `${tamano(e.loaded)} de ${tamano(e.total)} - ` +
        `${(vel / 1e6).toFixed(1)} MB/s - faltan ${duracion(resta)}`;
    };

    xhr.onload = () => {
      const seg = (performance.now() - arranque) / 1000;
      if (xhr.status >= 200 && xhr.status < 300) {
        tarjeta.classList.add("listo");
        barra.style.width = "100%";
        meta.className = "meta bueno";
        meta.textContent =
          `Listo - ${tamano(archivo.size)} en ${duracion(seg)} ` +
          `(${(archivo.size / 1e6 / Math.max(seg, 0.001)).toFixed(1)} MB/s)`;
      } else {
        tarjeta.classList.add("error");
        meta.className = "meta malo";
        meta.textContent = `Fallo (${xhr.status})`;
      }
      resolve();
    };

    xhr.onerror = () => {
      tarjeta.classList.add("error");
      meta.className = "meta malo";
      meta.textContent = "Fallo la conexion";
      resolve();
    };

    xhr.open("POST", "/api/transferencias");
    // El nombre viaja en un header, asi que hay que escaparlo: un header solo
    // admite ASCII y los nombres vienen con tildes y espacios.
    xhr.setRequestHeader("x-nombre", encodeURIComponent(archivo.name));
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.send(archivo);
  });
}

// ------------------------------------------------------------------- lista
async function refrescar() {
  let archivos = [];
  try {
    archivos = await (await fetch("/api/transferencias")).json();
  } catch {
    return;
  }

  lista.textContent = "";
  for (const a of archivos) {
    const tarjeta = document.createElement("div");
    tarjeta.className = "tarjeta";
    tarjeta.innerHTML =
      `<div class="fila">` +
      `  <div><div class="nombre"></div><div class="meta"></div></div>` +
      `  <div style="flex:1"></div>` +
      `  <a class="chico" download>Bajar</a>` +
      `  <button class="chico borrar">Borrar</button>` +
      `</div>`;
    tarjeta.querySelector(".nombre").textContent = a.nombre;
    // Lista cada 5 s, asi que el "hace X" se actualiza solo; la fecha exacta
    // queda en el tooltip.
    const meta = tarjeta.querySelector(".meta");
    meta.textContent = `${tamano(a.bytes)} - ${hace(a.fecha)}`;
    meta.title = new Date(a.fecha).toLocaleString();

    const url = `/api/transferencias/${encodeURIComponent(a.nombre)}`;
    tarjeta.querySelector("a.chico").href = url;

    tarjeta.querySelector("button.borrar").onclick = async () => {
      if (!confirm(`¿Borrar ${a.nombre}?`)) return;
      await fetch(url, { method: "DELETE" });
      refrescar();
    };

    lista.append(tarjeta);
  }
}

// ------------------------------------------------------------------ eventos
document.getElementById("btnMedia").onclick = () => inputMedia.click();
document.getElementById("btnArchivos").onclick = () => inputArchivos.click();

for (const input of [inputMedia, inputArchivos]) {
  input.onchange = () => {
    encolar(input.files);
    input.value = ""; // para poder elegir el mismo archivo otra vez
  };
}

// Arrastrar y soltar, para dejar desde la PC lo que el telefono va a bajar.
for (const ev of ["dragenter", "dragover"]) {
  soltar.addEventListener(ev, (e) => {
    e.preventDefault();
    soltar.classList.add("encima");
  });
}
for (const ev of ["dragleave", "drop"]) {
  soltar.addEventListener(ev, (e) => {
    e.preventDefault();
    soltar.classList.remove("encima");
  });
}
soltar.addEventListener("drop", (e) => {
  if (e.dataTransfer?.files?.length) encolar(e.dataTransfer.files);
});
// Sin esto, soltar el archivo fuera del recuadro hace que el navegador lo abra
// y se pierda la pagina a mitad de una subida.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

refrescar();
setInterval(refrescar, 5000);
