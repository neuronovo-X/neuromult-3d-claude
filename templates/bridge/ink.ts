// Контурная обводка (тушь) для 3D-мира, откалиброванная по замерам референса (рецепт из references/reports/outlines.md,
// доработки агента постобработки: толщина линий масштабируется пропорционально выходной высоте кадра pxScale = height / 1920,
// так что 5.1 px при 1080x1920 превращаются в 6.8 px при 1440x2560, радиус поиска RMAX = 9 с запасом под 1440p,
// окрашивание обводки воздушной дымкой scene.fog с коэффициентом x0.3, и защитный обход `noInkFallback` ниже).
// Раунд 2: толщина x1.5 (5.1 -> 3.3 px на дистанциях от 6 до 90 м), чистый почти черный цвет #030303, дальняя непрозрачность 0.95, порог скачка глубины от 1 %.
//
// Принцип работы:
//  1. Повторный рендер ТОЛЬКО 3D-МИРА (слой камеры 0) в буфер без MSAA: нормали в пространстве вида (rgb), маска покрытия (a) и
//     текстура глубины. Билборды персонажей, карточки эффектов, небосвод, облака и дым живут на слое NOINK, поэтому они никогда
//     не получают прямоугольных рамок вокруг спрайтов и не прорезают дыр в контурах архитектуры.
//  2. Маска краев (в полном разрешении), шаги выборки 1..9 пикселей вдоль осей x, y и обеих диагоналей:
//       глубина (depth) — знаковая вторая разность обратной глубины 1/z (тождественный 0 на любой плоскости, что исключает ложные
//                линии под скользящими углами) -> обводится только БЛИЖНЯЯ сторона скачка глубины полосой шириной `width` px
//                (внешние силуэты на фоне неба, перекрытия объектов, а тонкие тросы превращаются в сплошные черные линии, как в референсе);
//       складка (crease) — угол между нормалями > ~35-50 градусов у соседнего пикселя на той же глубине, двусторонняя полоса шириной ~0.8*width px,
//                вогнутые стыки (примыкание объектов к земле, внутренние углы) рисуются с силой 0.7;
//       покрытие непрерывно зависит от ширины (нет ступенчатого переключения толщины при движении камеры), толщина плавно убывает с
//       расстоянием (5.1 px на 6 м -> 3.3 px на 90 м по логарифму дистанции), непрозрачность до 0.95 и полное угасание к 450 м;
//       обводка подавляется там, где в основном буфере глубины есть объект ближе поверхности мира (персонажи и карточки эффектов на переднем плане).
//  3. Композитинг: сглаживание маски шатровым фильтром 3x3 (антиалиасинг), наложение почти черной туши в гамма-пространстве дисплея (как в Canvas2D)
//     и запись обратно во входной буфер (только цвет; буфер глубины композера остается нетронутым).
//     Оформлено как самостоятельный проход Pass (а не Effect), поэтому <EffectComposer> в R3F выполняет его ПЕРЕД объединенным проходом
//     DOF + Bloom + ToneMapping: благодаря этому глубина резкости (DOF) естественно размывает контурные линии вместе с фоном.
import * as THREE from "three";
import { Pass } from "postprocessing";

/** Слой для объектов, которые никогда не должны обводиться контуром (спрайты персонажей, небо, облака, дым). */
export const NOINK = 3;

export type InkOptions = {
  color?: THREE.ColorRepresentation; // цвет туши в sRGB hex
  strength?: number; // максимальная непрозрачность
  widthNear?: number; // ширина линии силуэта / скачка глубины в px на дистанции distNear (при разрешении 1080x1920)
  widthFar?: number; // ... на дистанции distFar
  distNear?: number; // ближняя дистанция (м)
  distFar?: number; // дальняя дистанция (м)
  creaseScale?: number; // отношение ширины линии складки к ширине линии силуэта
  depthLo?: number; // относительный скачок глубины (1 - z_near / z_far), с которого начинается линия
  depthHi?: number; // ... при котором линия выходит на полную силу
  angleLo?: number; // угол излома нормалей (в градусах), с которого начинается линия складки
  angleHi?: number; // ... при котором складка выходит на полную силу
  concaveGain?: number; // множитель силы для вогнутых стыков (объект на земле, внутренние углы)
  farOpacity?: number; // множитель непрозрачности на дистанции distFar
  fadeNear?: number; // м: начало дальнего затухания линий
  fadeFar?: number; // м: полное исчезновение линий
};

