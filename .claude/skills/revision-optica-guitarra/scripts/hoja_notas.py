"""Hoja de contactos con UN cuadro por nota de la cinta, recortado al mástil y etiquetado.

Cada celda: el cuadro del video en un ataque (una nota o un acorde) (frame calculado por el servidor:
round((t_s + offset_video_s) * fps)), con "#índice  tiempo_video  frame  nota  [traste.cuerda]" y
abajo las posiciones posibles de esa altura (traste.cuerda). Así se mira la mano justo cuando
suena cada nota y solo hay que elegir la candidata que cae en la ventana de la mano.

Tokens: una imagen cuesta por área. El recorte por defecto deja solo el mástil (sin la cara ni la
mano que pulsa) y cada celda va a 520 px: alcanza para contar alambres hasta el traste 15.
--saltear-unicas deja afuera las notas que tienen una sola posición posible.

Uso:
  python hoja_notas.py SESION [--desde S --hasta S] [--crop W:H:X:Y] [--antes N] [--cols 3]
                       [--max 24] [--version revisada|cruda] [--ancho 520] [--saltear-unicas]
                       [--out hoja.png]

  SESION   uuid o alias de 8 caracteres de editor.html
  --desde/--hasta  en segundos de la MEZCLA (los mismos de la cinta)
  --crop   recorte de ffmpeg sobre el video de la sesión (1920x1080 si la fuente es horizontal)
  --antes  cuadros antes del ataque (el dedo ya está apoyado; la mano que pulsa sale movida)

Sin dependencias: Python estándar + ffmpeg. drawtext necesita la fuente explícita: sin
fontfile, el ffmpeg de esta PC se cae con "Fontconfig error" y segfault.
"""
import argparse, json, os, ssl, subprocess, sys, tempfile, urllib.request

API = "https://localhost:3000/api/editor"
EDITOR = os.environ.get("GUITAR_EDITOR", r"E:\MY MUSIC SOFTWARE\GuitarVideoEditorRemotion")
FUENTE = r"C\:/Windows/Fonts/arial.ttf"  # el ":" de la unidad va escapado para el filtro de ffmpeg
NOMBRES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
AFINACION = [64, 59, 55, 50, 45, 40]  # cuerda 1 (mi aguda) .. 6
RASGUEO = 0.06  # s: notas más juntas que esto son el mismo ataque
HUECO_RASGUEO = 0.03  # s: entre dos cuerdas seguidas de un rasgueo; más, son dos notas sueltas (igual que partitura.mjs)


def candidatas(midi):
    return [f"{midi - a}.{i + 1}" for i, a in enumerate(AFINACION) if 0 <= midi - a <= 22]
CTX = ssl._create_unverified_context()  # el camera mirror usa un certificado autofirmado


def get(url):
    with urllib.request.urlopen(url, context=CTX) as r:
        return json.load(r)


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # la consola de Windows rompía los acentos
    sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("sesion")
    ap.add_argument("--desde", type=float)
    ap.add_argument("--hasta", type=float)
    # Toma horizontal 1920x1080 con el clavijero a la derecha: el mástil sube y baja entre y=480 y
    # el borde de abajo (medido en e02334b5), y la cara y la mano que pulsa no aportan nada.
    ap.add_argument("--crop", default="1360:620:560:460")
    ap.add_argument("--ancho", type=int, default=520)
    ap.add_argument("--saltear-unicas", action="store_true")
    ap.add_argument("--antes", type=int, default=0)
    ap.add_argument("--cols", type=int, default=3)  # 3x640: más ancho, el visor achica y se pierden los trastes
    ap.add_argument("--max", type=int, default=24)
    ap.add_argument("--version", default="revisada")
    ap.add_argument("--out", default="hoja_notas.png")
    a = ap.parse_args()

    sesiones = get(API)["sesiones"]
    # Con un alias vacío o corto, startswith agarraba cualquier sesión.
    iguales = [x for x in sesiones if len(a.sesion) >= 8 and x["id"].startswith(a.sesion.lower())]
    if len(iguales) != 1:
        sys.exit(f"no hay una sesión única para '{a.sesion}' (usar el alias de 8 caracteres o el uuid)")
    s = iguales[0]
    if s.get("offset_video_s") is None:
        sys.exit(f"la sesión {s['alias']} no está sincronizada: sin offset no hay frames")
    notas = get(f"{API}/sesiones/{s['id']}/notas?version={a.version}")
    notas = [n for n in notas if (a.desde is None or n["t_s"] >= a.desde) and (a.hasta is None or n["t_s"] <= a.hasta)]
    if a.saltear_unicas:
        notas = [n for n in notas if len(candidatas(n["midi"])) > 1]
    if len(notas) > a.max:
        print(f"{len(notas)} notas en el rango; se muestran las primeras {a.max} (acotar con --desde/--hasta)")
        notas = notas[: a.max]
    if not notas:
        sys.exit("no hay notas en ese rango")

    video = os.path.join(EDITOR, "public", "sesiones", s["id"], "video.mp4")
    fps = s["fps"] or 30
    # Un cuadro por ATAQUE, no por nota: un acorde de 6 notas eran 6 fotos iguales (6 veces los
    # tokens). Notas a menos de RASGUEO s de la primera del grupo son el mismo ataque (un rasgueo
    # de 6 cuerdas dura 20-60 ms).
    ataques = []
    for n in sorted(notas, key=lambda n: n["t_s"]):
        if (ataques and n["t_s"] - ataques[-1][0]["t_s"] <= RASGUEO and n["t_s"] - ataques[-1][-1]["t_s"] <= HUECO_RASGUEO
                and all(m["midi"] != n["midi"] for m in ataques[-1])):
            ataques[-1].append(n)
        else:
            ataques.append([n])
    with tempfile.TemporaryDirectory() as tmp:
        for i, g in enumerate(ataques):
            frame = g[0]["frame"] - a.antes
            t = frame / fps
            g.sort(key=lambda n: n["midi"])
            nombres = " ".join(f"{NOMBRES[n['midi'] % 12]}{n['midi'] // 12 - 1}"
                               + (f"={n['traste']}.{n['cuerda']}" if n.get("cuerda") else "") for n in g)
            texto = f"#{i} {t:.2f}s f{frame} {nombres}".replace(":", r"\:")
            letra = f"fontfile='{FUENTE}':fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.7"
            filtro = f"crop={a.crop},scale={a.ancho}:-2,drawtext={letra}:text='{texto}':x=6:y=6"
            # Las candidatas solo entran en una línea con una nota; en un acorde las decide la
            # forma de la mano (una nota por cuerda, mano de 4 trastes).
            if len(g) == 1:
                filtro += f",drawtext={letra}:text='{'  '.join(candidatas(g[0]['midi']))}':x=6:y=h-30"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{max(t, 0):.4f}", "-i", video, "-frames:v", "1",
                            "-vf", filtro, os.path.join(tmp, f"c{i:03d}.png")], check=True)
        filas = -(-len(ataques) // a.cols)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", os.path.join(tmp, "c%03d.png"), "-vf",
                        f"tile={a.cols}x{filas}:padding=6", "-frames:v", "1", a.out], check=True)
    print(f"{len(notas)} notas en {len(ataques)} ataques de la sesión {s['alias']} -> {a.out}")


if __name__ == "__main__":
    main()
