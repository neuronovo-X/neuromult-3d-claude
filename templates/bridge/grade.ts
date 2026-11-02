// Цветокоррекция (грейдинг) для ролика про мост (агент постобработки): базовый GradeEffect из отчета цветокоррекции,
// дополненный пресетами GRADES / GRADE_STRENGTH / gradeFor(), чтобы можно было перенастроить кривые после слияния освещения.
// Исходные пресеты подгонялись под СТАРЫЕ неосвещенные стоп-кадры: после внедрения нового освещения WORLD они давали пересвет,
// поэтому были пересчитаны во 2-м раунде. Каждый слой Inner (при кроссфейде) использует пресет своего плана, поэтому при DOM-кроссфейде
// на кадрах XFADE (переходы 10->11, 13->14) цветокоррекция также плавно перетекает из одной в другую.
// GradeEffect: подогнанная под референс цветокоррекция, оформленная как Effect библиотеки postprocessing 6.37.
// Ставится ПОСЛЕДНИМ в EffectComposer, после ToneMappingEffect. Работает со значениями в пространстве дисплея (display-referred):
// линейный входной сигнал (уже сжатый тонмаппингом в диапазон 0..1) кодируется в sRGB, корректируется точно по алгоритму scripts/grade.py
// (проверенному на наших стоп-кадрах) и декодируется обратно в линейный вид для выходного буфера композера.
//   1. Тональная кривая RGB: монотонный кубический сплайн Эрмита по 7 узлам в точках x = 0, .1, .25, .5, .75, .9, 1
//   2. Насыщенность относительно яркости Y' (веса Rec.709 по гамма-кодированным значениям), раздельно для теней / средних тонов / светов
//   3. 3-зонное тонирование (split tone): RGB-смещения с нулевой яркостью в тенях, средних тонах и светах
//   4. Виньетка: умножение на (1 - k * smoothstep(r0, 1, r)), где r — эллиптический радиус (в углах кадра r = 1)
// Параметр `amount` плавно смешивает весь грейдинг с оригиналом (0 = обход эффекта).
import { Effect, BlendFunction } from "postprocessing";
import { Uniform, Vector3, Vector2 } from "three";

const frag = /* glsl */ `
uniform float gradeKy[7];
uniform float gradeKm[7];
uniform vec3 gradeSat;      // x = тени, y = средние тона, z = света
uniform vec3 gradeTintS;    // RGB-смещения с нулевой яркостью (в единицах sRGB)
uniform vec3 gradeTintM;
uniform vec3 gradeTintH;
uniform vec2 gradeVig;      // x = сила виньетки k, y = начальный радиус r0
uniform float gradeAmount;

vec3 gradeEncode(vec3 c) {   // линейный -> sRGB
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec3 gradeDecode(vec3 c) {   // sRGB -> линейный
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
float gradeHermite(float v, float x0, float x1, float y0, float y1, float m0, float m1) {
  float h = x1 - x0, t = (v - x0) / h, t2 = t * t, t3 = t2 * t;
  return (2.0 * t3 - 3.0 * t2 + 1.0) * y0 + (t3 - 2.0 * t2 + t) * h * m0 + (-2.0 * t3 + 3.0 * t2) * y1 + (t3 - t2) * h * m1;
}
float gradeCurve(float v) {
  v = clamp(v, 0.0, 1.0);
  if (v < 0.1)  return gradeHermite(v, 0.0, 0.1, gradeKy[0], gradeKy[1], gradeKm[0], gradeKm[1]);
  if (v < 0.25) return gradeHermite(v, 0.1, 0.25, gradeKy[1], gradeKy[2], gradeKm[1], gradeKm[2]);
  if (v < 0.5)  return gradeHermite(v, 0.25, 0.5, gradeKy[2], gradeKy[3], gradeKm[2], gradeKm[3]);
  if (v < 0.75) return gradeHermite(v, 0.5, 0.75, gradeKy[3], gradeKy[4], gradeKm[3], gradeKm[4]);
  if (v < 0.9)  return gradeHermite(v, 0.75, 0.9, gradeKy[4], gradeKy[5], gradeKm[4], gradeKm[5]);
  return gradeHermite(v, 0.9, 1.0, gradeKy[5], gradeKy[6], gradeKm[5], gradeKm[6]);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 src = gradeEncode(inputColor.rgb);
  vec3 c = vec3(gradeCurve(src.r), gradeCurve(src.g), gradeCurve(src.b));
  const vec3 W = vec3(0.2126, 0.7152, 0.0722);
  float y = dot(c, W);
  float wS = 1.0 - smoothstep(0.0, 0.55, y);
  float wH = smoothstep(0.45, 1.0, y);
  float wM = 1.0 - wS - wH;
  float s = gradeSat.y + (gradeSat.x - gradeSat.y) * wS + (gradeSat.z - gradeSat.y) * wH;
  c = vec3(y) + s * (c - vec3(y));
  c += wS * gradeTintS + wM * gradeTintM + wH * gradeTintH;
  vec2 p = uv * 2.0 - 1.0;
  float r = length(p) * 0.70710678;
  c *= 1.0 - gradeVig.x * smoothstep(gradeVig.y, 1.0, r);
  c = clamp(c, 0.0, 1.0);
  outputColor = vec4(gradeDecode(mix(src, c, gradeAmount)), inputColor.a);
}`;

