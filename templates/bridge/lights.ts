// Пресеты освещения по времени суток. Солнце ПРИВЯЗАНО К КАМЕРЕ и фиксируется для каждого плана (world.ts update()):
// az = градусы отклонения от продольной оси взгляда камеры плана (0 = солнце прямо по курсу = контровой свет, +90 = справа по экрану,
// 180 = за спиной камеры), el = угол возвышения над горизонтом. lit/shade/lift — ЛИНЕЙНЫЕ RGB-множители для shade.ts (могут превышать 1).
// Имена полей в точности следуют спецификации lighting.md 9.1 (их читают модули CHAR и POST); значения откалиброваны по рендерам.
type C3 = [number, number, number];
export type LightPreset = {
  az: number; el: number;
  lit: C3; shade: C3; lift: C3; lambert: number; sideK: number; term: number;      // двухтоновый шейдинг мира (shade.ts)
  charTint: C3; charShade: number; charGrad: number; bodyGrad: number; sideTint: C3; // карточки персонажей (cast.ts)
  blob: C3; actorShadow: boolean;                                                    // пятна контакта / отбрасываемые карточками тени
  top: string; hor: string; skyCurve: C3; fog: string; fogNear: number; fogFar: number; sunDisc: string; // параметры атмосферы (depth.md 6.5)
  sunCol: string; sunI: number; sky: string; ground: string; hemiI: number;         // стандартные источники Three.js (только для немодифицированных материалов)
  bias: number; normalBias: number;
};
export const LIGHTS: Record<"day" | "golden", LightPreset> = {
  day: {
    az: 75, el: 48,
    lit: [1.58, 1.5, 1.33], shade: [0.3, 0.29, 0.36], lift: [0.05, 0.06, 0.11], lambert: 0.35, sideK: 0.84, term: 0.2,
    charTint: [1.0, 0.94, 0.92], charShade: 0.86, charGrad: 0.07, bodyGrad: 0.2, sideTint: [0.92, 0.90, 0.96],
    blob: [0.62, 0.58, 0.58], actorShadow: false,
    top: "#3e7fd2", hor: "#b8d0ec", skyCurve: [0.0, 0.5, 0.6], fog: "#b8d0ec", fogNear: 25, fogFar: 300, sunDisc: "#000000",
    sunCol: "#fff3e0", sunI: 2.8, sky: "#dcecff", ground: "#b49a78", hemiI: 0.55,
    bias: -0.00025, normalBias: 0.015,
  },
  golden: {
    az: 6, el: 7,
    lit: [1.5, 0.68, 0.24], shade: [0.15, 0.15, 0.3], lift: [0.04, 0.06, 0.17], lambert: 0.35, sideK: 0.82, term: 0.07,
    charTint: [1.0, 0.78, 0.56], charShade: 0.88, charGrad: 0.1, bodyGrad: 0.25, sideTint: [0.85, 0.80, 0.95],
    blob: [0.75, 0.74, 0.9], actorShadow: true,
    top: "#6a4f8c", hor: "#ffd08a", skyCurve: [0.05, 0.6, 1.0], fog: "#efb489", fogNear: 50, fogFar: 380, sunDisc: "#ffcf9e",
    sunCol: "#ffab5e", sunI: 5.5, sky: "#d8b0b8", ground: "#8a6a60", hemiI: 0.5,
    bias: -0.0006, normalBias: 0.03,
  },
};

/** Визуальная палитра окружения для каждого режима света (узлы градиента неба по углу места в градусах, цвета реки, палитра облаков).
 *  Все цвета заданы как ЦЕЛЕВЫЕ ЭКРАННЫЕ значения с учетом текущего тонмаппера PBR-Neutral; world.ts предварительно обращает тонмаппинг через untone() (shade.ts). */
export type WorldLook = {
  sky: { c: string[]; e: number[] };                         // 5 узлов: цвет c[i] на высоте e[i] (в градусах) со сглаживанием smoothstep между ними
  water: { near: string; mid: string; far: string; crest: string; trough: string; glint: string; shade: C3 };
  bounce: C3;                                                 // shade.ts uBounce: альбедо x рефлекс на затененных гранях, обращенных к объективу
  sat: number;                                                // shade.ts uSat: насыщенность альбедо мира (1 = как нарисовано)
  cloud: { lit: string; mid: string; shade: string };
};
export const LOOK: Record<"day" | "golden", WorldLook> = {
  day: {
    // depth.md 2.2: горизонт #9fb6e6 сразу над силуэтами крыш, верхнее небо #5e93d9 на высоте ~20 град (после грейдинга верх кадра #5997e2)
    sky: { c: ["#b8d0ec", "#9cbfea", "#6a9fe0", "#4f8cdb", "#3373cc"], e: [0, 3, 8, 16, 40] },
    water: { near: "#22a7b6", mid: "#167fb2", far: "#1a5596", crest: "#7ddfe8", trough: "#0e4a80", glint: "#ffffff", shade: [0.5, 0.56, 0.72] },
    cloud: { lit: "#fbf8f1", mid: "#e1e5f3", shade: "#c3cbe9" },
    bounce: [0, 0, 0],
    sat: 1.08,
  },
  golden: {
    // закат, но не сумерки: горизонт #ffd08a, персиково-оранжевый до ~10 град, теплая роза на 20 град, приглушенный лиловый только у самого верха
    // (грейдинг золотого часа добавляет ~+11/255 синего в тени и средние тона, поэтому исходники смещены в теплую сторону)
    sky: { c: ["#ffc47c", "#f7ae78", "#e8967c", "#c4848e", "#8a6f8a"], e: [0, 4, 10, 20, 40] },
    water: { near: "#1e3a6e", mid: "#355f96", far: "#d4a48e", crest: "#d9a088", trough: "#16294f", glint: "#ffe2b0", shade: [0.42, 0.46, 0.72] },
    cloud: { lit: "#ffd2a8", mid: "#f2a08f", shade: "#a98fc4" },
    bounce: [0.04, 0.02, 0.0],
    sat: 1.1,
  },
};
