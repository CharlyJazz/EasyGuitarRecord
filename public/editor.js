// Sesiones del editor: video + mezcla de FL (+ guitarra sola) -> sincronizar ->
// analizar -> partitura -> Remotion. La logica pesada esta en el servidor
// (editor.js de la raiz); aca se sube, se corrige y se muestra.

const lista = document.getElementById("lista");
const sinEditor = document.getElementById("sinEditor");
const EXT_VIDEO = /\.(mp4|mov|m4v|webm)$/i;
const EXT_AUDIO = /\.(wav|mp3|flac|aif|aiff|m4a|ogg)$/i;

let archivos = [];
const subiendo = {};
// Lo ultimo que se dibujo de cada sesion: una tarjeta solo se rehace si
// cambio, asi el refresco periodico no pisa lo que se esta escribiendo.
const dibujado = new Map();

const relativo = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
function hace(fecha) {
  const min = Math.round((fecha - Date.now()) / 6e4);
  if (Math.abs(min) < 1) return "recién";
  if (Math.abs(min) < 60) return relativo.format(min, "minute");
  if (Math.abs(min) < 1440) return relativo.format(Math.round(min / 60), "hour");
  return relativo.format(Math.round(min / 1440), "day");
}

const seg = (t) => (t == null ? "—" : `${t.toFixed(3)} s`);

async function api(url, opciones = {}) {
  const res = await fetch(url, opciones);
  const cuerpo = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(cuerpo.error || `error ${res.status}`);
  return cuerpo;
}

const json = (metodo, cuerpo) => ({
  method: metodo, headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo ?? {}),
});

async function accion(promesa) {
  try {
    await promesa;
  } catch (e) {
    alert(e.message);
  }
  refrescar();
}

function subir(id, tipo, archivo) {
  subiendo[id] = { tipo, frac: 0 };
  refrescar();
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) subiendo[id] = { tipo, frac: e.loaded / e.total };
      const el = document.querySelector(`[data-id="${id}"] .progreso`);
      if (el) el.textContent = `Subiendo ${tipo}... ${((e.loaded / e.total) * 100).toFixed(0)}%`;
    };
    xhr.onloadend = () => {
      delete subiendo[id];
      if (xhr.status < 200 || xhr.status >= 300) alert(`No se pudo subir ${archivo.name} (${xhr.status})`);
      refrescar();
      resolve();
    };
    xhr.open("POST", `/api/editor/sesiones/${id}/${tipo}`);
    xhr.setRequestHeader("x-nombre", encodeURIComponent(archivo.name));
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.send(archivo);
  });
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ------------------------------------------------------------- fuentes
const ETIQUETAS = { video: "Video", audio: "Mezcla FL", guitarra: "Guitarra sola" };

function filaFuente(s, tipo) {
  const fila = el(
    `<div class="fuente"><div class="etq"></div><div class="nombre"></div>` +
    `<div class="controles"><button class="chico subir">Subir...</button>` +
    `<input type="file" accept="${tipo === "video" ? "video" : "audio"}/*">` +
    `<select class="chico elegir"><option value="">Elegir de la PC...</option></select></div></div>`);
  fila.querySelector(".etq").textContent = ETIQUETAS[tipo];
  const nombre = fila.querySelector(".nombre");
  nombre.textContent = s[`${tipo}_nombre`] || (tipo === "guitarra" ? "opcional (recomendada)" : "falta");
  if (!s[`${tipo}_nombre`]) nombre.className = `nombre ${tipo === "guitarra" ? "meta" : "aviso"}`;

  const input = fila.querySelector("input");
  fila.querySelector(".subir").onclick = () => input.click();
  input.onchange = () => input.files[0] && subir(s.id, tipo, input.files[0]);

  const select = fila.querySelector("select");
  for (const a of archivos.filter((a) => a.tipo === (tipo === "video" ? "video" : "audio"))) {
    const op = document.createElement("option");
    op.value = JSON.stringify({ carpeta: a.carpeta, nombre: a.nombre });
    op.textContent = `${a.carpeta}/${a.nombre}`;
    select.append(op);
  }
  select.onchange = () => select.value &&
    accion(api(`/api/editor/sesiones/${s.id}/${tipo}/desde`, json("POST", JSON.parse(select.value))));
  if (tipo === "guitarra" && s.guitarra_nombre) {
    const quitar = el('<button class="chico borrar">Quitar</button>');
    quitar.onclick = () => accion(api(`/api/editor/sesiones/${s.id}/guitarra`, { method: "DELETE" }));
    fila.querySelector(".controles").append(quitar);
  }
  return fila;
}

