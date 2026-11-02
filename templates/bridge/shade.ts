// Стилизованное двухтоновое освещение для всех материалов 3D-мира (lighting.md 9.2, часть окружения): альбедо x mix(shadeCol, litCol,
// sunTerm), где sunTerm = видимость по карте теней x мягкий терминатор N.L. Видимость солнца перехватывается прямо внутри собственного
// цикла расчета света Three.js (LFB), поэтому ничего не вычисляется дважды. Карточки персонажей (cardShade) описаны в модуле агента CHAR
// и импортируют LFB / CHAR отсюда; world.ts обновляет все юниформы ниже один раз за кадр из пресетов LIGHTS.
import * as THREE from "three";

export const TONE = {
  uLitCol: { value: new THREE.Vector3(1.5, 1.44, 1.32) }, uShadeCol: { value: new THREE.Vector3(0.6, 0.58, 0.86) },
  uShadeLift: { value: new THREE.Vector3() }, uLambert: { value: 0.35 }, uSideK: { value: 0.84 }, uTerm: { value: 0.2 },
  uBounce: { value: new THREE.Vector3() }, // теплый рефлекс на затененных гранях, обращенных к камере (только в золотой час; днем = 0)
  uSat: { value: 1 }, // насыщенность альбедо мира относительно его яркости (персонажи не используют twoTone, поэтому не затрагиваются)
};
/** Юниформы карточек персонажей (lighting.md 9.2 cardShade); world.ts синхронизирует их с LIGHTS для модуля cardshade.ts */
export const CHAR = {
  uCharTint: { value: new THREE.Vector3(1, 0.94, 0.92) }, uCharShade: { value: 0.86 }, uGrad: { value: 0.07 },
  uBodyGrad: { value: 0.2 }, uSideTint: { value: new THREE.Vector3(0.92, 0.9, 0.96) },
};

// Направленный источник света 0 = солнце = единственный источник, отбрасывающий тени (Three.js сортирует источники с тенями первыми).
// Только РАЗВЕРНУТЫЙ индекс 0 компилирует теневой блок, поэтому переменная sunVis записывается ровно один раз.
export const LFB = THREE.ShaderChunk.lights_fragment_begin
  .replace("directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ]",
    "sunVis = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ]")
  .replace("vDirectionalShadowCoord[ i ] ) : 1.0;", "vDirectionalShadowCoord[ i ] ) : 1.0;\n\t\tdirectLight.color *= sunVis;");
if (!LFB.includes("directLight.color *= sunVis")) throw new Error("shade.ts: three lights_fragment_begin changed");

const TWO_TONE = /* glsl */ `
#if NUM_DIR_LIGHTS > 0
{
  vec3 sunV = directionalLights[ 0 ].direction;                               // пространство вида, вектор к солнцу
  vec3 upV = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  float ndl = max( dot( geometryNormal, sunV ), 0.0 );
  float sunTerm = sunVis * smoothstep( 0.0, uTerm, ndl );                     // 0 = падающая или собственная тень, 1 = освещенная грань
  float skyK = mix( uSideK, 1.0, 0.5 + 0.5 * dot( geometryNormal, upV ) );    // грани, обращенные к небу, чуть светлее
  vec3 lit = uLitCol * mix( 1.0, ndl, uLambert );                             // сохраняем долю косинусной светотени формы
  float facing = max( dot( geometryNormal, geometryViewDir ), 0.0 );        // 1 = грань смотрит прямо в объектив
  vec3 alb = max( mix( vec3( dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ), diffuseColor.rgb, uSat ), 0.0 );
  reflectedLight.directDiffuse = alb * ( mix( uShadeCol, lit, sunTerm ) * skyK + uBounce * facing * clamp( 1.0 - dot( geometryNormal, upV ), 0.0, 1.0 ) * ( 1.0 - sunTerm ) )
    + uShadeLift * LIFT_K * ( 1.0 - sunTerm );
  reflectedLight.indirectDiffuse = vec3( 0.0 );                               // полусферический и заполняющий свет здесь больше не используются
}
#endif
`;
const DECL = "#include <common>\nuniform vec3 uLitCol; uniform vec3 uShadeCol; uniform vec3 uShadeLift; uniform float uLambert; uniform float uSideK; uniform float uTerm; uniform vec3 uBounce; uniform float uSat;";

/** Переводит материал Lambert (или Phong: его зеркальный блик сохраняется, маскируясь тенью) в двухтоновый режим. Вызывать один раз на материал. */
export function twoTone<T extends THREE.MeshLambertMaterial | THREE.MeshPhongMaterial>(m: T, liftK = 1): T {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, TONE);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", DECL + `\n#define LIFT_K ${liftK.toFixed(3)}`)
      .replace("#include <lights_fragment_begin>", "float sunVis = 1.0;\n" + LFB)
      .replace("#include <lights_fragment_end>", "#include <lights_fragment_end>\n" + TWO_TONE);
  };
  m.customProgramCacheKey = () => "twoTone5_" + liftK.toFixed(3);
  return m;
}

// ---------------- обращение тональной компрессии (tone-map inversion) ----------------
// Композер завершает работу тонмаппингом PBR-Neutral, поэтому цвет, записанный напрямую в буфер сцены, НЕ равен тому, что окажется на экране
// (в тенях: линейное смещение -0.04, в светах: компрессия плеча выше 0.76). Самосветящиеся элементы, чей экранный цвет задан точным целевым
// замером (небо, туман, вода реки), записываются через untone(target) — как линейное значение, которое кривая Neutral отобразит точно в цель.
const neutral = (c: number[]) => {
  const x = Math.min(c[0], c[1], c[2]), off = x < 0.08 ? x - 6.25 * x * x : 0.04;
  const v = c.map((k) => k - off), peak = Math.max(v[0], v[1], v[2]), S = 0.76;
  if (peak < S) return v;
  const d = 1 - S, np = 1 - (d * d) / (peak + d - S), g = 1 - 1 / (0.15 * (peak - np) + 1);
  return v.map((k) => (k * np) / peak * (1 - g) + np * g);
};
/** Находит линейный входной цвет, который тонмаппер Neutral преобразует в заданный экранный цвет (hex или THREE.Color, цель в sRGB) */
export const untone = (target: THREE.ColorRepresentation, out = new THREE.Color()) => {
  const t = new THREE.Color(target); // рабочее линейное пространство
  const tt = [t.r, t.g, t.b].map((k) => Math.min(k, 0.985));
  let c = tt.slice();
  for (let i = 0; i < 60; i++) { const y = neutral(c); c = c.map((k, j) => Math.max(0, k + (tt[j] - y[j]))); }
  return out.setRGB(c[0], c[1], c[2]);
};
