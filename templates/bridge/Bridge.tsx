// «Мост, который рухнул из-за песни»: наш оригинальный 67-секундный ролик в стиле плоских 2D-персонажей внутри мультяшного 3D-мира.
// Единый мир Three.js (world.ts), выставляемый покадрово по сюжетному таймлайну (story.ts). Цепочка постобработки (проход сведения стиля):
//   InkPass (контурная обводка мира отдельным проходом) -> размытие объектива pre + main (тонколинейный DOF по планам из dofAt) ->
//   [свечение bloom (только эмиссивные источники) + тональная компрессия NEUTRAL + цветокоррекция grade] (единый объединенный EffectPass), MSAA 4.
// Обводка выполняется до размытия резкости, чтобы линии размывались вместе со своими объектами; свечение (bloom) идет после DOF, чтобы
// ореолы расфокусировались вместе с источниками; цветокоррекция работает в пространстве дисплея, поэтому ставится после тональной компрессии.
// Все пиксельные параметры заданы для разрешения 1080x1920 и масштабируются пропорционально выходному кадру, обеспечивая полное совпадение
// превью-кадров при --scale 0.5 и финального рендера 1440x2560.
// Смена локаций сглаживается кроссфейдом через наложение второго холста на кадрах перехода; хук завершается 4-кадровой белой вспышкой.
import React, { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { AbsoluteFill, continueRender, delayRender, getInputProps, useCurrentFrame } from "remotion";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { EffectComposer } from "@react-three/postprocessing";
import { BlendFunction, BloomEffect, ToneMappingEffect, ToneMappingMode } from "postprocessing";
import { World, loadKit } from "./world";
import { InkPass, noInkFallback } from "./ink";
import { LensBlur, GrainEffect } from "./lensblur";
import { GradeEffect, GRADES, GRADE_STRENGTH, gradeFor } from "./grade";
import { Kit } from "./build";
import { TOTAL, FLASH_AT, SHOTS, layersAt, dofAt } from "./story";

export const BRIDGE_FRAMES = TOTAL;

/** Переключатели A/B только для тестовых стоп-кадров (через Remotion inputProps `{ post: { ink: false, ... } }`); по умолчанию все включено. */
type PostToggles = { ink: boolean; lens: boolean; pre: boolean; bloom: boolean; grade: boolean; grain: boolean };
const toggles = (): PostToggles => ({ ink: true, lens: true, pre: true, bloom: true, grade: true, grain: false, ...((getInputProps() as { post?: Partial<PostToggles> }).post ?? {}) });

/** Свечение (Bloom) только для ярких эмиссивных источников (depth.md 6.4). Его MIP-пирамида всегда стартует с 540x960 (половина от 1080x1920)
 *  независимо от выходного разрешения, поэтому размер ореола относительно кадра остается неизменным (спад в e раз ~30 px при 1080p,
 *  ~1.5 % высоты кадра) при ширине 540, 1080 и 1440. Режим смешивания ADD: безопасен для HDR (SCREEN затемняет значения > 1). */
const makeBloom = () => {
  const b = new BloomEffect({ blendFunction: BlendFunction.ADD, intensity: 0.5, luminanceThreshold: 1.0, luminanceSmoothing: 0.2, mipmapBlur: true, levels: 6, radius: 0.6 });
  const mip = b.mipmapBlurPass;
  const setSize = mip.setSize.bind(mip);
  mip.setSize = (w: number, h: number) => setSize(Math.round((1920 * w) / Math.max(h, 1)), 1920);
  return b;
};

const fwd = new THREE.Vector3(), fpt = new THREE.Vector3();

const useKit = () => {
  const [kit, setKit] = useState<Kit | null>(null);
  const [handle] = useState(() => delayRender("bridge kit"));
  useEffect(() => { loadKit().then((k) => { setKit(k); continueRender(handle); }); }, [handle]);
  return kit;
};

const Inner: React.FC<{ id: number; kit: Kit }> = ({ id, kit }) => {
  const f = useCurrentFrame();
  const { camera, scene } = useThree();
  const world = useMemo(() => new World(kit), [kit]);
  const target = useMemo(() => new THREE.Vector3(), []);
  const on = useMemo(toggles, []);
  const fx = useMemo(() => ({
    ink: new InkPass(scene, camera as THREE.PerspectiveCamera),
    lens: new LensBlur({ maxCoC: 24, nearScale: 1.2 }),
    bloom: makeBloom(),
    tone: new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL }),
    grade: new GradeEffect(GRADES.day, GRADE_STRENGTH.day),
    grain: new GrainEffect({ amount: 0.025, cellPx: 1.5 }), // пленочное зерно, ВЫКЛЮЧЕНО по умолчанию (inputProps post.grain): в референсе зерна нет, а размер файла растет вчетверо
  }), [camera, scene]);
  useEffect(() => () => fx.ink.dispose(), [fx]);
  const post = useMemo(() => (
    <EffectComposer multisampling={4}>
      {on.ink ? <primitive object={fx.ink} dispose={null} /> : null}
      {on.lens && on.pre ? <primitive object={fx.lens.pre} dispose={null} /> : null}
      {on.lens ? <primitive object={fx.lens.main} dispose={null} /> : null}
      {on.bloom ? <primitive object={fx.bloom} dispose={null} /> : null}
      <primitive object={fx.tone} dispose={null} />
      {on.grade ? <primitive object={fx.grade} dispose={null} /> : null}
      {on.grain ? <primitive object={fx.grain} dispose={null} /> : null}
    </EffectComposer>
  ), [fx, on]);
  const cam = camera as THREE.PerspectiveCamera;
  target.copy(world.update(id, f, cam, scene));
  noInkFallback(world.root);
  // Фокусировка тонкой линзы: дистанция вдоль оси взгляда до точки фокуса плана (по умолчанию — целевая точка взгляда камеры)
  const d = dofAt(f);
  cam.getWorldDirection(fwd);
  if (d.focus) fpt.set(...d.focus(f)); else fpt.copy(target);
  fx.lens.focus = Math.max(0.3, fpt.sub(cam.position).dot(fwd));
  fx.lens.cInf = d.cInf;
  gradeFor(fx.grade, SHOTS[id - 1].light);
  fx.grain.seed = f; // детерминированное зерно для каждого кадра
  return (
    <>
      <primitive object={world.root} dispose={null} />
      {post}
    </>
  );
};

