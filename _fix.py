import io
p = "_test_geometria.js"
s = io.open(p, encoding="utf-8").read()
s = s.replace("dedosEstirados(mano(APENAS)) === 0", "dedosEstirados(mano([APENAS, APENAS, APENAS, APENAS])) === 0")
io.open(p, "w", encoding="utf-8").write(s)
