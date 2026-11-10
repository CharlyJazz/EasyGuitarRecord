// Copia la fuente musical de alphaTab (Bravura) a public/alphatab/font/: Remotion solo sirve lo que
// está en public/, y sin la fuente <Partitura> no dibuja nada (timeout de delayRender).
import { cpSync, existsSync } from "node:fs";
import path from "node:path";

const desde = path.join("node_modules", "@coderline", "alphatab", "dist", "font");
const hasta = path.join("public", "alphatab", "font");
if (existsSync(desde)) {
  cpSync(desde, hasta, { recursive: true });
  console.log(`fuente de alphaTab → ${hasta}`);
} else {
  console.warn(`(no está ${desde}: ¿falta npm install?)`);
}
