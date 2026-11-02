// Шейдинг карточек персонажей (lighting.md 9.2 / 9.5). Убирает плоский эмиссивный эффект «наклейки поверх кадра»: карточка
// принимает цветовой тон освещения сцены, сохраняет светлый порог там, где на нее падает внешняя тень (charShade ~.86),
// и получает мягкий боковой градиент по направлению к реальному солнцу (голова ~charGrad, торс ~bodyGrad) с лавандовым оттенком на теневой стороне.
// Контракт с модулем WORLD: LFB (видимость солнечной тени внутри цикла освещения Three.js) и CHAR (юниформы, обновляемые в world.ts из
// пресетов LIGHTS каждый кадр) импортируются из shade.ts; направление солнца берется из собственного направленного источника света 0 в Three.js.
// Сам рисунок уже несет нарисованный полумесяц светотени (toon.ts shadedFill / gradFill), поэтому шейдер добавляет GRAD_K от
// градиента пресета, а цветовой тон пресета (измеренный на БЕЛЫХ головах) применяется с весом TINT_K, чтобы персиковая кожа оставалась чистой
// (примечание lighting.md 9.1: закат ~[1, .88, .76], день ~[1, .97, .96] для персиковой кожи).
import * as THREE from "three";
import { LFB, CHAR } from "./shade";

export const GRAD_K = 5.5;   // голова: charGrad пресета x5.5, с ограничением на .4 в линейном пространстве: ~14 % на экране после компрессии
                             // светов грейдингом и тонмаппингом (лица там держатся на уровне ~.96; 2-й раунд ревью)
export const GRAD_KB = 1.6;  // торс: bodyGrad пресета x1.6 -> ~10-15 % собственной светотени формы на экране (3-й раунд ревью)
export const TINT_K = 0.55;