// ------------------------------------------------------------- campos
function campo(etiqueta, valor, { paso = 0.001, ayuda = "", extra = [] } = {}) {
  const c = el(`<label class="campo"><span></span><span class="linea"><input class="num" type="number"></span></label>`);
  c.querySelector("span").textContent = etiqueta;
  const input = c.querySelector("input");
  input.step = paso;
  input.value = valor ?? "";
  const linea = c.querySelector(".linea");
  for (const b of extra) linea.append(b);
  if (ayuda) linea.append(Object.assign(document.createElement("span"), { className: "meta", textContent: ayuda }));
  return { c, input };
}

// ------------------------------------------------------- vista previa
let alphaTab = null;
const cargarAlphaTab = async () => (alphaTab ??= await import("/alphatab/alphaTab.mjs"));

async function previa(contenedor, alphatex) {
  const at = await cargarAlphaTab();
  const s = new at.Settings();
  s.core.engine = "svg";
  s.core.useWorkers = false;
  // Sin carga diferida: con ella alphaTab dibuja solo lo visible y la fila
  // horizontal quedaba en blanco (lo mismo que en Remotion).
  s.core.enableLazyLoading = false;
  s.core.fontDirectory = "/alphatab/font/";
  s.core.logLevel = at.LogLevel.Warning;
  s.player.enablePlayer = false;
  s.display.layoutMode = at.LayoutMode.Horizontal;
  s.display.scale = 0.9;
  const blanco = new at.model.Color(235, 235, 235, 255);
  const gris = new at.model.Color(140, 140, 140, 255);
  Object.assign(s.display.resources, {
    mainGlyphColor: blanco, secondaryGlyphColor: gris, staffLineColor: gris, barSeparatorColor: gris, barNumberColor: gris,
  });
  const div = document.createElement("div");
  contenedor.replaceChildren(div);
  const api = new at.AlphaTabApi(div, s);
  api.error.on((e) => (contenedor.innerHTML = `<pre class="malo">${String(e?.message || e)}</pre>`));
  api.tex(alphatex);
}

