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

export function esPalmaAbierta(puntos) {
  return dedosEstirados(puntos) >= DEDOS_PARA_PALMA;
}
