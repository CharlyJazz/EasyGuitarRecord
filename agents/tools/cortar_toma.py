"""Corta un tramo de una toma SIN perder calidad y sin desfasar el audio (smart cut), a un archivo NUEVO.

  python agents/tools/cortar_toma.py TOMA.mp4 --desde 4:48 --hasta 5:50 [--buscar 2.5] [--buscar-fin 1] [--salida X.mp4]

  --desde/--hasta   segundos o m:ss(.s)
  --buscar N        busca el silencio más profundo en ±N s alrededor de --desde y corta ahí ("hay un silencio
                    antes del arpegio, cortá desde ahí"). Imprime los candidatos para poder elegir otro.
  --buscar-fin N    lo mismo para --hasta
  --solo-buscar     imprime los candidatos y no corta
El original no se toca. Salida por defecto: "<toma> - <m.ss>-<m.ss>.mp4" en la misma carpeta.

Cómo corta (receta verificada, ver agents/skills/ffmpeg-cortes-y-formatos):
  1. video: recodifica SOLO desde el corte hasta el próximo keyframe (h264_nvenc cq 12, o libx264 crf 12) y
     copia el resto tal cual; las dos partes van en MPEG-TS (SPS/PPS en cada keyframe) y se unen con el demuxer concat,
     con la duración de la cabeza explícita.
  2. audio: -ss DESPUÉS del -i y -c:a copy. Con -ss antes, el audio arrastra los segundos desde el keyframe
     anterior: ffprobe los descarta pero los reproductores los tocan → audio adelantado.
  3. el primer paquete AAC cae unos ms después del corte: se compensa con -itsoffset.
  4. verifica: cuadros contados (no `duration`), PSNR de un cuadro recodificado y uno copiado contra el
     original, paquetes de audio, correlación del audio contra el original (< 1 ms) y decodificación sin errores.

uv run --no-project --python 3.11 --with numpy python agents/tools/cortar_toma.py …   (ffmpeg y ffprobe en el PATH)
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

SR = 48000


def seg(s: str) -> float:
    p = s.split(":")
    return float(p[0]) * 60 + float(p[1]) if len(p) == 2 else float(s)


def mmss(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:06.3f}"


def run(*a, capturar=False):
    r = subprocess.run(list(a), capture_output=True, text=not capturar)
    if r.returncode != 0:
        raise SystemExit(f"falló: {' '.join(map(str, a))}\n{r.stderr if not capturar else r.stderr.decode(errors='replace')}")
    return r.stdout


def audio(src: Path, desde: float, largo: float) -> np.ndarray:
    crudo = run("ffmpeg", "-v", "error", "-ss", f"{desde:.6f}", "-i", str(src), "-t", f"{largo:.6f}", "-vn",
                "-ac", "1", "-ar", str(SR), "-f", "f32le", "-", capturar=True)
    return np.frombuffer(crudo, dtype=np.float32)


def silencios(src: Path, centro: float, radio: float, antes: float, n=4):
    """Los tramos más silenciosos en [centro-radio, centro+radio]: (segundo de corte, dB del valle, segundo del ataque).
    El corte cae `antes` s antes del ataque que sigue al valle (sin pasarse al principio del valle)."""
    a0 = max(0.0, centro - radio)
    x = audio(src, a0, 2 * radio)
    w = SR // 100  # 10 ms
    k = len(x) // w
    db = 20 * np.log10(np.sqrt((x[: k * w].reshape(k, w) ** 2).mean(1)) + 1e-9)
    suave = np.convolve(db, np.ones(10) / 10, mode="same")  # valle de ~100 ms, no un cero suelto
    orden = np.argsort(suave)
    elegidos = []
    for i in orden:
        if all(abs(i - j) > 50 for j in elegidos):  # candidatos separados al menos 0,5 s
            elegidos.append(i)
        if len(elegidos) == n:
            break
    res = []
    for i in elegidos:
        # el ataque que sigue al valle: primera ventana 12 dB arriba del valle
        j = i
        while j < k - 1 and db[j] < suave[i] + 12:
            j += 1
        corte = round(a0 + max(i, j - round(antes * 100)) * 0.01, 3)
        if all(abs(corte - r[0]) > 0.05 for r in res):  # dos valles que llevan al mismo ataque: uno solo
            res.append((corte, round(float(suave[i]), 1), round(a0 + j * 0.01, 3)))
    return sorted(res, key=lambda r: r[1])


def keyframes(src: Path, desde: float, hasta: float):
    out = run("ffprobe", "-v", "error", "-select_streams", "v", "-skip_frame", "nokey", "-show_entries",
              "frame=pts_time", "-of", "csv=p=0", "-read_intervals", f"{desde}%{hasta}", str(src))
    return [float(t) for t in out.split() if t.strip()]


def info(src: Path):
    j = json.loads(run("ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(src)))
    v = next(s for s in j["streams"] if s["codec_type"] == "video")
    a = next((s for s in j["streams"] if s["codec_type"] == "audio"), None)
    num, den = map(int, v["avg_frame_rate"].split("/"))
    return v, a, num / den


def primer_paquete_audio(src: Path, desde: float):
    out = run("ffprobe", "-v", "error", "-select_streams", "a", "-read_intervals", f"{max(0, desde - 1)}%+2",
              "-show_entries", "packet=pts_time", "-of", "csv=p=0", str(src))
    return next(t for t in (float(x) for x in out.split()) if t >= desde - 1e-6)


def codificar_cabeza(src, desde, cuadros, destino):
    """Recodifica `cuadros` cuadros desde `desde` a MPEG-TS: en TS cada keyframe lleva su SPS/PPS, así la cola copiada
    se decodifica con los suyos aunque los parámetros del encoder difieran (dump_extra sobre MP4 corrompe los NAL)."""
    base = ["ffmpeg", "-v", "error", "-y", "-ss", f"{desde:.6f}", "-i", str(src), "-frames:v", str(cuadros), "-an",
            "-pix_fmt", "yuv420p"]
    try:
        run(*base, "-c:v", "h264_nvenc", "-profile:v", "main", "-level", "4.1", "-rc", "vbr", "-cq", "12", "-b:v", "0",
            str(destino))
        return "h264_nvenc cq 12"
    except SystemExit:
        run(*base, "-c:v", "libx264", "-profile:v", "main", "-level", "4.1", "-crf", "12", "-preset", "slow",
            str(destino))
        return "libx264 crf 12"


def cuadro(src: Path, t: float, fps: float, despues_del_input=False) -> np.ndarray:
    """Un cuadro chico en gris (para comparar el corte contra el original)."""
    pre = [] if despues_del_input else ["-ss", f"{t:.6f}"]
    post = ["-ss", f"{t:.6f}"] if despues_del_input else []
    crudo = run("ffmpeg", "-v", "error", *pre, "-i", str(src), *post, "-frames:v", "1", "-vf", "scale=270:480,format=gray",
                "-f", "rawvideo", "-", capturar=True)
    return np.frombuffer(crudo, dtype=np.uint8).astype(np.float64)


def psnr(a, b):
    mse = ((a - b) ** 2).mean()
    return 99.0 if mse == 0 else 10 * np.log10(255 ** 2 / mse)


def correlacion_ms(a: np.ndarray, b: np.ndarray, max_ms=60) -> float:
    n = min(len(a), len(b))
    a, b = a[:n] - a[:n].mean(), b[:n] - b[:n].mean()
    L = int(max_ms * SR / 1000)
    N = 1 << int(np.ceil(np.log2(2 * n)))
    c = np.fft.irfft(np.fft.rfft(a, N) * np.conj(np.fft.rfft(b, N)), N)
    c = np.concatenate([c[-L:], c[: L + 1]])
    return (np.argmax(c) - L) / SR * 1000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("toma")
    ap.add_argument("--desde", required=True)
    ap.add_argument("--hasta", required=True)
    ap.add_argument("--buscar", type=float, default=0)
    ap.add_argument("--buscar-fin", type=float, default=0)
    ap.add_argument("--solo-buscar", action="store_true")
    ap.add_argument("--salida")
    a = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    src = Path(a.toma)
    desde, hasta = seg(a.desde), seg(a.hasta)
    v, au, fps = info(src)

    # inicio: 100 ms de aire antes del primer ataque; fin: justo antes de la nota siguiente (40 ms)
    for nombre, radio, t, antes in (("inicio", a.buscar, desde, 0.10), ("fin", a.buscar_fin, hasta, 0.04)):
        if radio > 0:
            cands = silencios(src, t, radio, antes)
            print(f"silencios cerca del {nombre} ({mmss(t)} ± {radio:g} s), del más profundo al menos:")
            for corte, dbv, ataque in cands:
                print(f"   corte {mmss(corte)}   valle {dbv:6.1f} dB   ataque siguiente {mmss(ataque)}")
            if nombre == "inicio":
                desde = cands[0][0]
            else:
                hasta = cands[0][0]
    if a.solo_buscar:
        return

    # al cuadro más cercano: la cabeza recodificada tiene que caer justo en la grilla de 30 fps
    desde = round(desde * fps) / fps
    hasta = round(hasta * fps) / fps
    kfs = [k for k in keyframes(src, desde, desde + 30) if k > desde + 1e-3]
    kf = kfs[0] if kfs and kfs[0] < hasta else None
    salida = Path(a.salida) if a.salida else src.with_name(
        f"{src.stem} - {int(desde // 60)}.{int(desde % 60):02d}-{int(hasta // 60)}.{int(hasta % 60):02d}{src.suffix}")
    if salida.resolve() == src.resolve():
        raise SystemExit("la salida no puede ser el original")
    print(f"corte {mmss(desde)} → {mmss(hasta)} ({hasta - desde:.3f} s) · keyframe siguiente: {mmss(kf) if kf else 'ninguno'}")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        partes = []
        fin_cabeza = kf if kf is not None else hasta
        n_cabeza = round((fin_cabeza - desde) * fps)
        enc = codificar_cabeza(src, desde, n_cabeza, tmp / "cabeza.ts")
        partes.append(tmp / "cabeza.ts")
        if kf is not None:  # -ss antes del -i con copy arranca justo en el keyframe
            run("ffmpeg", "-v", "error", "-y", "-ss", f"{kf:.6f}", "-i", str(src), "-frames:v", str(round((hasta - kf) * fps)),
                "-an", "-c:v", "copy", str(tmp / "cola.ts"))
            partes.append(tmp / "cola.ts")
        print(f"video: {enc} los primeros {fin_cabeza - desde:.3f} s, el resto copiado sin tocar")
        # `duration` explícita en la cabeza: si no, concat toma la duración hasta el último pts (un cuadro menos),
        # la cola queda corrida un cuadro (pts repetido, DTS no monótono en la unión, cuadros desfasados)
        lista = "file '" + partes[0].as_posix() + "'\n" + f"duration {n_cabeza / fps:.6f}\n"
        lista += "".join("file '" + p.as_posix() + "'\n" for p in partes[1:])
        (tmp / "lista.txt").write_text(lista, encoding="utf-8")
        run("ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(tmp / "lista.txt"), "-c", "copy",
            str(tmp / "video.mp4"))

        if au is None:
            run("ffmpeg", "-v", "error", "-y", "-i", str(tmp / "video.mp4"), "-c", "copy", "-movflags", "+faststart", str(salida))
        else:
            run("ffmpeg", "-v", "error", "-y", "-i", str(src), "-ss", f"{desde:.6f}", "-to", f"{hasta:.6f}", "-vn",
                "-c:a", "copy", str(tmp / "audio.m4a"))
            corr = primer_paquete_audio(src, desde) - desde
            run("ffmpeg", "-v", "error", "-y", "-i", str(tmp / "video.mp4"), "-itsoffset", f"{corr:.6f}",
                "-i", str(tmp / "audio.m4a"), "-map", "0:v", "-map", "1:a", "-c", "copy", "-movflags", "+faststart",
                str(salida))
            print(f"audio: copiado sin recodificar, primer paquete a +{corr * 1000:.1f} ms del corte (compensado)")

    # verificación
    cuadros = int(run("ffprobe", "-v", "error", "-select_streams", "v", "-count_packets", "-show_entries",
                      "stream=nb_read_packets", "-of", "csv=p=0", str(salida)).strip())
    esperado = round((hasta - desde) * fps)
    print(f"verificación: {cuadros} cuadros = {cuadros / fps:.3f} s (esperado {esperado}) {'OK' if cuadros == esperado else '¡REVISAR!'}")
    # cuadros del resultado contra el original en el mismo instante: el primero (recodificado) y uno de la cola (copiado)
    for t in [0.0] + ([kf - desde + 1.0] if kf is not None else []):
        p = psnr(cuadro(salida, t, fps, despues_del_input=True), cuadro(src, desde + t, fps, despues_del_input=True))
        print(f"              cuadro en {t:6.3f} s vs original: PSNR {p:.1f} dB {'OK' if p > 40 else '¡REVISAR!'}")
    if au is not None:
        paquetes = int(run("ffprobe", "-v", "error", "-select_streams", "a", "-count_packets", "-show_entries",
                           "stream=nb_read_packets", "-of", "csv=p=0", str(salida)).strip())
        print(f"              audio {paquetes * 1024 / SR:.3f} s (contando paquetes AAC)")
        # el audio del resultado empieza en su start_time (el primer paquete, unos ms después del corte): se compara
        # contra el original desde ese mismo instante. Si el timestamp está bien, el desfase da 0.
        inicio_a = float(run("ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=start_time",
                             "-of", "csv=p=0", str(salida)).strip())
        nuevo = audio(salida, 0, min(20, hasta - desde))
        orig = audio(src, desde + inicio_a, min(20, hasta - desde))
        ms = correlacion_ms(nuevo, orig)
        print(f"              audio arranca a +{inicio_a * 1000:.1f} ms; contra el original: {ms:+.2f} ms {'OK' if abs(ms) < 1 else '¡REVISAR!'}")
    err = subprocess.run(["ffmpeg", "-v", "error", "-i", str(salida), "-f", "null", "-"], capture_output=True, text=True).stderr
    print(f"              decodificación: {'sin errores' if not err.strip() else err.strip()[:300]}")
    print(f"→ {salida}")


if __name__ == "__main__":
    main()
