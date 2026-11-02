// Тонколинейная глубина резкости (DOF) для мягкого размытия фона в стиле референса (reports/depth.md 6.1), реализованная в виде двух
// детерминированных проходов выборки (gather passes). Радиус кружка нерезкости CoC (в пикселях при 1080x1920) = cInf * |1 - focus / depth|,
// умноженный на nearScale перед плоскостью фокусировки и ограниченный сверху значением maxCoC. Все пиксельные размеры в шейдере умножаются
// на (выходная высота / 1920), поэтому картина размытия идентична при ширине 540, 1080 и 1440.
//   pre  : 16-лучевая выборка по радиусу 0.29 x CoC. Заполняет промежутки между основными лучами, превращая суммарное ядро свертки
//          в гладкий диск (1024 эффективных отсчета) вместо 64 отдельных видимых копий каждого контрастного края.
//   main : 64-лучевой диск Фогеля по радиусу 0.96 x CoC (pre + main в сумме дают диск с СКО CoC/2) плюс 32-лучевая выборка ближнего плана,
//          позволяющая размытым объектам переднего плана мягко наплывать поверх более резких пикселей позади них.
// Правила перекрытия (без ореолов и темных каемок): соседний отсчет учитывается только в том случае, если его собственный диск нерезкости
// достает до текущего пикселя; более далекий отсчет никогда не может размываться шире собственного CoC текущего пикселя (резкие объекты
// сохраняют чистый силуэт), а итоговая сумма перенормируется на принятые веса. Фиксированный шаблон выборки без попиксельного шума:
// отсутствие зерна и межфреймового мерцания. Оба прохода помечены атрибутом CONVOLUTION, поэтому <EffectComposer> в R3F выделяет каждому свой EffectPass.
import { Effect, EffectAttribute, BlendFunction } from "postprocessing";
import { Uniform } from "three";

const frag = /* glsl */ `
uniform float focus;      // дистанция фокусировки вдоль оси взгляда (м)
uniform float cInf;       // радиус диска размытия (в px при 1080x1920) для объектов на бесконечности; 0 = выключено
uniform float nearScale;  // дополнительное усиление размытия для объектов перед плоскостью фокуса
uniform float maxCoC;     // максимальный радиус CoC в px при 1080x1920
#define GOLDEN 2.39996323

float cocAt(float d, float s) {               // знаковый радиус CoC в выходных пикселях
  float c = cInf * s * (1.0 - focus / max(d, 1e-3));
  if (c < 0.0) c *= nearScale;
  return clamp(c, -maxCoC * s, maxCoC * s);
}
float distAt(vec2 uv) { return -getViewZ(readDepth(uv)); }

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  if (cInf < 0.25) { outputColor = inputColor; return; }
  float s = resolution.y / 1920.0;             // выходных пикселей на один пиксель 1080x1920
  float d0 = -getViewZ(depth);
  float r0 = abs(cocAt(d0, s));
  float R = r0 * SPREAD;
  vec3 acc = inputColor.rgb; float wsum = 1.0;
  if (R > 0.5) {
    for (int i = 0; i < TAPS; i++) {
      float rr = sqrt((float(i) + 0.5) / float(TAPS)) * R;
      float a = float(i) * GOLDEN + ROT;
      vec2 suv = uv + vec2(cos(a), sin(a)) * rr * texelSize;
      float ds = distAt(suv);
      float rs = abs(cocAt(ds, s)) * SPREAD;
      if (ds > d0) rs = min(rs, R);            // дальний фон никогда не наплывает на более близкий пиксель
      float w = clamp(rs - rr + 0.5, 0.0, 1.0); // достает ли диск соседа до нашей точки?
      acc += texture2D(inputBuffer, suv).rgb * w; wsum += w;
    }
  }
  vec3 col = acc / wsum;
#if NEAR_TAPS > 0
  float M = maxCoC * s;
  vec3 fg = vec3(0.0); float fw = 0.0, cov = 0.0;
  for (int i = 0; i < NEAR_TAPS; i++) {
    float rr = sqrt((float(i) + 0.5) / float(NEAR_TAPS)) * M;
    if (rr <= R) continue;                      // уже учтено в основной дисковой выборке
    float a = float(i) * GOLDEN + 1.0;
    vec2 suv = uv + vec2(cos(a), sin(a)) * rr * texelSize;
    float ds = distAt(suv);
    if (ds >= d0 * 0.97) continue;              // только объекты переднего плана, расположенные ближе нас
    float rs = abs(cocAt(ds, s));
    float w = clamp(rs - rr + 0.5, 0.0, 1.0);
    fg += texture2D(inputBuffer, suv).rgb * w; fw += w;
    cov += w * (M * M) / max(rs * rs, 1.0);
  }
  if (fw > 0.0) col = mix(col, fg / fw, clamp(cov / float(NEAR_TAPS), 0.0, 1.0));
#endif
  outputColor = vec4(col, inputColor.a);
}`;

