"""Transcribe la voz grabada palabra por palabra con faster-whisper (large-v3-turbo) en GPU NVIDIA.

  python tools/transcribir.py "ruta/a/carpeta de pistas" [salida.json]     (todas las .wav, ordenadas por "Track N")
  python tools/transcribir.py public/audio/voz-corto.wav [salida.json] --desde 54 --hasta 66   (verificar un corte)
  --idioma en       otro idioma (por defecto es)
  --prompt "..."    jerga que whisper tiene que reconocer (nombres de escalas, acordes, nombres propios)

Imprime cada pista con el segundo de su primera/última palabra y el texto; el JSON tiene cada palabra con a/b (s).
Esos segundos son los que van a src/guion.json (desde/hasta, tiempos, marcas). Errores típicos de whisper con la
jerga musical: "Re bemol" → "do bemol", "progresión" → "proyección": corregir en el texto y avisar por si se dijo así.

Correrlo con uv (no instala nada en el sistema):
  uv run --no-project --python 3.11 --with faster-whisper --with nvidia-cublas-cu12 --with "nvidia-cudnn-cu12>=9,<10"          --with soundfile --with librosa --with "numpy<2" python tools/transcribir.py …
  env recomendado: PYTHONIOENCODING=utf-8 (y UV_CACHE_DIR / HF_HOME en un disco con lugar: el modelo pesa ~1,6 GB)
Sin GPU NVIDIA: cambiar device="cuda", compute_type="float16" por device="cpu", compute_type="int8" (mucho más lento).
"""
import os, sys, glob, json, re, argparse
# Las DLL de CUDA 12 (cuBLAS, cuDNN 9) vienen en los paquetes nvidia-* de pip y hay que cargarlas ANTES de importar
# faster_whisper; si no: "cublas64_12.dll is not found". site.getsitepackages() no sirve en uv: usar nvidia.__path__.
try:
    import nvidia
    for raiz in nvidia.__path__:
        for b in glob.glob(os.path.join(raiz, "*", "bin")):
            if hasattr(os, "add_dll_directory"):
                os.add_dll_directory(b)
            os.environ["PATH"] = b + os.pathsep + os.environ["PATH"]
except ImportError:
    pass  # sin los paquetes nvidia-*: CPU o CUDA del sistema
from faster_whisper import WhisperModel

ap = argparse.ArgumentParser()
ap.add_argument("entrada")
ap.add_argument("salida", nargs="?")
ap.add_argument("--desde", type=float)
ap.add_argument("--hasta", type=float)
ap.add_argument("--idioma", default="es")
ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
ap.add_argument("--compute-type", default=None)
ap.add_argument("--prompt", default="guitarra, acorde, escala, mixolidia, dórica, lidia dominante, Re bemol, Si bemol, tresillo, backing track.")
a = ap.parse_args()

if a.device == "auto":
    try:
        m = WhisperModel("large-v3-turbo", device="cuda", compute_type=a.compute_type or "float16")
    except Exception as e:
        print(f"(CUDA no disponible [{e}], usando CPU int8)", file=sys.stderr)
        m = WhisperModel("large-v3-turbo", device="cpu", compute_type=a.compute_type or "int8")
else:
    ctype = a.compute_type or ("float16" if a.device == "cuda" else "int8")
    m = WhisperModel("large-v3-turbo", device=a.device, compute_type=ctype)


def orden(f):
    n = re.search(r"Track (\d+)", f)
    return int(n.group(1)) if n else 0


archivos = sorted(glob.glob(os.path.join(a.entrada, "*.wav")), key=orden) if os.path.isdir(a.entrada) else [a.entrada]
res = []
for f in archivos:
    audio, off = f, 0.0
    if a.desde is not None:
        import soundfile as sf, librosa
        x, sr = sf.read(f, always_2d=True, dtype="float32")
        seg = x.mean(1)[int(a.desde * sr): int((a.hasta or len(x) / sr) * sr)]
        audio, off = librosa.resample(seg, orig_sr=sr, target_sr=16000), a.desde
    segs, info = m.transcribe(audio, language=a.idioma, word_timestamps=True, beam_size=5, vad_filter=True, initial_prompt=a.prompt)
    pal = [{"w": w.word, "a": round(off + w.start, 2), "b": round(off + w.end, 2)} for s in segs for w in s.words]
    texto = "".join(p["w"] for p in pal).strip()
    res.append({"archivo": os.path.basename(f), "desde": pal[0]["a"] if pal else None, "hasta": pal[-1]["b"] if pal else None, "texto": texto, "palabras": pal})
    print(f'{os.path.basename(f)[-24:]:24} voz {pal[0]["a"] if pal else "-":>7}-{pal[-1]["b"] if pal else "-":>7}  {texto}')
    if a.desde is not None:
        print("   " + " ".join(f'{p["w"].strip()}@{p["a"]}' for p in pal))
if a.salida:
    json.dump(res, open(a.salida, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