// ------------------------------------------------------------ tarjeta
function tarjeta(s) {
  const t = el(
    `<div class="sesion"><div class="cabeza"><span class="alias"></span><span class="uuid"></span>` +
    `<span class="meta creada"></span><span class="meta progreso"></span>` +
    `<span style="flex:1"></span><button class="chico borrar">Borrar</button></div></div>`);
  t.dataset.id = s.id;
  t.querySelector(".alias").textContent = s.alias;
  t.querySelector(".alias").title = "Decile a Claude este alias para trabajar sobre esta sesion";
  t.querySelector(".uuid").textContent = s.id;
  t.querySelector(".creada").textContent = `creada ${hace(s.creado)}`;
  t.querySelector(".borrar").onclick = () => confirm(`¿Borrar la sesion ${s.alias} y todo lo generado?`) &&
    accion(api(`/api/editor/sesiones/${s.id}`, { method: "DELETE" }));
  const ocupada = s.corriendo || !!subiendo[s.id];

  // 1. fuentes
  const p1 = el('<div class="paso"><h3>1 · Archivos</h3></div>');
  p1.append(filaFuente(s, "video"), filaFuente(s, "audio"), filaFuente(s, "guitarra"));
  t.append(p1);

  // 2. sync
  const p2 = el('<div class="paso"><h3>2 · Sincronizar</h3><div class="fila"></div><div class="resultado"></div></div>');
  const sync = (force) => () => accion(api(`/api/editor/sesiones/${s.id}/sincronizar`, json("POST", { force })));
  const bSync = el(`<button class="chico ${s.sync_estado === "lista" ? "" : "principal"}">Sincronizar</button>`);
  bSync.disabled = ocupada || !s.video_archivo || !s.audio_archivo;
  bSync.onclick = sync(false);
  p2.querySelector(".fila").append(bSync);
  const r2 = p2.querySelector(".resultado");
  if (s.sync_estado === "corriendo") r2.textContent = "Sincronizando...";
  else if (s.sync_estado === "lista") {
    r2.className = "resultado bueno";
    r2.textContent = `La mezcla empieza en ${seg(s.offset_video_s)} del video · pico ${s.confianza?.toFixed(0)}` +
      (s.deriva_ppm != null ? ` · deriva ${s.deriva_ppm.toFixed(1)} ppm` : "") +
      (s.offset_guitarra_s != null ? ` · guitarra sola a ${(s.offset_guitarra_s * 1000).toFixed(1)} ms de la mezcla` : "");
  } else if (s.sync_estado === "dudosa") {
    r2.className = "resultado aviso";
    r2.textContent = "Sincronizacion dudosa: no se escribio nada. Puede que el telefono no haya escuchado " +
      "bien la guitarra, o que el audio no sea de esta toma.";
    const bForce = el('<button class="chico">Generar igual</button>');
    bForce.disabled = ocupada;
    bForce.onclick = sync(true);
    p2.querySelector(".fila").append(bForce);
  } else if (s.sync_estado === "error" || s.sync_estado === "cortado") {
    r2.className = "resultado malo";
    r2.textContent = s.sync_estado === "cortado" ? "Se corto (se reinicio el servidor)." : "Fallo; ver el detalle abajo.";
  }
  t.append(p2);

  // 3-5. analisis
  const p3 = el('<div class="paso"><h3>3 · Analizar: cinta, tempo y el "1"</h3><div class="fila"></div><div class="resultado"></div></div>');
  const bAn = el(`<button class="chico ${s.analisis_estado === "listo" ? "" : "principal"}">Analizar</button>`);
  bAn.disabled = ocupada || s.sync_estado !== "lista";
  bAn.onclick = () => accion(api(`/api/editor/sesiones/${s.id}/analizar`, { method: "POST" }));
  p3.querySelector(".fila").append(bAn);
  const r3 = p3.querySelector(".resultado");
  if (s.analisis_estado === "corriendo") r3.textContent = "Analizando (transcripcion + tempo, ~30 s)...";
  else if (s.analisis_estado === "error" || s.analisis_estado === "cortado") {
    r3.className = "resultado malo";
    r3.textContent = "El analisis fallo; ver el detalle abajo.";
  } else if (s.analisis_estado === "listo") {
    r3.className = `resultado ${s.analisis_fuente === "mezcla" ? "aviso" : "bueno"}`;
    r3.textContent = `Cinta: ${s.notas_crudas} notas crudas -> ${s.notas_revisadas} revisadas` +
      (s.analisis_fuente === "mezcla" ? " · salio de la MEZCLA: subi la guitarra sola para que no haya notas falsas" : " · de la guitarra sola");

    const fps = s.fps || 30;
    const inicio = campo("Empieza a tocar (s en la mezcla)", s.when_start_playing_guitar,
      { ayuda: s.when_start_playing_guitar_frame != null ? `frame ${s.when_start_playing_guitar_frame}` : "" });
    const fin = campo("Termina (s en la mezcla)", s.when_stop_playing_guitar,
      { ayuda: s.when_stop_playing_guitar_frame != null ? `frame ${s.when_stop_playing_guitar_frame}` : "" });
    const bpm = campo("BPM", s.bpm, { paso: 0.01 });
    const menos = el('<button class="chico" title="Correr el 1 un tiempo antes">−1</button>');
    const mas = el('<button class="chico" title="Correr el 1 un tiempo despues">+1</button>');
    const uno = campo('Donde cae el "1" (s)', s.primer_tiempo_s, { extra: [menos, mas] });
    const correr = (n) => () => {
      const negra = 60 / Number(bpm.input.value || s.bpm);
      uno.input.value = (Number(uno.input.value) + n * negra).toFixed(4);
    };
    menos.onclick = correr(-1);
    mas.onclick = correr(1);
    const acc = el('<label class="campo"><span>Alteraciones</span><select class="chico"><option value="sostenidos">sostenidos (#)</option><option value="bemoles">bemoles (b)</option></select></label>');
    acc.querySelector("select").value = s.accidentales || "sostenidos";
    // Swing: null = que lo detecte buildAlphaTab; 0.5 = recto (un swing sale en tresillos);
    // un numero = la fase de la corchea del contratiempo (0.667 = 2 a 1).
    const sw = el('<label class="campo"><span>Swing</span><select class="chico"><option value="">detectar</option>' +
      '<option value="0.5">recto (tresillos)</option><option value="0.6">swing suave (60 %)</option>' +
      '<option value="0.667">swing 2:1</option><option value="0.75">swing duro (3:1)</option></select></label>');
    const swSel = sw.querySelector("select");
    swSel.value = s.swing == null ? "" : String(s.swing);
    if (swSel.value !== String(s.swing ?? "")) {
      swSel.append(el(`<option value="${s.swing}">${Math.round(s.swing * 100)} %</option>`));
      swSel.value = String(s.swing);
    }
    const enc = el('<label class="campo"><span>Encuadre (video horizontal)</span><span class="linea"><input type="range" min="0" max="1" step="0.01"><span class="meta"></span></span></label>');
    const rango = enc.querySelector("input");
    rango.value = s.encuadre_x ?? 0.5;
    const etq = enc.querySelector(".meta");
    etq.textContent = `${Math.round(rango.value * 100)}%`;
    rango.oninput = () => (etq.textContent = `${Math.round(rango.value * 100)}%`);

    const campos = el('<div class="campos"></div>');
    campos.append(inicio.c, fin.c, bpm.c, uno.c, acc, sw, enc);
    p3.append(campos);
    const guardar = el('<button class="chico principal">Guardar y rehacer la partitura</button>');
    guardar.disabled = ocupada;
    guardar.onclick = () => accion((async () => {
      await api(`/api/editor/sesiones/${s.id}`, json("PATCH", {
        when_start_playing_guitar: Number(inicio.input.value),
        when_stop_playing_guitar: Number(fin.input.value),
        bpm: Number(bpm.input.value),
        primer_tiempo_s: Number(uno.input.value),
        accidentales: acc.querySelector("select").value,
        swing: swSel.value === "" ? null : Number(swSel.value),
        encuadre_x: Number(rango.value),
      }));
      await api(`/api/editor/sesiones/${s.id}/partitura`, { method: "POST" });
    })());
    p3.append(Object.assign(el('<div class="fila"></div>'), {}));
    p3.lastChild.append(guardar);
  }
  t.append(p3);

  // 4. partitura
  if (s.partitura) {
    const p4 = el('<div class="paso"><h3>4 · Partitura</h3><div class="resultado meta"></div><div class="preview"></div>' +
      '<details><summary>alphaTex (editable)</summary><textarea spellcheck="false"></textarea>' +
      '<div class="fila"><button class="chico principal">Guardar alphaTex</button></div></details></div>');
    const quien = { buildAlphaTab: "generada por buildAlphaTab", agente: "corregida por Claude", ui: "editada a mano" }[s.partitura.autor] || s.partitura.autor;
    p4.querySelector(".resultado").textContent = `${quien}, ${hace(s.partitura.creada)} · para corregir la cinta nota por nota, pedile a Claude "revisá la cinta de ${s.alias}"`;
    const prev = p4.querySelector(".preview");
    const area = p4.querySelector("textarea");
    api(`/api/editor/sesiones/${s.id}/partitura`).then((p) => {
      area.textContent = p.alphatex;
      previa(prev, p.alphatex).catch((e) => (prev.textContent = e.message));
    }).catch(() => {});
    p4.querySelector("details button").onclick = () =>
      accion(api(`/api/editor/sesiones/${s.id}/partitura`, json("PUT", { alphatex: area.value, autor: "ui" })));
    t.append(p4);
  }

  // 5. remotion
  const p5 = el('<div class="paso"><h3>5 · Video</h3><div class="fila"></div><div class="resultado"></div></div>');
  const fila5 = p5.querySelector(".fila");
  const abrir = el(`<button class="chico ${s.partitura ? "principal" : ""}">Abrir en Remotion</button>`);
  abrir.disabled = ocupada || s.sync_estado !== "lista";
  abrir.onclick = async () => {
    // La ventana se abre dentro del click; si se abre despues del await el
    // navegador la bloquea como popup.
    const ventana = window.open("about:blank", "_blank");
    try {
      const { url } = await api("/api/editor/studio", { method: "POST" });
      ventana.location = `${url}/Sesion-${s.id}`;
    } catch (e) {
      ventana.close();
      alert(e.message);
    }
  };
  const render = el('<button class="chico">Renderizar</button>');
  render.disabled = ocupada || s.sync_estado !== "lista";
  render.onclick = () => accion(api(`/api/editor/sesiones/${s.id}/render`, { method: "POST" }));
  fila5.append(abrir, render);
  if (s.renderListo && s.render_estado !== "corriendo") {
    fila5.append(Object.assign(el('<a class="chico">Bajar MP4</a>'), { href: `/api/editor/sesiones/${s.id}/render` }));
  }
  const r5 = p5.querySelector(".resultado");
  if (s.render_estado === "corriendo") r5.textContent = "Renderizando (~1-2 min)...";
  else if (s.render_estado === "error") {
    r5.className = "resultado malo";
    r5.textContent = "El render fallo; ver el detalle.";
  }
  r5.append(Object.assign(el('<div class="meta"></div>'), {
    textContent: "No uses el boton Render del Studio: corre el audio 42,7 ms. Renderizar desde aca.",
  }));
  t.append(p5);

  if (s.log) {
    const d = el("<details><summary>Detalle del ultimo proceso</summary><pre></pre></details>");
    d.querySelector("pre").textContent = s.log;
    t.append(d);
  }

  // Soltar archivos sobre la tarjeta: video por extension; de audio, el
  // primero es la mezcla y el segundo la guitarra sola (o por nombre).
  for (const ev of ["dragenter", "dragover"]) t.addEventListener(ev, (e) => { e.preventDefault(); t.classList.add("encima"); });
  for (const ev of ["dragleave", "drop"]) t.addEventListener(ev, (e) => { e.preventDefault(); t.classList.remove("encima"); });
  t.addEventListener("drop", async (e) => {
    const audios = [];
    for (const archivo of e.dataTransfer?.files || []) {
      if (EXT_VIDEO.test(archivo.name)) await subir(s.id, "video", archivo);
      else if (EXT_AUDIO.test(archivo.name)) audios.push(archivo);
      else alert(`${archivo.name}: no es ni video ni audio`);
    }
    const esGuitarra = (a) => /guitar|guitarra|solo/i.test(a.name);
    audios.sort((a, b) => esGuitarra(a) - esGuitarra(b));
    for (const [i, a] of audios.entries()) await subir(s.id, i === 0 && !esGuitarra(a) ? "audio" : "guitarra", a);
  });
  return t;
}