type Stage = { taps: number; spread: number; nearTaps: number; rot: number };
const PRE: Stage = { taps: 16, spread: 0.287, nearTaps: 0, rot: 0.61 };
const MAIN: Stage = { taps: 64, spread: 0.958, nearTaps: 32, rot: 0 };

export class LensBlurEffect extends Effect {
  constructor({ maxCoC = 24, nearScale = 1.2, stage = MAIN }: { maxCoC?: number; nearScale?: number; stage?: Stage } = {}) {
    super("LensBlurEffect", frag, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION,
      defines: new Map<string, string>([
        ["TAPS", String(stage.taps)], ["SPREAD", stage.spread.toFixed(4)], ["NEAR_TAPS", String(stage.nearTaps)], ["ROT", stage.rot.toFixed(4)],
      ]),
      uniforms: new Map<string, Uniform>([
        ["focus", new Uniform(10)], ["cInf", new Uniform(0)], ["nearScale", new Uniform(nearScale)], ["maxCoC", new Uniform(maxCoC)],
      ]),
    });
  }
  set focus(v: number) { this.uniforms.get("focus")!.value = v; }
  get focus() { return this.uniforms.get("focus")!.value as number; }
  set cInf(v: number) { this.uniforms.get("cInf")!.value = v; }
  get cInf() { return this.uniforms.get("cInf")!.value as number; }
}

/** Пара проходов, необходимых композеру (сначала pre, затем main); обновляйте focus / cInf один раз за кадр на этом объекте. */
export class LensBlur {
  readonly pre: LensBlurEffect;
  readonly main: LensBlurEffect;
  constructor({ maxCoC = 24, nearScale = 1.2 } = {}) {
    this.pre = new LensBlurEffect({ maxCoC, nearScale, stage: PRE });
    this.main = new LensBlurEffect({ maxCoC, nearScale, stage: MAIN });
  }
  set focus(v: number) { this.pre.focus = v; this.main.focus = v; }
  set cInf(v: number) { this.pre.cInf = v; this.main.cInf = v; }
  dispose() { this.pre.dispose(); this.main.dispose(); }
}

// ---------------- пленочное зерно (в самом конце цепочки, после грейдинга) ----------------
// Монохромный градиентный шум (value-noise) в гамма-пространстве дисплея, СКО ~2.5 % от яркости в средних тонах, ослабленное в
// глубоких черных (контурная тушь остается черной) и вблизи чистого белого. Детерминировано: решетка хэшируется номером кадра (алгоритм PCG),
// поэтому один и тот же кадр всегда рендерится с идентичным зерном (нет мерцания при повторных прогонах), а от кадра к кадру рисунок
// зерна обновляется, как на кинопленке. Размер ячейки задается в пикселях при 1080x1920 и масштабируется через output height / 1920.
const grainFrag = /* glsl */ `
uniform float seed;      // номер кадра
uniform float amount;    // СКО зерна в единицах дисплея (0.025 = 2.5 %)
uniform float cellPx;    // размер зерна в пикселях при 1080x1920
uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float h3(ivec2 c, uint k) { return float(pcg(uint(c.x) + pcg(uint(c.y) + pcg(k)))) * (1.0 / 4294967295.0) - 0.5; }
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 p = uv * resolution / (cellPx * resolution.y / 1920.0);
  ivec2 i = ivec2(floor(p)); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  uint k = uint(seed + 0.5) * 2654435761u + 1013904223u;
  float n = mix(mix(h3(i, k), h3(i + ivec2(1, 0), k), f.x), mix(h3(i + ivec2(0, 1), k), h3(i + ivec2(1, 1), k), f.x), f.y);
  vec3 g = pow(max(inputColor.rgb, 0.0), vec3(1.0 / 2.2));             // гамма-пространство дисплея
  float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
  float w = 0.25 + 0.75 * clamp(4.0 * l * (1.0 - l), 0.0, 1.0);      // меньше зерна в глубоких тенях и ярких светах
  g = max(g + n * (amount / 0.2145) * w, 0.0);                        // 0.2145 = собственное СКО сглаженного решеточного шума
  outputColor = vec4(pow(g, vec3(2.2)), inputColor.a);
}`;

export class GrainEffect extends Effect {
  constructor({ amount = 0.025, cellPx = 1.5 }: { amount?: number; cellPx?: number } = {}) {
    super("GrainEffect", grainFrag, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([["seed", new Uniform(0)], ["amount", new Uniform(amount)], ["cellPx", new Uniform(cellPx)]]),
    });
  }
  set seed(v: number) { this.uniforms.get("seed")!.value = v; }
  set amount(v: number) { this.uniforms.get("amount")!.value = v; }
}
