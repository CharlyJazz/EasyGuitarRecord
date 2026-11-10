"""Junta la voz grabada en FL en un solo WAV: public/audio/voz-<version>.wav (48 kHz, estéreo, pico -1 dBFS).

Las pistas que se exportan de FL Studio (o cualquier DAW) traen SILENCIO ADELANTE (cada una ya está en su segundo de la línea de tiempo),
así que se SUMAN, no se concatenan. Los tramos a borrar (una palabra que sobra) van en un JSON aparte, sin tocar
los WAV originales:

  tools/cortes-<version>.json   {"Track 13": [[58.26, 58.30, 59.50]]}
      = en la pista cuyo nombre contiene "Track 13": fundido de 58,26 a 58,30 s y silencio de 58,30 a 59,50 s
  Los puntos se eligen con tools/bandas.py (cierre de una oclusiva o después de la "s" final) y se verifican
  re-transcribiendo con tools/transcribir.py.

uv run --no-project --python 3.11 --with soundfile --with "numpy<2" python tools/voz.py corto "ruta/a/la/carpeta de pistas"
"""
import json, pathlib, sys
import numpy as np, soundfile as sf

RAIZ = pathlib.Path(__file__).resolve().parent.parent
VERSION, CARPETA = sys.argv[1], pathlib.Path(sys.argv[2])
SR = 48000
f_cortes = RAIZ / f"tools/cortes-{VERSION}.json"
CORTES = json.loads(f_cortes.read_text(encoding="utf-8")) if f_cortes.exists() else {}

pistas = sorted(CARPETA.glob("*.wav"))
assert pistas, f"no hay .wav en {CARPETA}"
datos = []
for p in pistas:
    x, sr = sf.read(p, always_2d=True, dtype="float32")
    assert sr == SR, f"{p.name}: {sr} Hz (exportar a 48 kHz)"
    if x.shape[1] == 1:
        x = np.repeat(x, 2, axis=1)
    for clave, tramos in CORTES.items():
        if clave in p.name:
            for a, b, c in tramos:
                ia, ib, ic = int(a * SR), int(b * SR), int(c * SR)
                x[ia:ib] *= np.linspace(1, 0, ib - ia)[:, None]
                x[ib:ic] = 0
                print(f"  corte en {p.name}: fundido {a}-{b} s, silencio {b}-{c} s")
    datos.append(x)
largo = max(len(x) for x in datos)
voz = np.zeros((largo, 2), dtype=np.float32)
for x in datos:
    voz[: len(x)] += x
pico = np.abs(voz).max()
voz *= 10 ** (-1 / 20) / pico
salida = RAIZ / f"public/audio/voz-{VERSION}.wav"
salida.parent.mkdir(parents=True, exist_ok=True)
sf.write(salida, voz, SR, subtype="PCM_16")
print(f"{len(pistas)} pistas -> {salida} ({largo / SR:.2f} s, pico original {pico:.2f})")