const DEF: Required<InkOptions> = {
  // раунд 2 (замечание ревью: «контуры мира сделать в ~1.5 раза толще, чистый черный на всех силуэтах»): ширина x1.5 (складки масштабируются
  // через creaseScale), чистый почти черный цвет, дальняя непрозрачность 0.75 -> 0.95; примесь тумана в цвет контура 0.6 -> 0.3 (compMat fogInk)
  color: "#030303", strength: 1.0,
  widthNear: 5.1, widthFar: 3.3, distNear: 6, distFar: 90, creaseScale: 0.8, // раунд 3: складки 0.64 -> 0.8 (углы домов)
  depthLo: 0.01, depthHi: 0.03, angleLo: 35, angleHi: 50, concaveGain: 0.7, // скачки глубины от 1 %; складки от 35 град (карнизы крыш)
  farOpacity: 0.95, fadeNear: 150, fadeFar: 450,
};

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Проход нормалей только для 3D-мира (scene.overrideMaterial); поддерживает Mesh и InstancedMesh. Прорезные материалы
// (map + alphaTest, например табличка с правилом или церковные часы) сохраняют свой альфа-силуэт: см. onBeforeRender в конструкторе.
const NORMAL_VERT = /* glsl */ `
#include <common>
uniform mat3 cutUv;
varying vec3 vN;
varying vec3 vV;
varying vec2 vCut;
void main() {
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  vN = transformedNormal;
  vCut = (cutUv * vec3(uv, 1.0)).xy;
  #include <begin_vertex>
  #include <project_vertex>
  vV = mvPosition.xyz;
}`;
const NORMAL_FRAG = /* glsl */ `
uniform sampler2D tCut;
uniform float cut;
varying vec3 vN;
varying vec3 vV;
varying vec2 vCut;
void main() {
  if (cut > 0.0 && texture2D(tCut, vCut).a < cut) discard;
  vec3 n;
  if (dot(vN, vN) < 1e-8) n = normalize(cross(dFdx(vV), dFdy(vV)));   // геометрия без вершинных нормалей
  else n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);            // обратные грани двусторонних плоскостей
  gl_FragColor = vec4(n, 1.0);
}`;