// ----------------------------------------------------------- refresco
let reloj = null;

async function refrescar() {
  clearTimeout(reloj);
  let datos;
  try {
    [datos, archivos] = await Promise.all([api("/api/editor"), api("/api/editor/archivos")]);
  } catch {
    reloj = setTimeout(refrescar, 5000);
    return;
  }
  if (!datos.disponible) {
    sinEditor.style.display = "block";
    sinEditor.textContent = `No encuentro el proyecto de Remotion en ${datos.raiz}. ` +
      "Configura la variable GUITAR_EDITOR al arrancar el servidor.";
    return;
  }
  const vivos = new Set(datos.sesiones.map((s) => s.id));
  for (const nodo of [...lista.children]) {
    if (!vivos.has(nodo.dataset.id)) {
      nodo.remove();
      dibujado.delete(nodo.dataset.id);
    }
  }
  let anterior = null;
  for (const s of datos.sesiones) {
    const firma = JSON.stringify({ ...s, sub: !!subiendo[s.id] });
    let nodo = lista.querySelector(`[data-id="${s.id}"]`);
    // No rehacer una tarjeta sin cambios, ni una donde se esta escribiendo.
    const editando = nodo && nodo.contains(document.activeElement) && document.activeElement !== document.body;
    const abiertos = nodo ? [...nodo.querySelectorAll("details")].map((d) => d.open) : [];
    if (!nodo || (dibujado.get(s.id) !== firma && !editando)) {
      const nuevo = tarjeta(s);
      nuevo.querySelectorAll("details").forEach((d, i) => abiertos[i] && (d.open = true));
      if (nodo) nodo.replaceWith(nuevo);
      nodo = nuevo;
      dibujado.set(s.id, firma);
    }
    if (anterior ? anterior.nextSibling !== nodo : lista.firstChild !== nodo) {
      anterior ? anterior.after(nodo) : lista.prepend(nodo);
    }
    anterior = nodo;
  }
  const trabajando = datos.sesiones.some((s) => s.corriendo);
  reloj = setTimeout(refrescar, trabajando ? 1500 : 5000);
}

document.getElementById("btnNueva").onclick = () => accion(api("/api/editor/sesiones", { method: "POST" }));

window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

refrescar();
