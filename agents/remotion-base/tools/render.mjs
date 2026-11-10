// Render final sin shell (en Windows las comillas de --props se pierden por shell).
// Uso: node tools/render.mjs <Prefijo>-<Version>-<es|en> [--sin-audio] [otros flags de remotion]
//      node tools/render.mjs Video-Corto-es --scale=0.5 --crf=30     ← render liviano para QA (~5 MB)
// Salida: out/<id-en-minúscula>.mp4
//
// El video se renderiza --muted y el audio (public/audio/mezcla-<version>.wav, de tools/mezcla.py) se pone
// con ffmpeg. NUNCA renderizar con el botón del Studio: Remotion 4.0.435 codifica el AAC con 2048 muestras
// de priming que el edit list no saltea, y el audio sale +42,7 ms tarde (medido con GCC-PHAT).
// Volumen: loudnorm a -14 LUFS / -1 dBTP (lo que esperan TikTok, Reels y Shorts).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const cli = path.join("node_modules", "@remotion", "cli", "remotion-cli.js");
const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith("--"));
if (!id) {
  console.error("Uso: node tools/render.mjs <Prefijo>-<Version>-<es|en> [--sin-audio] [flags de remotion]");
  process.exit(1);
}
const sinAudio = args.includes("--sin-audio");
const extra = args.filter((a) => a.startsWith("--") && a !== "--sin-audio");

const version = id.split("-")[1].toLowerCase(); // Video-Corto-es → corto
const audio = path.join("public", "audio", `mezcla-${version}.wav`);
mkdirSync("out", { recursive: true });
const salida = path.join("out", `${id.toLowerCase()}.mp4`);
const conAudio = !sinAudio && existsSync(audio);
if (!sinAudio && !conAudio) console.warn(`(sin ${audio}: sale mudo; correr tools/mezcla.py ${version})`);
const video = conAudio ? path.join("out", `${id.toLowerCase()}.muted.mp4`) : salida;

console.log(`→ ${id} → ${salida}`);
const r = spawnSync(process.execPath, [cli, "render", "src/index.ts", id, video, "--muted", ...extra], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
if (conAudio) {
  const m = spawnSync("ffmpeg", ["-y", "-i", video, "-i", audio, "-map", "0:v", "-map", "1:a",
    "-c:v", "copy", "-af", "loudnorm=I=-14:TP=-1:LRA=11,aresample=48000", "-c:a", "aac", "-b:a", "320k", "-shortest", "-movflags", "+faststart", salida], { stdio: "inherit" });
  if (m.status !== 0) process.exit(m.status ?? 1);
  rmSync(video, { force: true });
}
