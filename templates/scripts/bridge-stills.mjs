// Использование: node scripts/bridge-stills.mjs <outPrefix> <frame,frame,...> [scale]  (однократная сборка бандла, GPU через ANGLE, формат jpeg)
// BRIDGE_ENTRY=src/sandboxes/<name>/index.tsx рендерит копию из песочницы вместо основной точки входа проекта.
import fs from "node:fs";
// Каждый бандл копирует папку public/ (~1.3 ГБ) во временный каталог; если системный диск переполнен, переносите сборку на другой раздел:
// Бандлы Remotion быстро занимают временную директорию (~1.3 ГБ каждый): укажите REMOTION_TMP на просторном диске
if (process.env.REMOTION_TMP) { fs.mkdirSync(process.env.REMOTION_TMP, { recursive: true }); process.env.TEMP = process.env.TMP = process.env.REMOTION_TMP; }
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import path from "node:path";
const [prefix, frames, scale = "0.5"] = process.argv.slice(2);
const browserExecutable = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chromiumOptions = { gl: "angle" };
const serveUrl = await bundle({ entryPoint: path.resolve(process.env.BRIDGE_ENTRY || "src/index.ts"), publicDir: path.resolve("public") });
const composition = await selectComposition({ serveUrl, id: "BridgeShort", browserExecutable, chromiumOptions });
const onBrowserLog = (l) => { if (l.type === "error" || l.type === "warning") console.log(`[${l.type}]`, l.text.slice(0, 300)); };
for (const f of frames.split(",").map(Number)) {
  const t0 = Date.now();
  await renderStill({ composition, serveUrl, frame: f, output: `${prefix}${f}.jpg`, imageFormat: "jpeg", jpegQuality: 88, scale: Number(scale),
    browserExecutable, chromiumOptions, timeoutInMilliseconds: 180000, onBrowserLog });
  console.log("still", f, ((Date.now() - t0) / 1000).toFixed(1) + "s");
}