const MASK_FRAG = /* glsl */ `
#include <packing>
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform sampler2D tMainDepth;
uniform vec2 texel;
uniform float cNear;
uniform float cFar;
uniform float p00;
uniform float p11;
uniform float wNear;
uniform float wFar;
uniform float dNear;
uniform float dFar;
uniform float creaseScale;
uniform float depthLo;
uniform float depthHi;
uniform float cosLo;
uniform float cosHi;
uniform float concaveGain;
uniform float farOpacity;
uniform float fadeNear;
uniform float fadeFar;
uniform float strength;
uniform float useMain;
uniform float pxScale;   // выходных пикселей на один пиксель 1080x1920
uniform vec2 fogRange;   // ближняя и дальняя границы тумана сцены (м); far <= near = без окраски туманом
uniform float fogStart;  // до этой дистанции (м) тушь остается чисто черной, далее плавно смешивается с цветом тумана
varying vec2 vUv;

// шаги пиксельной сетки вдоль x, y и обеих диагоналей, а также их евклидова длина в пикселях
const vec2 STEP[4] = vec2[4](vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(1.0, 1.0), vec2(1.0, -1.0));
const float SLEN[4] = float[4](1.0, 1.0, 1.41421, 1.41421);
#define RMAX 9   // покрывает 5.1 px x pxScale 1.333 = 6.8 px при 1440x2560 (+0.5 px на антиалиасинг края)

// textureLod: явный нулевой уровень детализации внутри циклов (буферы с фильтрацией Nearest, производные не нужны)
float dist(sampler2D t, vec2 uv) { return -perspectiveDepthToViewZ(textureLod(t, uv, 0.0).x, cNear, cFar); }
vec3 viewPos(vec2 uv, float d) { vec2 n = uv * 2.0 - 1.0; return vec3(n.x * d / p00, n.y * d / p11, -d); }

// сила излома нормалей (складки) между текущим пикселем (n0, P0) и соседним пикселем
float crease(vec3 n0, vec3 P0, float zc, vec2 uq, float zq) {
  vec4 nq = textureLod(tNormal, uq, 0.0);
  if (nq.a < 0.5 || abs(zq - zc) > zc * depthLo) return 0.0;       // небо или скачок глубины: не является внутренней складкой
  float k = 1.0 - smoothstep(cosHi, cosLo, dot(n0, nq.xyz));
  if (dot(viewPos(uq, zq) - P0, n0) > 0.0) k *= concaveGain;        // сосед выступает перед нашей касательной плоскостью: вогнутый угол
  return k;
}

void main() {
  vec4 nc = textureLod(tNormal, vUv, 0.0);
  if (nc.a < 0.5) { gl_FragColor = vec4(0.0); return; }          // небо / пустота: контур рисуется только по ближнему объекту
  float zc = dist(tDepth, vUv);

  // персонажи, карточки эффектов и т.д. (отсутствующие в буфере мира) перекрывают этот пиксель: не рисуем линии мира поверх них
  if (useMain > 0.5) {
    float zm = dist(tMainDepth, vUv);
    zm = min(zm, dist(tMainDepth, vUv + vec2(texel.x, 0.0)));
    zm = min(zm, dist(tMainDepth, vUv - vec2(texel.x, 0.0)));
    zm = min(zm, dist(tMainDepth, vUv + vec2(0.0, texel.y)));
    zm = min(zm, dist(tMainDepth, vUv - vec2(0.0, texel.y)));
    if (zm < zc * 0.985 - 0.03) { gl_FragColor = vec4(0.0); return; }
  }

  float t = clamp(log(zc / dNear) / log(dFar / dNear), 0.0, 1.0);
  float w = mix(wNear, wFar, t) * pxScale;           // ширина линии силуэта (в выходных px) на данной дистанции, только по ближней стороне
  float hc = 0.5 * w * creaseScale;                  // полуширина линии складки (px), рисуется по обеим смежным граням
  float Wc = 1.0 / zc;
  vec3 n0 = nc.xyz;
  vec3 P0 = viewPos(vUv, zc);
  float eD = 0.0, eN = 0.0;
  for (int a = 0; a < 4; a++) {
    for (int r = 1; r <= RMAX; r++) {
      vec2 o = STEP[a] * texel * float(r);
      float d = (float(r) - 0.5) * SLEN[a];          // расстояние от центра текущего пикселя до края, впервые обнаруженного на шаге r
      float cw = clamp(w + 0.5 - d, 0.0, 1.0);       // непрерывное покрытие -> отсутствие скачков толщины и встроенное сглаживание краев
      float ch = clamp(hc + 0.5 - d, 0.0, 1.0);
      if (cw <= 0.0 && ch <= 0.0) break;
      float z1 = dist(tDepth, vUv - o), z2 = dist(tDepth, vUv + o);
      // скачок глубины: текущий пиксель ближе своих соседей (вторая разность 1/z < 0; на любых плоских гранях равна строго 0)
      float s = (1.0 / z1 + 1.0 / z2 - 2.0 * Wc) / Wc;
      eD = max(eD, smoothstep(depthLo, depthHi, -s) * cw);
      // складка: нормаль поворачивается относительно соседа, находящегося на той же глубине
      if (ch > 0.0) eN = max(eN, max(crease(n0, P0, zc, vUv - o, z1), crease(n0, P0, zc, vUv + o, z2)) * ch);
    }
  }

  float ink = max(eD, eN) * strength * mix(1.0, farOpacity, t) * (1.0 - smoothstep(fadeNear, fadeFar, zc));
  float f0 = max(fogRange.x, fogStart);
  float fogK = fogRange.y > f0 ? clamp((zc - f0) / (fogRange.y - f0), 0.0, 1.0) : 0.0;
  gl_FragColor = vec4(ink, fogK, 0.0, 1.0);
}`;

