"""Sincroniza el audio de FL Studio con el video del teléfono.

El micrófono del teléfono escucha la guitarra (más sala, ruido, voz), y FL tiene la misma
interpretación limpia. Se busca dónde cae el audio de FL dentro del audio del video con
GCC-PHAT (Knapp & Carter, 1976): correlación cruzada con el espectro blanqueado, de modo que
pesa la coincidencia de fase y no el timbre ni el volumen.

Además mide la deriva de relojes (iPhone vs interfaz) correlacionando por ventanas a lo largo
de la toma, y usa la MEDIANA de las ventanas como offset final (el audio del teléfono por WebRTC
salta unos ms durante la toma; el pico global puede caer en un tramo corrido).

El audio de la DAW puede ser más largo que el video (un export que sigue con el backing): se busca
dónde cae el video adentro. Si el backing es una vuelta que se repite, mirar que el pico sea claro.

Salidas, junto al video (o en --out):
  <video>_fl.wav   audio de FL desplazado con precisión de muestra: empieza en t=0 del video
                   y dura lo mismo que el video. Es lo que usa Remotion.
  <video>_sync.mp4 vista previa: video sin recodificar + ese audio.
  <video>_sync.json offset, confianza y deriva medidos.
  --wav RUTA       escribe el audio alineado ahí (p. ej. public/audio/mezcla-toma.wav) en vez de <video>_fl.wav

Uso:  python sync.py VIDEO AUDIO_FL [--out CARPETA] [--wav RUTA] [--no-mp4] [--force]
      uv run --no-project --python 3.11 --with numpy --with scipy python tools/sync.py …
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

SR = 48000
BANDA_HZ = (80.0, 6000.0)  # rango de la guitarra; fuera de esto el mic del teléfono es casi solo ruido
VENTANA_S = 4.0  # ventanas para medir la deriva
BUSQUEDA_S = 0.25  # cuánto se aleja como máximo cada ventana del offset global


def decodificar(ruta: Path) -> np.ndarray:
    cmd = ["ffmpeg", "-v", "error", "-i", str(ruta), "-map", "0:a:0",
           "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    crudo = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(crudo, dtype=np.float32).astype(np.float64)


def gcc_phat(ref: np.ndarray, sig: np.ndarray, max_lag: int | None = None, centro: int = 0):
    """Devuelve (lag, confianza, correlación) con ref[n] ≈ sig[n - lag].

    lag > 0: sig empieza `lag` muestras después del inicio de ref.
    confianza: altura del pico en desvíos estándar del piso de correlación (fuera de ±50 ms).
    No se compara contra el "segundo pico": los rebotes de la sala ponen picos a pocos ms del
    principal que son el mismo evento, no una alternativa.
    """
    n = 1 << int(np.ceil(np.log2(len(ref) + len(sig))))
    R = np.fft.rfft(ref, n) * np.conj(np.fft.rfft(sig, n))
    f = np.fft.rfftfreq(n, 1 / SR)
    R[(f < BANDA_HZ[0]) | (f > BANDA_HZ[1])] = 0
    R /= np.abs(R) + 1e-12
    r = np.fft.irfft(R, n)
    lags = np.arange(n)
    lags[lags > n // 2] -= n
    if max_lag is not None:
        ok = np.abs(lags - centro) <= max_lag
        r, lags = r[ok], lags[ok]
    i = int(np.argmax(r))
    piso = r[np.abs(lags - lags[i]) > int(0.050 * SR)]
    return int(lags[i]), float((r[i] - piso.mean()) / piso.std()), r


def medir_deriva(video: np.ndarray, fl: np.ndarray, offset: int):
    """Correlación local por ventanas. Devuelve lista de (t_fl_s, offset_local) y ppm."""
    w = int(VENTANA_S * SR)
    busq = int(BUSQUEDA_S * SR)
    rms_global = np.sqrt(np.mean(fl ** 2))
    puntos = []
    for ini in range(0, len(fl) - w, w):
        trozo = fl[ini:ini + w]
        if np.sqrt(np.mean(trozo ** 2)) < 0.2 * rms_global:
            continue  # silencio en FL: nada que correlacionar
        a = ini + offset - busq
        b = ini + offset + w + busq
        if a < 0 or b > len(video):
            continue
        lag, conf, _ = gcc_phat(video[a:b], trozo, max_lag=busq, centro=busq)
        if conf < 6:
            continue
        puntos.append((ini / SR, a + lag - ini))
    if len(puntos) < 3:
        return puntos, None
    t = np.array([p[0] for p in puntos])
    o = np.array([p[1] for p in puntos], dtype=np.float64)
    pendiente = np.polyfit(t, o, 1)[0]  # muestras de corrimiento por segundo
    return puntos, pendiente / SR * 1e6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    ap.add_argument("audio", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--wav", type=Path, help="ruta del audio alineado (por defecto <video>_fl.wav)")
    ap.add_argument("--no-mp4", action="store_true")
    ap.add_argument("--force", action="store_true", help="escribir aunque la sincronización sea dudosa")
    args = ap.parse_args()

    out = args.out or args.video.parent
    out.mkdir(parents=True, exist_ok=True)
    base = out / args.video.stem

    video = decodificar(args.video)
    fl = decodificar(args.audio)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # consola de Windows: tildes
    print(f"video: {len(video) / SR:.3f} s   FL: {len(fl) / SR:.3f} s")

    offset, conf, _ = gcc_phat(video, fl)
    print(f"offset: {offset} muestras = {offset / SR * 1000:.2f} ms   pico: {conf:.0f} desvíos sobre el piso")

    puntos, ppm = medir_deriva(video, fl, offset)
    # El audio del teléfono llega por WebRTC y SALTA unos ms durante la toma (medido 2026-11-10: tramos estables
    # con saltos de −8, +17 y −7 ms). El pico global puede caer en cualquier tramo, así que el offset final es la
    # MEDIANA de las ventanas, y la tolerancia es medio cuadro (17 ms a 30 fps): menos que eso no se ve.
    if len(puntos) >= 3:
        mediana = int(np.median([p[1] for p in puntos]))
        if mediana != offset:
            print(f"offset por mediana de ventanas: {mediana / SR * 1000:.2f} ms (el pico global daba {offset / SR * 1000:.2f})")
        offset = mediana
    locales = [p[1] - offset for p in puntos]
    tolerancia = 0.017 * SR
    coinciden = sum(abs(x) <= tolerancia for x in locales)
    if puntos:
        print(f"ventanas: {coinciden}/{len(puntos)} a menos de medio cuadro de la mediana "
              f"(min {min(locales) / SR * 1000:+.2f} / max {max(locales) / SR * 1000:+.2f} ms)"
              + (f", deriva {ppm:+.1f} ppm" if ppm is not None else ""))
        saltos = [(puntos[i][0], (puntos[i][1] - puntos[i - 1][1]) / SR * 1000) for i in range(1, len(puntos))
                  if abs(puntos[i][1] - puntos[i - 1][1]) > 0.003 * SR]
        if saltos:
            print("saltos del audio del teléfono (WebRTC): " + ", ".join(f"{t:.0f} s {ms:+.1f} ms" for t, ms in saltos))
    if conf < 15 or len(puntos) < 3 or coinciden < 0.7 * len(puntos):
        print("AVISO: sincronización dudosa. Puede que el teléfono no haya escuchado bien la guitarra,"
              " o que el audio no sea de esta toma.")
        if not args.force:
            print("No se escribe nada. Usar --force para generarlo igual y revisarlo a oído.")
            return 2

    # FL alineado: empieza en t=0 del video y dura lo mismo, con precisión de muestra.
    # Se escribe en estéreo desde el original para no perder el paneo de FL.
    filtro = (f"adelay={offset}S:all=1" if offset >= 0 else f"atrim=start_sample={-offset},asetpts=N/SR/TB")
    wav = args.wav or base.with_name(base.name + "_fl.wav")
    wav.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(args.audio), "-ar", str(SR),
                    "-af", f"{filtro},apad,atrim=end_sample={len(video)}",
                    "-c:a", "pcm_s24le", str(wav)], check=True)
    print(f"-> {wav}")

    if not args.no_mp4:
        mp4 = base.with_name(base.name + "_sync.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(args.video), "-i", str(wav),
                        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "320k",
                        "-movflags", "+faststart", str(mp4)], check=True)
        print(f"-> {mp4}")

    info = {
        "video": str(args.video), "audio": str(args.audio), "sampleRate": SR,
        "offsetSamples": offset, "offsetSeconds": offset / SR, "confidence": conf,
        "driftPpm": ppm, "driftWindows": [{"t": t, "offsetSamples": o} for t, o in puntos],
    }
    base.with_name(base.name + "_sync.json").write_text(json.dumps(info, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
