"""Mezcla final: public/audio/mezcla-<version>.wav (48 kHz, estéreo) = fondo + inserciones + voz con ducking.

  fondo        un WAV/MP3 en loop (opcional): --fondo "ruta/al/backing.mp3" --fondo-desde 30 --fondo-largo 72
  inserciones  ejemplos sonoros en un segundo del video (opcional, repetible):
               --insertar 12.5 public/audio/ejemplos/triada-neutra.wav
  voz          public/audio/voz-<version>.wav (tools/voz.py), si existe: la música baja 9 dB debajo de la voz
               (envolvente RMS 20 ms, ataque 60 ms / suelta 400 ms) y la voz queda ~8 dB arriba.
La duración sale del guion (src/guion.json[<version>]). Fundido final 1,5 s. El loudnorm a -14 LUFS lo hace render.mjs.
Usado en varios videos con voz grabada; ver agents/skills/mezcla-y-backing.

uv run --no-project --python 3.11 --with librosa --with soundfile --with "numpy<2" python tools/mezcla.py corto [opciones]
"""
import argparse, json, pathlib
import numpy as np, soundfile as sf

RAIZ = pathlib.Path(__file__).resolve().parent.parent
SR = 48000
ap = argparse.ArgumentParser()
ap.add_argument("version")
ap.add_argument("--fondo")
ap.add_argument("--fondo-desde", type=float, default=0.0)
ap.add_argument("--fondo-largo", type=float)
ap.add_argument("--fondo-db", type=float, default=0.0, help="ganancia del fondo")
ap.add_argument("--insertar", nargs=2, action="append", metavar=("SEG", "WAV"), default=[])
ap.add_argument("--baja-db", type=float, default=9.0, help="cuánto baja la música bajo la voz")
ap.add_argument("--voz-sobre-db", type=float, default=8.0)
a = ap.parse_args()

g = json.loads((RAIZ / "src/guion.json").read_text(encoding="utf-8"))[a.version]
total = max(s["hasta"] for s in g["segmentos"])
n = int(round(total * SR))
mezcla = np.zeros((2, n), dtype=np.float32)


def cargar(p):
    import librosa
    y, _ = librosa.load(p, sr=SR, mono=False)
    return np.stack([y, y]) if y.ndim == 1 else y


if a.fondo:
    y = cargar(a.fondo)
    d0 = int(a.fondo_desde * SR)
    largo = int((a.fondo_largo or (y.shape[1] / SR - a.fondo_desde)) * SR)
    mezcla += y[:, (np.arange(n) % largo) + d0] * 10 ** (a.fondo_db / 20)
    print(f"fondo: {a.fondo} {a.fondo_desde:g}+{largo / SR:g} s en loop")

for seg, wav in a.insertar:
    y = cargar(RAIZ / wav if not pathlib.Path(wav).is_absolute() else wav)
    i = int(float(seg) * SR); m = min(y.shape[1], n - i)
    f = int(0.04 * SR); w = np.ones(m); w[:f] = np.linspace(0, 1, f); w[-f:] = np.linspace(1, 0, f)
    mezcla[:, i:i + m] = mezcla[:, i:i + m] * (1 - w) + y[:, :m] * w
    print(f"  inserción {wav} en {float(seg):.2f} s ({m / SR:.2f} s)")

VOZ = RAIZ / f"public/audio/voz-{a.version}.wav"
if VOZ.exists():
    v, srv = sf.read(VOZ, always_2d=True, dtype="float32"); assert srv == SR
    v = v.T[:, :n]; v = np.pad(v, ((0, 0), (0, n - v.shape[1])))
    hop = int(0.02 * SR)
    rms = np.sqrt(np.convolve(v.mean(0) ** 2, np.ones(hop) / hop, mode="same"))
    hay = (rms > 10 ** (-40 / 20)).astype(np.float32)
    paso = SR // 1000; h = hay[::paso]; e = np.zeros_like(h); acc = 0.0
    a1, s1 = 1 - np.exp(-1 / 60), 1 - np.exp(-1 / 400)
    for k, x in enumerate(h):
        acc += (a1 if x > acc else s1) * (x - acc); e[k] = acc
    env = np.interp(np.arange(n), np.arange(len(e)) * paso, e).astype(np.float32)
    if np.abs(mezcla).max() > 0:
        mezcla *= 10 ** (-a.baja_db * env / 20)
        m_rms = np.sqrt((mezcla[:, env > 0.9] ** 2).mean()); v_rms = np.sqrt((v[:, env > 0.9] ** 2).mean())
        gan = (m_rms * 10 ** (a.voz_sobre_db / 20)) / v_rms if m_rms > 0 else 1.0
    else:
        gan = 1.0
    mezcla += v * gan
    print(f"voz: {VOZ.name} (ganancia {20 * np.log10(gan):+.1f} dB, música -{a.baja_db:g} dB bajo la voz)")

fin = int(1.5 * SR)
mezcla[:, -fin:] *= np.linspace(1, 0, fin)
pico = np.abs(mezcla).max()
if pico > 0.99:
    mezcla *= 0.99 / pico
salida = RAIZ / f"public/audio/mezcla-{a.version}.wav"
sf.write(salida, mezcla.T, SR, subtype="PCM_16")
print(f"-> {salida} ({total:.1f} s, pico {pico:.2f})")