const COMP_FRAG = /* glsl */ `
uniform sampler2D inputBuffer;
uniform sampler2D tMask;
uniform sampler2D tNormal;
uniform vec2 texel;
uniform vec3 inkColor;
uniform vec3 fogColor;
uniform float fogInk;   // насколько сильно контур в густом тумане смещается к цвету дымки (0.3)
uniform int debug;
varying vec2 vUv;
float m(float x, float y) { return texture2D(tMask, vUv + vec2(x, y) * texel).r; }
void main() {
  float a = (4.0 * m(0.0, 0.0)
    + 2.0 * (m(1.0, 0.0) + m(-1.0, 0.0) + m(0.0, 1.0) + m(0.0, -1.0))
    + m(1.0, 1.0) + m(-1.0, 1.0) + m(1.0, -1.0) + m(-1.0, -1.0)) / 16.0;   // шатровое ядро 1-2-1 = антиалиасинг
  vec4 c = texture2D(inputBuffer, vUv);
  if (debug == 1) { gl_FragColor = vec4(vec3(1.0 - a), 1.0); return; }               // только маска линий
  if (debug == 2) { gl_FragColor = vec4(texture2D(tNormal, vUv).xyz * 0.5 + 0.5, 1.0); return; } // нормали мира
  // смешивание в гамма-пространстве дисплея, как это делает Canvas2D для рисунков персонажей: покрытие линейно переходит
  // в визуальную темноту на экране, поэтому измеряемая толщина линий в точности равна заданной (в линейном свете линии выглядят на ~30 % тоньше)
  float fk = texture2D(tMask, vUv).g;                       // плотность тумана на линии (максимум по окрестности сглаживания)
  fk = max(fk, max(texture2D(tMask, vUv + vec2(texel.x, 0.0)).g, texture2D(tMask, vUv - vec2(texel.x, 0.0)).g));
  fk = max(fk, max(texture2D(tMask, vUv + vec2(0.0, texel.y)).g, texture2D(tMask, vUv - vec2(0.0, texel.y)).g));
  vec3 inkC = mix(inkColor, fogColor, fk * fogInk);
  vec3 g = pow(max(c.rgb, 0.0), vec3(1.0 / 2.2));
  gl_FragColor = vec4(pow(mix(g, pow(inkC, vec3(1.0 / 2.2)), a), vec3(2.2)), c.a);
}`;

const COPY_FRAG = /* glsl */ `
uniform sampler2D tSrc;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tSrc, vUv);
  #include <colorspace_fragment>
}`;

