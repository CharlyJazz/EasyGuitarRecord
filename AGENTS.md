# Instrucciones para agentes

Si te piden **hacer, editar, sincronizar, mezclar o renderizar un video** (tomas tocando, voz en off,
backing tracks, Remotion), empezá por [`agents/README.md`](agents/README.md): ahí está el flujo
completo y una skill por paso en `agents/skills/<nombre>/SKILL.md`. Leé la skill del paso antes de actuar.

## Commits y push (este repo es PÚBLICO)

- Agregar rutas **explícitas**; nunca `git add -A` / `git add .` en la raíz (puede haber cambios ajenos sin commitear).
- Antes de commitear, revisar `git diff --cached` buscando secretos y datos privados: `.env*`, certificados y
  claves (`certs/`, `*.pem`, `*.key`), tokens/passwords, `datos/` (SQLite), `grabaciones/`, `transferencias/`,
  media (mp4/wav/mp3), `node_modules/`, `out/`, rutas absolutas personales (`C:\Users\…`, `D:\…`), emails y
  datos personales del creador. Si aparece algo, no commitear y avisar.
- Después del push, verificar de verdad: `git log --oneline -3` y `git ls-remote origin main` = `git rev-parse HEAD`.
- Si el agente lo permite, hacerlo en un subagente en segundo plano ("repo manager") para no frenar el trabajo.

Si te piden trabajar en el **monitor de cámara** (server Node, páginas de `public/`), el README
principal explica la arquitectura. Levantá el server desacoplado (`npm start` en segundo plano, con
log a un archivo) y verificá que el puerto 3000 escuche; en primer plano te cuelga la terminal.