// Базис цветности BT.709 с нулевой яркостью (в единицах sRGB): единичные Cb и Cr как RGB-смещения при неизменной яркости Y'
const E_CB: [number, number, number] = [0.0, -0.18733, 1.8556];
const E_CR: [number, number, number] = [1.5748, -0.46813, 0.0];
export const tintRGB = (cb: number, cr: number) =>
  new Vector3(cb * E_CB[0] + cr * E_CR[0], cb * E_CB[1] + cr * E_CR[1], cb * E_CB[2] + cr * E_CR[2]);

/** Монотонные касательные Фритча — Карлсона для 7 фиксированных узлов кривой (аналогично функции `tangents` в scripts/grade.py) */
export const KX = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
export function monoTangents(ky: number[]): number[] {
  const n = KX.length, h: number[] = [], d: number[] = [], m = new Array(n).fill(0);
  for (let k = 0; k < n - 1; k++) { h.push(KX[k + 1] - KX[k]); d.push((ky[k + 1] - ky[k]) / h[k]); }
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let k = 1; k < n - 1; k++) {
    if (d[k - 1] * d[k] <= 0) { m[k] = 0; continue; }
    const w1 = 2 * h[k] + h[k - 1], w2 = h[k] + 2 * h[k - 1];
    m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
  }
  return m;
}

export type GradeParams = {
  ky: number[];                                  // 7 значений кривой в узлах KX
  sat: [number, number, number];                 // насыщенность: тени, средние тона, света
  tintS: [number, number]; tintM: [number, number]; tintH: [number, number];   // (Cb, Cr) для каждой тональной зоны
  vig: [number, number];                         // сила виньетки, начальный радиус
};

// __GRADES__ (рассчитано скриптом scripts/fit2.py, экспортировано через scripts/emit_ts.py)
export const GRADE_DAY: GradeParams = {
  ky: [0.0345, 0.1828, 0.3812, 0.6605, 0.8814, 0.9631, 1],   // касательные: [1.4831, 1.4038, 1.2198, 0.9867, 0.6608, 0.4346, 0.3693]
  sat: [0.9831, 1.2727, 1.4573],
  tintS: [-0.0291, 0.0411], tintM: [0.0376, -0.0104], tintH: [0.0144, -0.0047],
  vig: [0.1, 0.45],
};
//   тонирование теней: оттенок 20 град, смещение RGB (+16.5, -3.5, -13.8)/255
//   тонирование средних: оттенок 230 град, смещение RGB (-4.2, -0.6, +17.8)/255
//   тонирование светов: оттенок 228 град, смещение RGB (-1.9, -0.1, +6.8)/255
export const GRADE_GOLDEN: GradeParams = {
  ky: [0.0311, 0.1877, 0.4017, 0.6754, 0.875, 0.9582, 1],   // касательные: [1.5667, 1.498, 1.2526, 0.9235, 0.6445, 0.4724, 0.4183]
  sat: [0.8316, 0.8799, 1.7061],
  tintS: [0.0528, 0.0004], tintM: [0.0583, -0.0003], tintH: [0, 0],
  vig: [0.16, 0.4],
};
//   тонирование теней: оттенок 246 град, смещение RGB (+0.2, -2.6, +25.0)/255
//   тонирование средних: оттенок 245 град, смещение RGB (-0.1, -2.7, +27.6)/255
//   тонирование светов: оттенок 0 град, смещение RGB (+0.0, -0.0, +0.0)/255