export class InkPass extends Pass {
  /** 0 = обычный режим, 1 = показать маску контуров, 2 = показать буфер нормалей мира */
  debug = 0;
  private world: THREE.Scene;
  private cam: THREE.PerspectiveCamera;
  private rt: THREE.WebGLRenderTarget;
  private maskRT: THREE.WebGLRenderTarget;
  private tmpRT: THREE.WebGLRenderTarget;
  private normalMat: THREE.ShaderMaterial;
  private maskMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private copyMat: THREE.ShaderMaterial;
  private fsScene = new THREE.Scene();
  private fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private clearCol = new THREE.Color();

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, options: InkOptions = {}) {
    super("InkPass");
    const o = { ...DEF, ...options };
    this.world = scene;
    this.cam = camera;
    this.cam.layers.enable(NOINK); // основной рендер по-прежнему отображает объекты слоя NOINK (и отбрасываемые ими тени)
    this.needsSwap = false; // записывает результат обратно во входной буфер (сохраняя текстуру глубины композера нетронутой)
    this.needsDepthTexture = true;

    this.rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      generateMipmaps: false, depthBuffer: true, samples: 0,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
    });
    this.maskRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      generateMipmaps: false, depthBuffer: false,
    });
    this.tmpRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      generateMipmaps: false, depthBuffer: false,
    });

    this.normalMat = new THREE.ShaderMaterial({
      vertexShader: NORMAL_VERT, fragmentShader: NORMAL_FRAG, side: THREE.DoubleSide,
      uniforms: { tCut: { value: null }, cut: { value: 0 }, cutUv: { value: new THREE.Matrix3() } },
    });
    // перед отрисовкой каждого объекта копируем параметры прорезки (map + alphaTest) исходного материала, чтобы плоскости с альфа-тестом держали контур
    this.normalMat.onBeforeRender = (_r, _s, _c, _g, object, group) => {
      const mat = (object as THREE.Mesh).material as THREE.Material | THREE.Material[];
      const gi = (group as unknown as { materialIndex?: number } | null)?.materialIndex ?? 0; // индекс группы геометрии во время выполнения
      const src = (Array.isArray(mat) ? mat[gi] : mat) as THREE.MeshLambertMaterial;
      const u = this.normalMat.uniforms;
      const map = src && src.alphaTest > 0 ? src.map : null;
      u.tCut.value = map; u.cut.value = map ? src.alphaTest : 0;
      if (map) { map.updateMatrix(); (u.cutUv.value as THREE.Matrix3).copy(map.matrix); }
      this.normalMat.uniformsNeedUpdate = true;
    };
    const fs = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
    const texel = new THREE.Vector2(1, 1);
    this.maskMat = fs(MASK_FRAG, {
      tNormal: { value: this.rt.texture }, tDepth: { value: this.rt.depthTexture }, tMainDepth: { value: null },
      texel: { value: texel }, cNear: { value: 0.2 }, cFar: { value: 1500 }, p00: { value: 1 }, p11: { value: 1 },
      wNear: { value: o.widthNear }, wFar: { value: o.widthFar }, dNear: { value: o.distNear }, dFar: { value: o.distFar },
      creaseScale: { value: o.creaseScale }, depthLo: { value: o.depthLo }, depthHi: { value: o.depthHi },
      cosLo: { value: Math.cos((o.angleLo * Math.PI) / 180) }, cosHi: { value: Math.cos((o.angleHi * Math.PI) / 180) },
      concaveGain: { value: o.concaveGain }, farOpacity: { value: o.farOpacity },
      fadeNear: { value: o.fadeNear }, fadeFar: { value: o.fadeFar }, strength: { value: o.strength }, useMain: { value: 0 }, pxScale: { value: 1 }, fogRange: { value: new THREE.Vector2(0, 0) }, fogStart: { value: 60 },
    });
    this.compMat = fs(COMP_FRAG, {
      inputBuffer: { value: null }, tMask: { value: this.maskRT.texture }, tNormal: { value: this.rt.texture },
      texel: { value: texel }, inkColor: { value: new THREE.Color(o.color) }, debug: { value: 0 },
      fogColor: { value: new THREE.Color() }, fogInk: { value: 0.3 },
    });
    this.copyMat = fs(COPY_FRAG, { tSrc: { value: this.tmpRT.texture } });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.maskMat);
    this.quad.frustumCulled = false;
    this.fsScene.add(this.quad);
  }

  /** Настройка параметров на лету, например: ink.set({ widthNear: 4.2, concaveGain: 0.5 }) */
  set(options: InkOptions) {
    const u = this.maskMat.uniforms;
    const map: [keyof InkOptions, string][] = [["widthNear", "wNear"], ["widthFar", "wFar"], ["distNear", "dNear"], ["distFar", "dFar"],
      ["creaseScale", "creaseScale"], ["depthLo", "depthLo"], ["depthHi", "depthHi"], ["concaveGain", "concaveGain"],
      ["farOpacity", "farOpacity"], ["fadeNear", "fadeNear"], ["fadeFar", "fadeFar"], ["strength", "strength"]];
    for (const [k, n] of map) if (options[k] !== undefined) u[n].value = options[k];
    if (options.angleLo !== undefined) u.cosLo.value = Math.cos((options.angleLo * Math.PI) / 180);
    if (options.angleHi !== undefined) u.cosHi.value = Math.cos((options.angleHi * Math.PI) / 180);
    if (options.color !== undefined) (this.compMat.uniforms.inkColor.value as THREE.Color).set(options.color);
  }

  override setDepthTexture(depthTexture: THREE.Texture) {
    this.maskMat.uniforms.tMainDepth.value = depthTexture ?? null;
    this.maskMat.uniforms.useMain.value = depthTexture ? 1 : 0;
  }

  override setSize(width: number, height: number) {
    this.rt.setSize(width, height);
    this.maskRT.setSize(width, height);
    this.tmpRT.setSize(width, height);
    (this.maskMat.uniforms.texel.value as THREE.Vector2).set(1 / width, 1 / height);
    this.maskMat.uniforms.pxScale.value = height / 1920; // базовые толщины линий заданы для разрешения 1080x1920
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget) {
    const scene = this.world, cam = this.cam;
    const autoClear = renderer.autoClear, shadowAuto = renderer.shadowMap.autoUpdate;
    const mask = cam.layers.mask, override = scene.overrideMaterial, background = scene.background;
    renderer.getClearColor(this.clearCol);
    const clearAlpha = renderer.getClearAlpha();
    renderer.autoClear = false;

    // 1) нормали и глубина только для 3D-мира (без персонажей, спрайтов и неба; карты теней повторно не пересчитываются)
    cam.layers.disable(NOINK);
    scene.overrideMaterial = this.normalMat;
    scene.background = null;
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.rt);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    cam.layers.mask = mask;
    scene.overrideMaterial = override;
    scene.background = background;
    renderer.shadowMap.autoUpdate = shadowAuto;
    renderer.setClearColor(this.clearCol, clearAlpha);

    // 2) маска контурных краев
    const u = this.maskMat.uniforms, e = cam.projectionMatrix.elements;
    u.cNear.value = cam.near; u.cFar.value = cam.far; u.p00.value = e[0]; u.p11.value = e[5];
    const fog = scene.fog as THREE.Fog | null;
    if (fog && (fog as THREE.Fog).isFog) { (u.fogRange.value as THREE.Vector2).set(fog.near, fog.far); (this.compMat.uniforms.fogColor.value as THREE.Color).copy(fog.color); }
    else (u.fogRange.value as THREE.Vector2).set(0, 0);
    this.quad.material = this.maskMat;
    renderer.setRenderTarget(this.maskRT);
    renderer.render(this.fsScene, this.fsCam);

    // 3) композитинг во временный буфер, 4) копирование обратно во входной буфер (только цвет; буфер глубины остается нетронутым)
    this.compMat.uniforms.inputBuffer.value = inputBuffer.texture;
    this.compMat.uniforms.debug.value = this.debug;
    this.quad.material = this.compMat;
    renderer.setRenderTarget(this.tmpRT);
    renderer.render(this.fsScene, this.fsCam);
    this.quad.material = this.copyMat;
    renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer);
    renderer.render(this.fsScene, this.fsCam);

    renderer.autoClear = autoClear;
  }

  override dispose() {
    this.rt.depthTexture?.dispose();
    this.rt.dispose(); this.maskRT.dispose(); this.tmpRT.dispose();
    this.normalMat.dispose(); this.maskMat.dispose(); this.compMat.dispose(); this.copyMat.dispose();
    this.quad.geometry.dispose();
  }
}

