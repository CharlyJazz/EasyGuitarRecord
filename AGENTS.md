# Instrucciones para agentes

Si te piden **hacer, editar, sincronizar, mezclar o renderizar un video** (tomas tocando, voz en off,
backing tracks, Remotion), empezá por [`agents/README.md`](agents/README.md): ahí está el flujo
completo y una skill por paso en `agents/skills/<nombre>/SKILL.md`. Leé la skill del paso antes de actuar.

Si te piden trabajar en el **monitor de cámara** (server Node, páginas de `public/`), el README
principal explica la arquitectura. Levantá el server desacoplado (`npm start` en segundo plano, con
log a un archivo) y verificá que el puerto 3000 escuche; en primer plano te cuelga la terminal.
