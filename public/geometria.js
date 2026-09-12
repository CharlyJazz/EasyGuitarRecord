// Geometria de la mano sobre los 21 puntos de MediaPipe.
//
// Sin dependencias del navegador a proposito: asi se puede probar en Node.

// Indices del modelo: 0 es la muñeca; por dedo, la punta y la articulacion
// media. El pulgar queda afuera porque para "palma abierta" no hace falta y es
// el que mas se confunde segun el angulo.
const DEDOS = [
  [8, 6],    // indice
  [12, 10],  // medio
  [16, 14],  // anular
  [20, 18],  // meñique
];

// Margen para no contar como estirado un dedo apenas mas lejos por ruido.
const MARGEN = 1.08;

// Se mide distancia a la muñeca y no coordenadas Y: asi da igual el angulo de
// la mano, que es justo lo que rompe los metodos que miran arriba/abajo.
export function dedosEstirados(puntos) {
  const muñeca = puntos[0];
  const d = (p) => Math.hypot(p.x - muñeca.x, p.y - muñeca.y);
  let n = 0;
  for (const [punta, media] of DEDOS) {
    if (d(puntos[punta]) > d(puntos[media]) * MARGEN) n += 1;
  }
  return n;
}

// Cuatro dedos estirados es una palma abierta. El clasificador de MediaPipe
// etiqueta esto como None mas seguido de lo aceptable, y este respaldo es
// determinista.
export const DEDOS_PARA_PALMA = 4;

// Tamaño de la mano en el cuadro: distancia de la muñeca al nudillo del dedo
// medio, en coordenadas normalizadas (0 a 1 sobre el alto/ancho del video).
//
// Sirve para distinguir un high five deliberado, que se hace cerca de la
// camara, de una mano cualquiera que aparece lejos mientras se toca. Es la
// diferencia entre "me esta haciendo una seña" y "esta tocando".
const NUDILLO_MEDIO = 9;

export function tamañoMano(puntos) {
  const muñeca = puntos[0];
  const nudillo = puntos[NUDILLO_MEDIO];
  return Math.hypot(nudillo.x - muñeca.x, nudillo.y - muñeca.y);
}

// Apertura de la mano: distancia entre la punta del indice y la del meñique,
// relativa al tamaño de la mano.
//
// Es lo que separa una palma abierta de unos dedos sobre el diapason. Los dos
// tienen cuatro dedos estirados -- por eso contar dedos no alcanza -- pero en
// el mastil los dedos van juntos y paralelos, y en un high five van abiertos
// en abanico.
const PUNTA_INDICE = 8;
const PUNTA_MEÑIQUE = 20;

export function aperturaDedos(puntos) {
  const tamaño = tamañoMano(puntos);
  if (tamaño <= 0) return 0;
  const a = puntos[PUNTA_INDICE];
  const b = puntos[PUNTA_MEÑIQUE];
  return Math.hypot(a.x - b.x, a.y - b.y) / tamaño;
}

export function esPalmaAbierta(puntos) {
  return dedosEstirados(puntos) >= DEDOS_PARA_PALMA;
}