export class GradeEffect extends Effect {
  constructor(p: GradeParams, amount = 1) {
    super("GradeEffect", frag, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([
        ["gradeKy", new Uniform(p.ky.slice())],
        ["gradeKm", new Uniform(monoTangents(p.ky))],
        ["gradeSat", new Uniform(new Vector3(...p.sat))],
        ["gradeTintS", new Uniform(tintRGB(...p.tintS))],
        ["gradeTintM", new Uniform(tintRGB(...p.tintM))],
        ["gradeTintH", new Uniform(tintRGB(...p.tintH))],
        ["gradeVig", new Uniform(new Vector2(...p.vig))],
        ["gradeAmount", new Uniform(amount)],
      ]),
    });
  }
  /** Переключение пресета по плану (day <-> golden) или плавное смешивание двух пресетов во время кроссфейда / смены времени суток */
  set(p: GradeParams, q?: GradeParams, t = 0) {
    const L = (a: number, b: number) => a + (b - a) * t;
    const r: GradeParams = q ? {
      ky: p.ky.map((v, i) => L(v, q.ky[i])),
      sat: [L(p.sat[0], q.sat[0]), L(p.sat[1], q.sat[1]), L(p.sat[2], q.sat[2])],
      tintS: [L(p.tintS[0], q.tintS[0]), L(p.tintS[1], q.tintS[1])], tintM: [L(p.tintM[0], q.tintM[0]), L(p.tintM[1], q.tintM[1])],
      tintH: [L(p.tintH[0], q.tintH[0]), L(p.tintH[1], q.tintH[1])], vig: [L(p.vig[0], q.vig[0]), L(p.vig[1], q.vig[1])],
    } : p;
    const u = this.uniforms;
    u.get("gradeKy")!.value = r.ky.slice();
    u.get("gradeKm")!.value = monoTangents(r.ky);
    (u.get("gradeSat")!.value as Vector3).set(...r.sat);
    u.get("gradeTintS")!.value = tintRGB(...r.tintS);
    u.get("gradeTintM")!.value = tintRGB(...r.tintM);
    u.get("gradeTintH")!.value = tintRGB(...r.tintH);
    (u.get("gradeVig")!.value as Vector2).set(...r.vig);
  }
  get amount() { return this.uniforms.get("gradeAmount")!.value as number; }
  set amount(v: number) { this.uniforms.get("gradeAmount")!.value = v; }
}

/** Итоговые пресеты для каждого режима освещения (обычные объекты: можно свободно редактировать и подгонять). */
// Перенастройка 2-го раунда поверх заново освещенного мира (агент WORLD). Первичные пресеты выше сильно высветляли картинку
// (так как подгонялись под старые темные рендеры) и вымывали контраст нового света; здесь вместо них работают мягкие S-кривые в полную силу:
//   day: центральный узел .60 для медианной яркости Y' ~.57, тени прижаты (.1 -> .085), легкий фиолетовый оттенок в тенях.
//   golden: более выраженная S-кривая (тени .1 -> .09, средние .5 -> .54), сине-фиолетовая тень, теплый оранжевый блик и более плотная виньетка.
export const GRADE_DAY2: GradeParams = {
  ky: [0, 0.1, 0.28, 0.6, 0.835, 0.945, 1],
  sat: [1.0, 1.05, 1.0],
  tintS: [0.01, 0.002], tintM: [0, 0], tintH: [0.006, 0],
  vig: [0.12, 0.45],
};
export const GRADE_GOLDEN2: GradeParams = {
  ky: [0, 0.09, 0.245, 0.54, 0.8, 0.93, 1],
  sat: [1.0, 1.12, 1.15],
  tintS: [0.02, 0.002], tintM: [0, 0], tintH: [-0.012, 0.006],
  vig: [0.2, 0.4],
};
export const GRADES: Record<"day" | "golden", GradeParams> = { day: GRADE_DAY2, golden: GRADE_GOLDEN2 };
/** Сила воздействия (0..1, свойство `amount` эффекта) для каждого пресета, откалиброванная под НОВЫЙ мир (bridge_world). */
export const GRADE_STRENGTH: Record<"day" | "golden", number> = { day: 1, golden: 1 };
/** Применяет пресет заданного режима освещения к эффекту (обновляет юниформы только при фактической смене режима света). */
export function gradeFor(fx: GradeEffect, light: "day" | "golden") {
  const tag = fx as unknown as { _light?: string };
  if (tag._light !== light) { fx.set(GRADES[light]); tag._light = light; }
  fx.amount = GRADE_STRENGTH[light];
}