/** Только для тестовых стоп-кадров: inputProps `{ post: { dpr: 0.5 } }` принудительно задает размер буфера WebGL (по умолчанию R3F ограничивает dpr >= 1) */
const dprOverride = () => (getInputProps() as { post?: { dpr?: number } }).post?.dpr;
const ShotView: React.FC<{ id: number; kit: Kit; alpha: number }> = ({ id, kit, alpha }) => (
  <AbsoluteFill style={{ opacity: alpha }}>
    <ThreeCanvas width={1080} height={1920} {...(dprOverride() ? { dpr: dprOverride() } : {})} shadows gl={{ antialias: false, stencil: false, powerPreference: "high-performance", toneMappingExposure: 1.0 }}
      camera={{ fov: 40, near: 0.2, far: 1500 }}>
      <Inner id={id} kit={kit} />
    </ThreeCanvas>
  </AbsoluteFill>
);

export const BridgeShort: React.FC = () => {
  const f = useCurrentFrame();
  const kit = useKit();
  if (!kit) return null;
  const flash = f >= FLASH_AT && f < FLASH_AT + 4 ? [1, 0.75, 0.45, 0.2][f - FLASH_AT] : 0;
  return (
    <AbsoluteFill style={{ background: "#cfe3f2" }}>
      {layersAt(f).map((l, i) => <ShotView key={i ? "over" : "base"} id={l.id} kit={kit} alpha={l.alpha} />)}
      {flash > 0 && <AbsoluteFill style={{ background: "#ffffff", opacity: flash }} />}
    </AbsoluteFill>
  );
};