/** Страховочная сетка для контракта NOINK (модули CHAR и WORLD сами назначают слой NOINK карточкам, небу, облакам и дыму):
 *  любой объект, не пишущий глубину в основном рендере (сфера неба, карточки облаков и дыма, мягкие спрайты эффектов), а также все
 *  ориентированные на камеру билборды (сетки с прорезным customDepthMaterial = актеры; карточки эффектов на базе MeshBasicMaterial
 *  с alphaTest > 0) автоматически переводятся на слой NOINK. Идемпотентна, нетребовательна к ресурсам (один обход дерева), безопасна для вызова в каждом кадре. */
export function noInkFallback(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!(m.isMesh || (o as THREE.Sprite).isSprite || (o as THREE.Points).isPoints || (o as THREE.Line).isLine)) return;
    if (o.layers.mask === 1 << NOINK) return;
    const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.Material[];
    const card = !!m.customDepthMaterial || (o as THREE.Sprite).isSprite || (o as THREE.Points).isPoints || (o as THREE.Line).isLine;
    const noDepth = mats.some((x) => x && x.depthWrite === false);
    const basicCut = mats.some((x) => x && (x as THREE.MeshBasicMaterial).isMeshBasicMaterial && x.alphaTest > 0);
    if (card || noDepth || basicCut) o.layers.set(NOINK);
  });
}
