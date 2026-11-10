"""Dónde cortar una palabra sin ruido raro: energía por bandas en ventanas de 10 ms alrededor de un segundo.

  voz        80-1500 Hz (vocales, nasales)
  sibilante  > 4 kHz    (s, f, ch)
Un buen punto de corte: después de la "s" final (sibilante cae y voz ~0) o en el cierre de una oclusiva
(p, t, k: las dos bandas caen un instante). Whisper da límites de palabra aproximados (±50 ms): mirar acá.
Probado con voz real: "profesores | para" se cortó en 58,29-58,30 s sin clic.

uv run --no-project --python 3.11 --with soundfile --with "numpy<2" python tools/bandas.py "pista.wav" 58.1 58.45
"""
import sys
import numpy as np, soundfile as sf

x, sr = sf.read(sys.argv[1], always_2d=True)
desde, hasta = float(sys.argv[2]), float(sys.argv[3])
m = x.mean(1); w = int(0.01 * sr)
f = np.fft.rfftfreq(w, 1 / sr)
for t in np.arange(desde, hasta, 0.01):
    a = int(t * sr); s = m[a:a + w] * np.hanning(w); S = np.abs(np.fft.rfft(s))
    db = lambda sel: 20 * np.log10(np.sqrt((S[sel] ** 2).sum()) + 1e-9)
    voz, sib = db((f > 80) & (f < 1500)), db(f > 4000)
    print(f"{t:6.2f}  voz {voz:6.1f}  sibilante {sib:6.1f}  {'█' * max(0, int((voz + 20) / 3))}")