// Зоны карточки в UV-координатах (v = 1 на верхнем крае проектной карточки 600 x 1000): подбородок взрослого на y ~420 -> v .58,
// центр головы y ~309 -> v .69, полувысота головы ~111 -> .11. Полуширина головы ~118 единиц -> .2 ширины карточки, торса ~89 -> .15.
const CARD = /* glsl */ `
vec3 tintK = mix( vec3( 1.0 ), uCharTint, uTintK );
tintK /= pow( max( dot( tintK, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.2 ), uNorm );             // одинаковая светлота лица днем и на закате
vec3 outgoingLight = diffuseColor.rgb * tintK;
#if NUM_DIR_LIGHTS > 0
{
  vec3 sunV = directionalLights[ 0 ].direction;                                          // пространство вида, вектор к солнцу
  vec3 upV = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  float side = sign( sunV.x ) * smoothstep( 0.0, 0.35, abs( sunV.x ) );                     // насыщается: даже почти фронтальное солнце затеняет один бок (+ = солнце справа)
  float head = smoothstep( 0.565, 0.6, vMapUv.y );                                        // зона головы против туловища
  float hw = mix( 0.15, 0.2, head );
  float uu = clamp( ( vMapUv.x - 0.5 ) / hw, -1.0, 1.0 ) * sign( dFdx( vMapUv.x ) + 1e-7 ); // -1..1 слева направо по экрану
  float t = uu * side;                                                                     // +1 = край, обращенный к солнцу
  float g = mix( uBodyGrad * uGradKB, min( uGrad * uGradK, 0.4 ), head );
  float dark = smoothstep( -0.15, 0.9, -t );                                                 // теневая сторона
  vec3 sideK = mix( vec3( 1.0 ), uSideTint, dark * clamp( g / max( min( uGrad * uGradK, 0.4 ), 1e-3 ), 0.0, 1.5 ) * 0.5 );
  float top = 1.0 + 0.05 * clamp( ( vMapUv.y - 0.69 ) / 0.11, -1.0, 1.0 ) * clamp( dot( sunV, upV ) * 2.0, 0.0, 1.0 ) * head;
  float lift = 1.0 + 0.04 * smoothstep( 0.0, 0.9, t );
  outgoingLight *= mix( uCharShade, 1.0, sunVis ) * ( 1.0 - g * dark ) * sideK * top * lift * uGain;
  #ifdef USE_MAP
  {
    // ВНУТРЕННИЙ теплый контровой блик (rim), только на закате: внешние ~2 px (при ширине 1080) силуэта кожи ГОЛОВЫ / ТОРСА
    // на обращенном к солнцу крае. Без смещенной копии: просто проверяем, выходят ли соседние пиксели со стороны солнца за пределы карточки.
    // Кивера, ноги, винтовки и прочие тонкие детали пропускаются (внутренняя проба должна быть кожей либо торсом толщиной не менее ~40 единиц).
    float warm = smoothstep( 0.2, 0.4, 1.0 - uCharTint.b );
    float sl = length( sunV.xy );
    vec2 d2 = sunV.xy / max( sl, 1e-4 );
    vec2 duv = 2.0 * uPx * ( d2.x * dFdx( vMapUv ) + d2.y * dFdy( vMapUv ) );
    float edge = step( texture2D( map, vMapUv + duv ).a, 0.5 );
    vec2 dirU = normalize( duv + vec2( 1e-9 ) );
    vec4 c1 = texture2D( map, vMapUv - dirU * vec2( 0.027, 0.016 ) );   // ~16 проектных единиц внутрь (глубже контурной линии)
    vec4 c2 = texture2D( map, vMapUv - dirU * vec2( 0.067, 0.04 ) );    // ~40 единиц внутрь: только массивные части
    float skin = step( 0.5, c1.a ) * step( 0.3, c1.r ) * step( c1.b + 0.12, c1.r ) * step( c1.g, c1.r + 0.02 );
    float torso = step( 0.27, vMapUv.y ) * step( vMapUv.y, 0.57 ) * step( 0.5, c1.a ) * step( 0.5, c2.a ) * step( 0.04, max( c1.r, max( c1.g, c1.b ) ) );
    float rim = warm * smoothstep( 0.1, 0.4, sl ) * edge * max( skin * head, torso ) * mix( 0.6, 1.0, sunVis );
    outgoingLight += vec3( 0.95, 0.52, 0.16 ) * rim;
  }
  #endif
}
#endif
`;

const DECL = "#include <common>\nuniform vec3 uCharTint; uniform float uCharShade; uniform float uGrad; uniform float uBodyGrad; uniform vec3 uSideTint;"
  + " uniform float uGradK; uniform float uGradKB; uniform float uTintK; uniform float uNorm; uniform float uGain; uniform float uPx;";
/** Константы карточек (не зависят от источника света): доля градиента, доля тонирования, общее усиление (откалибровано под светлоту лиц ~.93 V) */
export const CARD_K = { uGradK: { value: GRAD_K }, uGradKB: { value: GRAD_KB }, uTintK: { value: TINT_K }, uNorm: { value: 0.7 }, uGain: { value: 1.03 }, uPx: { value: 0.5 } }; // uPx = высота рендера / 1920 (выставляется перед отрисовкой в cast.ts)

/** Превращает MeshLambertMaterial в освещаемую карточку персонажа: без самосвечения, с тоном сцены, светлым порогом тени и боковым градиентом к солнцу. */
export function cardShade(m: THREE.MeshLambertMaterial) {
  m.emissive.set(0x000000); m.emissiveIntensity = 0; m.emissiveMap = null;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, CHAR, CARD_K);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", DECL)
      .replace("#include <lights_fragment_begin>", "float sunVis = 1.0;\n" + LFB)
      .replace("vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;", CARD);
  };
  m.customProgramCacheKey = () => "card9";
  return m;
}

/** Пятно контактной тени на земле: мультипликативно затемняет уже нарисованную поверхность; рисуется после земли и перед карточками персонажей */
export const blobMaterial = (map: THREE.Texture) => new THREE.MeshBasicMaterial({
  map, transparent: false, depthWrite: false, fog: false, toneMapped: false,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
});
