# Объединяет изолированные песочницы визуальной доработки обратно в основную папку bridge в соответствии с закрепленными файлами.
# Предварительно создает резервную копию основной ветки (backup/bridge_<time>/), переносит закрепленные за каждой песочницей модули
# и выводит статус отсутствующих либо неизмененных файлов. Запуск: python scripts/bridge_merge.py [cam,world,char,post]
import os, shutil, sys, time, filecmp

ROOT = os.path.expanduser("your Remotion project")
MAIN = os.path.join(ROOT, "src/videos/bridge")
OWN = {  # распределение файлов во 2-м раунде (в 1-м раунде world также отвечал за paint/build, а post — за grade)
    "cam": ["story.ts"],
    "world": ["world.ts", "lights.ts", "shade.ts", "grade.ts"],
    "mat": ["paint.ts", "build.ts"],
    "char": ["toon.ts", "cast.ts", "cardshade.ts"],
    "post": ["ink.ts", "Bridge.tsx", "lensblur.ts"],
}
which = sys.argv[1].split(",") if len(sys.argv) > 1 else list(OWN)
bak = os.path.join(ROOT, "backup", time.strftime("bridge_%Y%m%d_%H%M%S"))
shutil.copytree(MAIN, bak)
print("backup ->", bak)
for box in which:
    src = os.path.join(ROOT, f"src/videos/bridge_{box}")
    for f in OWN[box]:
        a, b = os.path.join(src, f), os.path.join(MAIN, f)
        if not os.path.exists(a):
            print(f"  {box}: {f} not in sandbox (skipped)")
            continue
        if os.path.exists(b) and filecmp.cmp(a, b, shallow=False):
            print(f"  {box}: {f} unchanged")
            continue
        shutil.copy2(a, b)
        print(f"  {box}: {f} -> main")
