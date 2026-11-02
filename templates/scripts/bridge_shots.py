# Генерирует файл out/bridge/shots.json (диапазоны кадров по планам, окна кроссфейдов, фотовспышку) из story.ts для утилиты scripts/short_qa.py.
import json, re, sys
src = open(sys.argv[1] if len(sys.argv) > 1 else "src/videos/bridge/story.ts", encoding="utf-8").read()
shots = [{"id": int(i), "a": int(a), "b": int(b) if b != "TOTAL" else int(re.search(r"TOTAL = (\d+)", src).group(1))}
         for i, a, b in re.findall(r"\{ id: (\d+), a: (\d+), b: (\w+),", src)]
xf = {int(k): int(v) for k, v in re.findall(r"(\d+): (\d+)", re.search(r"XFADE[^=]*= \{([^}]*)\}", src).group(1))}
flash = int(re.search(r"FLASH_AT = (\d+)", src).group(1))
xfade = [[s["a"] - xf[s["id"]] // 2, s["a"] + xf[s["id"]] // 2] for s in shots if s["id"] in xf]
# запланированные жесткие склейки внутри сцен и 7-кадровые рывки камеры (SNAP / DROP1 / удары молотка)
cuts = [[int(f), int(f)] for f in re.findall(r"\{ f: (\d+), cut: true", src)]
consts = {k: float(v) for k, v in re.findall(r"(SNAP|DROP0|DROP1) = ([\d.]+)", src)}
kicks = []
m = re.search(r"const KICKS[^=]*= \[(.*?)\];", src)
if m:
    for t0, _ in re.findall(r"\[([\w.]+), ([\d.]+)\]", m.group(1)):
        f0 = round((consts[t0] if t0 in consts else float(t0)) * 30)
        kicks.append([f0, f0 + 8])
json.dump({"shots": shots, "xfade": xfade, "flash": [flash, flash + 4], "planned": cuts + kicks}, open("out/bridge/shots.json", "w"), indent=1)
print(len(shots), "shots", xfade, flash, "cuts", [c[0] for c in cuts], "kicks", kicks)
