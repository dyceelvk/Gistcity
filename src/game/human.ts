/**
 * Realistic GIST characters, built from MakeHuman 1.2 bodies (CC0 1.0) baked by
 * tools/mh_export.py into public/characters/human_{f,m}.glb:
 *  - skinned body (hi + lo LOD) with body-type and face-shape morph targets,
 *  - eyes / brows / lashes, a set of hair meshes and MakeHuman shoes,
 *  - walk / run / idle clips on a 53-bone game rig,
 *  - clothing helper shells that tailor.ts cuts GIST outfits from at runtime.
 *
 * `Human` has the same surface as the procedural `Avatar` (root, appearance,
 * setAppearance, animate) so game code can use either.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { sanitizeAppearance, type Appearance, type HairStyle, type ShoeStyle } from './appearance';
import { analyzeShell, clothMaterial, tailorOutfit, type BodyInfo, type Shell } from './tailor';

export type Sex = 'f' | 'm';
export type Quality = 'hi' | 'lo';

interface MaterialInfo { kind: 'skin' | 'eye' | 'brow' | 'lash' | 'hair' | 'shoes' | 'cloth'; tex: string | null; tex_light?: string; mean?: { dark: number[]; light: number[] } }
interface ModelInfo {
  file: string; bytes: number; height_m: number; hair: string[]; shoes: string[]; morphs: string[];
  materials: Record<string, MaterialInfo>;
  landmarks: { base: Record<string, number[]>; variants: Record<string, Record<string, number[]>> };
  region_bounds: Record<string, { ymin: number; ymax: number; pmin: number; pmax: number }>;
  crotch_y: number;
}
interface Manifest { regions: string[]; models: Record<Sex, ModelInfo> }

export interface HumanModel {
  sex: Sex;
  info: ModelInfo;
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
  tights: Shell;
  skirt: Shell;
  scalp: Shell;
  body: BodyInfo;
  /** Triangles of the hi/lo body in the beard / lip zones (computed lazily). */
  faceZones: Map<string, { geo: THREE.BufferGeometry; alpha: Float32Array }>;
}
export interface HumanLibrary { manifest: Manifest; models: Record<Sex, HumanModel>; base: string }

let LIB: HumanLibrary | null = null;
export const humanLibrary = () => LIB;

/* ------------------------------------------------------------------ textures */

const texLoader = new THREE.TextureLoader();
const textures = new Map<string, THREE.Texture>();
const texReady = new Set<string>();
const texWaiters = new Map<string, (() => void)[]>();
const texMeans = new Map<string, THREE.Color>();

function texture(file: string, srgb = true): THREE.Texture {
  let t = textures.get(file);
  if (t) return t;
  const url = (LIB?.base ?? './characters/') + 'tex/' + file;
  t = texLoader.load(url, (loaded) => {
    texReady.add(file);
    texMeans.set(file, imageMean(loaded.image as HTMLImageElement));
    const ws = texWaiters.get(file); texWaiters.delete(file);
    ws?.forEach((w) => w());
  });
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.flipY = false;
  t.anisotropy = 4;
  textures.set(file, t);
  return t;
}
function whenTexture(file: string, cb: () => void) {
  if (texReady.has(file)) { cb(); return; }
  texture(file);
  const ws = texWaiters.get(file) ?? []; ws.push(cb); texWaiters.set(file, ws);
}
function preload(file: string) { return new Promise<void>((res) => whenTexture(file, res)); }

/** Average colour of an image (linear), used to tint textures towards a target colour. */
function imageMean(img: HTMLImageElement | ImageBitmap): THREE.Color {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, 16, 16);
    const d = ctx.getImageData(0, 0, 16, 16).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 40) continue; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    n = Math.max(1, n);
    return new THREE.Color().setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace);
  } catch { return new THREE.Color(0.5, 0.5, 0.5); }
}
function tintFor(target: string, mean: THREE.Color | undefined, lo = 0.25, hi = 3.0): THREE.Color {
  const t = new THREE.Color(target);
  if (!mean) return t;
  const f = (a: number, b: number) => THREE.MathUtils.clamp(a / Math.max(0.02, b), lo, hi);
  return new THREE.Color(f(t.r, mean.r), f(t.g, mean.g), f(t.b, mean.b));
}

/* ------------------------------------------------------------------ loading */

export async function loadHumanLibrary(progress?: (fraction: number) => void): Promise<HumanLibrary | null> {
  const base = `${import.meta.env.BASE_URL}characters/`;
  try {
    const manifest = (await (await fetch(base + 'manifest.json')).json()) as Manifest;
    const sexes: Sex[] = ['f', 'm'];
    const loader = new GLTFLoader();
    const got: Partial<Record<Sex, number>> = {};
    const total = sexes.reduce((s, x) => s + (manifest.models[x].bytes || 2.7e6), 0);
    const report = () => progress?.(Math.min(0.9, ((got.f ?? 0) + (got.m ?? 0)) / total));
    const gltfs = await Promise.all(sexes.map((s) => loader.loadAsync(base + manifest.models[s].file, (ev) => { got[s] = ev.loaded; report(); })));
    LIB = { manifest, models: {} as Record<Sex, HumanModel>, base };
    sexes.forEach((sex, i) => {
      const scene = gltfs[i].scene;
      const info = manifest.models[sex];
      const shells: Partial<Record<'tights' | 'skirt' | 'scalp', Shell>> = {};
      scene.traverse((o) => {
        const m = o as THREE.SkinnedMesh;
        if (!m.isMesh) return;
        m.castShadow = true; m.receiveShadow = false;
        if (m.name === 'tights' || m.name === 'skirt' || m.name === 'scalp') { shells[m.name] = analyzeShell(m.geometry, manifest.regions, m.name !== 'tights'); m.visible = false; }
      });
      LIB!.models[sex] = {
        sex, info, scene, clips: gltfs[i].animations,
        tights: shells.tights!, skirt: shells.skirt!, scalp: shells.scalp!,
        body: { regions: manifest.regions, bounds: info.region_bounds, crotchY: info.crotch_y },
        faceZones: new Map(),
      };
    });
    // textures everybody needs before the first frame
    const common: string[] = [];
    for (const sex of sexes) {
      const mats = manifest.models[sex].materials;
      for (const k of ['skin', 'eye', 'brow', 'lash']) { const mi = mats[k]; if (mi?.tex) common.push(mi.tex); if (mi?.tex_light) common.push(mi.tex_light); }
    }
    await Promise.all([...new Set(common)].map(preload));
    progress?.(1);
    return LIB;
  } catch (err) {
    console.warn('[gist] realistic characters unavailable, falling back to procedural avatars', err);
    LIB = null;
    return null;
  }
}

/* ------------------------------------------------------------------ mapping tables */

const HAIR_MESH: Record<Sex, Partial<Record<HairStyle, string>>> = {
  f: { lowcut: 'short04', fade: 'short02', waves: 'short01', afro: 'afro01', braids: 'braid01', bob: 'bob01', long: 'long01', ponytail: 'ponytail01', bun: 'ponytail01', locs: 'braid01' },
  m: { lowcut: 'short04', fade: 'short02', waves: 'short01', afro: 'afro01', braids: 'braid01', bob: 'short03', long: 'long01', ponytail: 'ponytail01', bun: 'short03', locs: 'braid01' },
};
/** Lighter meshes for crowds. */
const HAIR_LO: Partial<Record<string, string>> = { bob01: 'short02', long01: 'short02', ponytail01: 'short02' };
const SHOE_MESH: Record<ShoeStyle, string> = { sneaker: 'shoes05', runner: 'shoes06', formal: 'shoes03', loafer: 'shoes01', classic: 'shoes02' };
const BODY_MORPH: Record<string, string | null> = { slim: 'slim', athletic: 'athletic', curvy: 'curvy', regular: null };

const WALK_CYCLES_PER_S = 1 / 0.5833; // clip length
const WALK_STRIDE = 1.45, RUN_STRIDE = 2.6; // metres per cycle

/* ------------------------------------------------------------------ Human */

interface Rig {
  sex: Sex;
  model: HumanModel;
  scene: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: { idle: THREE.AnimationAction; walk: THREE.AnimationAction; run: THREE.AnimationAction };
  meshes: Map<string, THREE.SkinnedMesh>;
  bones: Map<string, THREE.Bone>;
  body: THREE.SkinnedMesh;
  skinMat: THREE.MeshStandardMaterial;
  hideMask: { value: number };
  dynamic: THREE.Object3D[]; // garments, accessories, decals — rebuilt on every setAppearance
  ownedMats: THREE.Material[]; // per-appearance materials on permanent meshes (hair, shoes)
}

export class Human {
  root = new THREE.Group();
  appearance: Appearance;
  readonly isHuman = true;
  quality: Quality;
  height = 1.7;
  private rig: Rig | null = null;
  private weights = { idle: 1, walk: 0, run: 0 };
  private pose: 'none' | 'sit' | 'sleep' = 'none';
  private poseW = 0;
  hipHeight = 0.86;
  private hairMesh: THREE.SkinnedMesh | null = null;
  private shoeMesh: THREE.SkinnedMesh | null = null;

  constructor(appearance: Appearance, opts: { quality?: Quality } = {}) {
    this.quality = opts.quality ?? 'hi';
    this.appearance = sanitizeAppearance(appearance);
    this.root.name = 'human';
    this.setAppearance(this.appearance);
  }

  get sex(): Sex { return this.appearance.build === 'feminine' ? 'f' : 'm'; }
  get model(): HumanModel { return LIB!.models[this.sex]; }

  setAppearance(a: Appearance) {
    this.appearance = sanitizeAppearance(a);
    const sex = this.sex;
    if (!this.rig || this.rig.sex !== sex) this.buildRig(sex);
    this.apply();
  }

  dispose() {
    if (!this.rig) return;
    this.clearDynamic();
    this.rig.mixer.stopAllAction();
    this.rig.mixer.uncacheRoot(this.rig.scene);
    this.root.remove(this.rig.scene);
    this.rig.skinMat.dispose();
    (this.rig.meshes.get('brows')?.material as THREE.Material | undefined)?.dispose();
    this.rig = null;
  }

  /** speedClass: 0 idle, 1 walk, 2 run; mps (optional) scales the stride to the actual ground speed. */
  animate(dt: number, speedClass: number, mps?: number) {
    const r = this.rig; if (!r) return;
    const target = speedClass <= 0.05 ? 'idle' : speedClass > 1.5 ? 'run' : 'walk';
    const k = Math.min(1, dt * 9);
    for (const name of ['idle', 'walk', 'run'] as const) {
      const w = this.weights[name] += ((name === target ? 1 : 0) - this.weights[name]) * k;
      r.actions[name].setEffectiveWeight(w < 0.002 ? 0 : w);
    }
    const walkMps = mps ?? 3.3, runMps = mps ?? 6.4;
    r.actions.walk.timeScale = THREE.MathUtils.clamp(walkMps / (WALK_STRIDE * WALK_CYCLES_PER_S), 0.35, 2.2);
    r.actions.run.timeScale = THREE.MathUtils.clamp(runMps / (RUN_STRIDE * WALK_CYCLES_PER_S), 0.5, 2.2);
    // undo last frame's pose offsets first: bones without animation tracks are
    // not rewritten by the mixer and would otherwise accumulate rotation.
    for (const [bone, q] of this.poseBackup) bone.quaternion.copy(q);
    this.poseBackup.clear();
    r.mixer.update(dt);
    const targetW = this.pose === 'sit' ? 1 : 0;
    this.poseW += (targetW - this.poseW) * Math.min(1, dt * 7);
    if (this.poseW > 0.002) this.applySit(this.poseW);
  }
  private poseBackup = new Map<THREE.Bone, THREE.Quaternion>();

  setPose(pose: 'none' | 'sit' | 'sleep') { this.pose = pose; }

  /**
   * Seated pose layered over the animation: thighs forward, shins down, a
   * relaxed spine and the arms resting on the lap. Rotations are expressed in
   * the character's own frame (+z forward) and applied in world space so they
   * are independent of each bone's local axes.
   */
  private static SIT: [string, number, number, number][] = [
    // bone, rotX (forward +), rotY, rotZ in degrees
    ['thigh_l', -88, 0, 6], ['thigh_r', -88, 0, -6],
    ['calf_l', 86, 0, 0], ['calf_r', 86, 0, 0],
    ['spine_01', 6, 0, 0], ['spine_02', 4, 0, 0],
    ['upperarm_l', -28, 0, 10], ['upperarm_r', -28, 0, -10],
    ['lowerarm_l', -36, 0, 0], ['lowerarm_r', -36, 0, 0],
  ];
  private tmpQ = new THREE.Quaternion(); private tmpQ2 = new THREE.Quaternion(); private tmpQ3 = new THREE.Quaternion(); private tmpE = new THREE.Euler();
  private applySit(w: number) {
    const r = this.rig!;
    const rootQ = this.root.getWorldQuaternion(this.tmpQ3);
    for (const [name, rx, ry, rz] of Human.SIT) {
      const bone = r.bones.get(name); if (!bone || !bone.parent) continue;
      bone.parent.updateWorldMatrix(true, false);
      const P = bone.parent.getWorldQuaternion(this.tmpQ2);
      // R_world = rootQ * R_char * rootQ^-1 ; L' = (P^-1 R_world P) * L
      const R = this.tmpQ.setFromEuler(this.tmpE.set(THREE.MathUtils.degToRad(rx), THREE.MathUtils.degToRad(ry), THREE.MathUtils.degToRad(rz), 'XYZ'));
      R.premultiply(rootQ).multiply(rootQ.clone().invert());
      const Pi = P.clone().invert();
      const local = Pi.multiply(R).multiply(P);
      if (w < 0.999) local.slerp(new THREE.Quaternion(), 1 - w);
      this.poseBackup.set(bone, bone.quaternion.clone());
      bone.quaternion.premultiply(local);
      bone.updateMatrixWorld(false);
    }
  }

  /* ---------------------------------------------------------------- rig */

  private buildRig(sex: Sex) {
    this.dispose();
    const model = LIB!.models[sex];
    const scene = cloneSkinned(model.scene) as THREE.Group;
    const meshes = new Map<string, THREE.SkinnedMesh>();
    const bones = new Map<string, THREE.Bone>();
    scene.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) { meshes.set(o.name, o as THREE.SkinnedMesh); o.visible = false; (o as THREE.Mesh).frustumCulled = true; }
      else if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone);
    });
    const body = (this.quality === 'lo' ? meshes.get('body_lo') : meshes.get('body')) ?? meshes.get('body')!;
    const hideMask = { value: 0 };
    const skinMat = new THREE.MeshStandardMaterial({ roughness: 0.56, metalness: 0 });
    skinMat.onBeforeCompile = (sh) => {
      sh.uniforms.uHideMask = hideMask;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float _region; varying float vRegion;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRegion = _region;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uHideMask; varying float vRegion;')
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (mod(floor(uHideMask / exp2(floor(vRegion + 0.5))), 2.0) > 0.5) discard;');
    };
    skinMat.customProgramCacheKey = () => 'gist-skin';
    body.material = skinMat; body.visible = true; body.castShadow = true;
    const mats = model.info.materials;
    const eyes = meshes.get('eyes'), brows = meshes.get('brows'), lashes = meshes.get('lashes');
    if (eyes) { eyes.material = sharedMaterial('eye', sex, () => new THREE.MeshStandardMaterial({ map: texture(mats.eye.tex!), roughness: 0.2, metalness: 0, transparent: true })); eyes.visible = true; eyes.castShadow = false; }
    if (brows) { brows.material = new THREE.MeshStandardMaterial({ map: texture(mats.brow.tex!), transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.8 }); brows.visible = true; brows.castShadow = false; brows.renderOrder = 2; }
    if (lashes) { lashes.material = sharedMaterial('lash', sex, () => new THREE.MeshStandardMaterial({ map: texture(mats.lash.tex!), transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.8 })); lashes.visible = this.quality === 'hi'; lashes.castShadow = false; lashes.renderOrder = 2; }

    const mixer = new THREE.AnimationMixer(scene);
    const clip = (n: string) => THREE.AnimationClip.findByName(model.clips, n);
    const mk = (n: string, w: number) => { const act = mixer.clipAction(clip(n)!); act.setEffectiveWeight(w); act.play(); return act; };
    const actions = { idle: mk('idle', 1), walk: mk('walk', 0), run: mk('run', 0) };
    actions.idle.time = Math.random() * 4;
    actions.walk.time = Math.random() * 0.58; actions.run.time = actions.walk.time;
    this.weights = { idle: 1, walk: 0, run: 0 };

    this.root.add(scene);
    this.height = model.info.height_m;
    this.rig = { sex, model, scene, mixer, actions, meshes, bones, body, skinMat, hideMask, dynamic: [], ownedMats: [] };
    // Seat height reference: the hip joint in the bind pose, minus the buttocks.
    scene.updateMatrixWorld(true);
    const thigh = bones.get('thigh_l');
    if (thigh) { const p = new THREE.Vector3(); thigh.getWorldPosition(p); scene.worldToLocal(p); this.hipHeight = p.y - 0.1; }
    else if (typeof model.info.crotch_y === 'number') this.hipHeight = model.info.crotch_y + 0.06;
  }

  private clearDynamic() {
    const r = this.rig; if (!r) return;
    for (const o of r.dynamic) {
      o.parent?.remove(o);
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        const mat = m.material as THREE.Material;
        if (!mat.userData.shared) mat.dispose();
        if (m.userData.ownGeometry) m.geometry.dispose();
      }
    }
    r.dynamic = [];
    for (const m of r.ownedMats) m.dispose();
    r.ownedMats = [];
  }

  /* ---------------------------------------------------------------- appearance */

  private apply() {
    const r = this.rig!; const a = this.appearance; const model = r.model; const mats = model.info.materials;
    this.clearDynamic();

    // --- morph targets (body type + face shape)
    const bodyMorph = BODY_MORPH[a.body ?? 'regular'] ?? null;
    const faceMorph = 'face_' + a.face;
    const setMorphs = (m: THREE.Mesh) => {
      const dict = m.morphTargetDictionary, inf = m.morphTargetInfluences;
      if (!dict || !inf) return;
      for (const k of Object.keys(dict)) inf[dict[k]] = k === bodyMorph || k === faceMorph ? 1 : 0;
    };
    r.meshes.forEach(setMorphs);

    // --- skin
    const skin = mats.skin;
    const meanDark = skin.mean ? new THREE.Color().setRGB(skin.mean.dark[0], skin.mean.dark[1], skin.mean.dark[2], THREE.SRGBColorSpace) : undefined;
    const meanLight = skin.mean ? new THREE.Color().setRGB(skin.mean.light[0], skin.mean.light[1], skin.mean.light[2], THREE.SRGBColorSpace) : undefined;
    const target = new THREE.Color(a.skin);
    const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const useLight = !!skin.tex_light && meanDark && meanLight && lum(target) > (lum(meanDark) + lum(meanLight)) / 2;
    r.skinMat.map = texture(useLight ? skin.tex_light! : skin.tex!);
    r.skinMat.color.copy(tintFor(a.skin, useLight ? meanLight : meanDark, 0.3, 2.2));
    r.skinMat.needsUpdate = true;

    // --- hair
    const wantsGele = a.hair === 'gele';
    const hasCap = a.accessories.includes('cap');
    let hairName = a.hair === 'bald' || wantsGele ? null : HAIR_MESH[r.sex][a.hair] ?? 'short04';
    if (hairName && this.quality === 'lo') hairName = HAIR_LO[hairName] ?? hairName;
    if (hairName && hasCap && hairName === 'afro01') hairName = 'short04'; // an afro will not fit under a cap
    if (hairName && !model.info.hair.includes(hairName)) hairName = model.info.hair[0];
    this.hairMesh = null;
    for (const h of model.info.hair) {
      const m = r.meshes.get('hair_' + h); if (!m) continue;
      m.visible = false;
      if (h === hairName) {
        const info = mats['hair_' + h];
        const mat = new THREE.MeshStandardMaterial({ map: texture(info.tex!), alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.72, metalness: 0 });
        m.material = mat; m.castShadow = true; this.hairMesh = m;
        whenTexture(info.tex!, () => { if (this.hairMesh === m) { mat.color.copy(tintFor(a.hairColor, texMeans.get(info.tex!), 0.3, 3.5)); m.visible = true; } });
        r.ownedMats.push(mat);
      }
    }
    const browMat = r.meshes.get('brows')?.material as THREE.MeshStandardMaterial | undefined;
    if (browMat) browMat.color.copy(tintFor(a.hairColor, undefined)).lerp(new THREE.Color('#000000'), 0.35);

    // --- shoes
    const shoeName = SHOE_MESH[a.shoes ?? 'sneaker'];
    this.shoeMesh = null;
    for (const s of model.info.shoes) {
      const m = r.meshes.get('shoes_' + s); if (!m) continue;
      m.visible = false;
      if (s === shoeName) {
        const info = mats['shoes_' + s];
        const mat = new THREE.MeshStandardMaterial({ map: texture(info.tex!), roughness: 0.65, metalness: 0 });
        m.material = mat; m.castShadow = true; this.shoeMesh = m;
        whenTexture(info.tex!, () => { if (this.shoeMesh === m) { mat.color.copy(tintFor(a.shoesColor, texMeans.get(info.tex!), 0.35, 2.5)); m.visible = true; } });
        r.ownedMats.push(mat);
      }
    }

    // --- clothes
    const outfit = tailorOutfit(a, model.tights, model.skirt, model.body, this.quality);
    for (const p of outfit.pieces) {
      const mesh = new THREE.SkinnedMesh(p.geo, clothMaterial(p, this.quality));
      mesh.name = 'garment_' + p.name;
      mesh.bind(r.body.skeleton, r.body.bindMatrix);
      mesh.castShadow = true; mesh.receiveShadow = false; mesh.frustumCulled = false;
      mesh.userData.ownGeometry = true;
      setMorphs(mesh);
      r.scene.add(mesh); r.dynamic.push(mesh);
    }
    let mask = 0;
    for (const name of outfit.hide) { const i = model.body.regions.indexOf(name); if (i >= 0) mask += 2 ** i; }
    r.hideMask.value = mask;

    // --- face details and accessories
    this.addFaceDetails();
    this.addAccessories();
  }

  /* ---------------------------------------------------------------- landmarks */

  private landmark(name: string): THREE.Vector3 {
    const lm = this.rig!.model.info.landmarks; const a = this.appearance;
    const base = lm.base[name] ?? [0, 0, 0];
    const v = new THREE.Vector3(base[0], base[1], base[2]);
    const add = (variant: string | null) => { if (!variant) return; const p = lm.variants[variant]?.[name]; if (p) v.add(new THREE.Vector3(p[0] - base[0], p[1] - base[1], p[2] - base[2])); };
    add(BODY_MORPH[a.body ?? 'regular']); add('face_' + a.face);
    return v;
  }

  /** Parent `obj` (positioned in bind space, metres, feet on y=0) to a bone so it animates with it. */
  private attach(obj: THREE.Object3D, boneName: string) {
    const r = this.rig!;
    const bone = r.bones.get(boneName);
    if (!bone) { r.scene.add(obj); r.dynamic.push(obj); return; }
    const bi = r.body.skeleton.bones.indexOf(bone);
    const bind = new THREE.Matrix4().copy(r.body.skeleton.boneInverses[bi]).invert(); // bone rest pose in mesh space
    obj.updateMatrix();
    obj.matrix.premultiply(new THREE.Matrix4().copy(bind).invert());
    obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
    bone.add(obj); r.dynamic.push(obj);
  }

  private addAccessories() {
    const a = this.appearance; const r = this.rig!;
    const gold = sharedMaterial('gold', 'x', () => new THREE.MeshStandardMaterial({ color: '#e2b84d', roughness: 0.28, metalness: 0.9 }));
    const headTop = this.landmark('head_top'), eyeL = this.landmark('eye_l'), eyeR = this.landmark('eye_r'), earL = this.landmark('ear_l'), earR = this.landmark('ear_r');
    const neck = this.landmark('neck'), chin = this.landmark('chin');
    const headW = earL.x - earR.x; // ear to ear

    if (a.hair === 'gele') {
      const geleM = new THREE.MeshStandardMaterial({ color: a.topColor, roughness: 0.5 });
      const gs: THREE.BufferGeometry[] = [];
      const base = headTop.y - 0.075, s = headW / 0.16;
      for (let i = 0; i < 4; i++) { const t = new THREE.TorusGeometry((0.1 + i * 0.012) * s, (0.03 + i * 0.004) * s, 10, 28); t.rotateX(Math.PI / 2); t.translate(0, base + i * 0.03, headTop.z - 0.01 - i * 0.008); gs.push(t); }
      const crown = new THREE.SphereGeometry(1, 20, 12); crown.scale(0.15 * s, 0.085 * s, 0.13 * s); crown.translate(0, base + 0.105, headTop.z - 0.03); gs.push(crown);
      const fan = new THREE.CylinderGeometry(0.17 * s, 0.12 * s, 0.03, 20, 1, false, 0, Math.PI); fan.rotateZ(-0.5); fan.translate(0.1 * s, base + 0.155, headTop.z - 0.02); gs.push(fan);
      const mesh = new THREE.Mesh(mergeGeometries(gs), geleM); mesh.castShadow = true; mesh.userData.ownGeometry = true;
      this.attach(mesh, 'head');
    }
    if (a.accessories.includes('cap') && a.hair !== 'gele') {
      const capM = new THREE.MeshStandardMaterial({ color: isDark(a.bottomColor) ? '#1b1b1b' : a.bottomColor, roughness: 0.85 });
      const hairName = this.hairMesh?.name.replace('hair_', '') ?? '';
      const lift = ['braid01', 'long01', 'ponytail01', 'bob01'].includes(hairName) ? 0.028 : hairName ? 0.012 : 0.004;
      const cy = eyeL.y + 0.04;                 // band sits on the forehead, just above the brows
      const rx = headW / 2 + 0.008 + lift, rz = (headTop.z - earL.z) + rx * 0.98 + lift; // ellipse: ears -> forehead
      const cz = (earL.z + eyeL.z) / 2 - 0.005;  // centre of the skull in z
      const gs: THREE.BufferGeometry[] = [];
      const crown = new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2); crown.scale(rx, headTop.y - cy + 0.012 + lift, rz); crown.translate(0, cy, cz); gs.push(crown);
      const band = new THREE.CylinderGeometry(1, 1.02, 0.03, 24, 1, true); band.scale(rx, 1, rz); band.translate(0, cy - 0.005, cz); gs.push(band);
      const brimR = rx * 0.95;
      const brim = new THREE.CylinderGeometry(brimR, brimR, 0.008, 20, 1, false, -Math.PI / 2, Math.PI); brim.scale(1.15, 1, 0.85); brim.translate(0, cy - 0.016, eyeL.z - 0.012); gs.push(brim);
      const mesh = new THREE.Mesh(mergeGeometries(gs), capM); mesh.castShadow = true; mesh.userData.ownGeometry = true;
      this.attach(mesh, 'head');
    }
    if (a.accessories.includes('glasses')) {
      const lensM = sharedMaterial('lens', 'x', () => new THREE.MeshStandardMaterial({ color: '#0d0d14', roughness: 0.08, metalness: 0.6, transparent: true, opacity: 0.72 }));
      const frameM = sharedMaterial('frame', 'x', () => new THREE.MeshStandardMaterial({ color: '#111111', roughness: 0.35, metalness: 0.3 }));
      const lenses: THREE.BufferGeometry[] = [], frame: THREE.BufferGeometry[] = [];
      const z = eyeL.z + 0.014, y = eyeL.y - 0.001;
      for (const e of [eyeL, eyeR]) {
        const l = new THREE.CylinderGeometry(0.02, 0.02, 0.003, 18); l.scale(1.3, 1, 0.85); l.rotateX(Math.PI / 2); l.translate(e.x * 1.05, y, z); lenses.push(l);
        const rim = new THREE.TorusGeometry(0.02, 0.0016, 6, 24); rim.scale(1.3, 0.85, 1); rim.translate(e.x * 1.05, y, z); frame.push(rim);
      }
      const bridge = new THREE.BoxGeometry(0.012, 0.004, 0.004); bridge.translate(0, y + 0.004, z); frame.push(bridge);
      for (const e of [earL, earR]) { const len = z - e.z + 0.012; const t = new THREE.BoxGeometry(0.004, 0.005, len); t.translate(Math.sign(e.x) * (Math.abs(e.x) + 0.003), y + 0.004, z - len / 2); frame.push(t); }
      const m1 = new THREE.Mesh(mergeGeometries(frame), frameM); m1.userData.ownGeometry = true; this.attach(m1, 'head');
      const m2 = new THREE.Mesh(mergeGeometries(lenses), lensM); m2.userData.ownGeometry = true; m2.renderOrder = 3; this.attach(m2, 'head');
    }
    if (a.accessories.includes('earrings')) {
      const gs: THREE.BufferGeometry[] = [];
      for (const e of [earL, earR]) { const ring = new THREE.TorusGeometry(0.016, 0.003, 8, 16); ring.translate(e.x * 1.0, e.y - 0.035, e.z - 0.002); gs.push(ring); }
      const mesh = new THREE.Mesh(mergeGeometries(gs), gold); mesh.userData.ownGeometry = true;
      this.attach(mesh, 'head');
    }
    if (a.accessories.includes('chain')) {
      // necklace draped over the top: behind the neck, over both shoulders, pendant on the chest
      const clothOff = 0.03;
      const yP = neck.y - 0.11, yS = neck.y - 0.02;
      const sx = this.sideX(yS - 0.03) * 0.55 + 0.02;
      const pts = [
        new THREE.Vector3(0, yS, this.backZ(yS) - 0.012),
        new THREE.Vector3(sx, yS - 0.01, neck.z),
        new THREE.Vector3(sx * 0.6, yP + 0.045, this.frontZ(yP + 0.045) + clothOff),
        new THREE.Vector3(0, yP, this.frontZ(yP) + clothOff),
        new THREE.Vector3(-sx * 0.6, yP + 0.045, this.frontZ(yP + 0.045) + clothOff),
        new THREE.Vector3(-sx, yS - 0.01, neck.z),
      ];
      const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
      const gs: THREE.BufferGeometry[] = [new THREE.TubeGeometry(curve, 48, 0.0045, 6, true)];
      const pend = new THREE.CylinderGeometry(0.016, 0.016, 0.004, 16); pend.rotateX(Math.PI / 2 - 0.1); pend.translate(0, yP - 0.02, this.frontZ(yP - 0.02) + clothOff); gs.push(pend);
      const mesh = new THREE.Mesh(mergeGeometries(gs), gold); mesh.userData.ownGeometry = true;
      this.attach(mesh, 'spine_03');
    }
    if (a.accessories.includes('watch')) {
      const wrist = this.landmark('wrist_l');
      const elbow = this.boneHead('lowerarm_l'), hand = this.boneHead('hand_l');
      const axis = hand.clone().sub(elbow).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
      const gs: THREE.BufferGeometry[] = [];
      const band = new THREE.TorusGeometry(0.03, 0.006, 8, 20); band.rotateX(Math.PI / 2); band.scale(0.8, 1, 1); gs.push(band);
      const face = new THREE.CylinderGeometry(0.016, 0.016, 0.007, 16); face.rotateX(Math.PI / 2); face.translate(0, 0, -0.03); gs.push(face);
      const g = mergeGeometries(gs); g.applyQuaternion(q); g.translate(wrist.x - axis.x * 0.03, wrist.y - axis.y * 0.03, wrist.z - axis.z * 0.03);
      const mesh = new THREE.Mesh(g, gold); mesh.userData.ownGeometry = true;
      this.attach(mesh, 'lowerarm_l');
    }
    if (a.accessories.includes('bag')) {
      const leather = sharedMaterial('leather', 'x', () => new THREE.MeshStandardMaterial({ color: '#5a3a2a', roughness: 0.55 }));
      const hip = this.landmark('hip_r'); const shoulder = this.landmark('shoulder_l');
      const clothOff = ['hoodie', 'blazer', 'native'].includes(a.top) ? 0.075 : 0.06;
      const hx = -(this.sideX(hip.y) + (a.bottom === 'skirt' ? 0.05 : 0.02) + 0.025);
      const bag = new THREE.BoxGeometry(0.05, 0.15, 0.13); bag.translate(hx, hip.y + 0.0, 0.02);
      const flap = new THREE.BoxGeometry(0.054, 0.06, 0.132); flap.translate(hx, hip.y + 0.05, 0.02);
      const b = new THREE.Mesh(mergeGeometries([bag, flap]), leather); b.castShadow = true; b.userData.ownGeometry = true;
      this.attach(b, 'pelvis');
      // cross-body strap lying on the clothes: over the left shoulder, diagonally across the chest to the
      // bag on the right hip, then back up across the back. Points follow the body's front/back depth.
      const shY = shoulder.y + 0.035, lowY = hip.y + 0.1, x0 = 0.075, x1 = hx + 0.03;
      const pts: THREE.Vector3[] = [new THREE.Vector3(x0, shY, 0.0)];
      const steps = 6;
      for (let k = 1; k <= steps; k++) { const f = k / steps, x = x0 + (x1 - x0) * f, y = shY - (shY - lowY) * f; pts.push(new THREE.Vector3(x, y, this.surfZ(x, y, 1) + clothOff)); }
      for (let k = steps - 1; k >= 1; k--) { const f = k / steps, x = x0 + (x1 - x0) * f, y = shY - (shY - lowY) * f; pts.push(new THREE.Vector3(x, y, this.surfZ(x, y, -1) - clothOff)); }
      const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
      const strap = new THREE.TubeGeometry(curve, 64, 0.01, 5, true);
      const s = new THREE.Mesh(strap, leather); s.userData.ownGeometry = true;
      this.attach(s, 'spine_02');
    }
    void chin;
    void r;
  }

  private boneHead(name: string): THREE.Vector3 {
    const r = this.rig!; const bone = r.bones.get(name)!;
    const bi = r.body.skeleton.bones.indexOf(bone);
    const m = new THREE.Matrix4().copy(r.body.skeleton.boneInverses[bi]).invert();
    return new THREE.Vector3().setFromMatrixPosition(m);
  }

  /** Front-most body z at height y (bind pose), scanning the body mesh. */
  private frontZ(y: number): number {
    const pos = this.rig!.body.geometry.getAttribute('position');
    let best = 0;
    for (let i = 0; i < pos.count; i++) { if (Math.abs(pos.getY(i) - y) < 0.012 && Math.abs(pos.getX(i)) < 0.03) best = Math.max(best, pos.getZ(i)); }
    return best;
  }
  private backZ(y: number): number {
    const pos = this.rig!.body.geometry.getAttribute('position');
    let best = 0;
    for (let i = 0; i < pos.count; i++) { if (Math.abs(pos.getY(i) - y) < 0.012 && Math.abs(pos.getX(i)) < 0.03) best = Math.min(best, pos.getZ(i)); }
    return best;
  }
  /** Body surface depth near (x, y): the front-most (dir > 0) or back-most (dir < 0) z of nearby vertices. */
  private surfZ(x: number, y: number, dir: 1 | -1): number {
    const pos = this.rig!.body.geometry.getAttribute('position');
    let best = 0, found = false;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getY(i) - y) > 0.015 || Math.abs(pos.getX(i) - x) > 0.02) continue;
      const z = pos.getZ(i);
      if (!found || z * dir > best * dir) { best = z; found = true; }
    }
    return best;
  }
  private sideX(y: number): number {
    const pos = this.rig!.body.geometry.getAttribute('position');
    let best = 0;
    for (let i = 0; i < pos.count; i++) { if (Math.abs(pos.getY(i) - y) < 0.012 && Math.abs(pos.getZ(i)) < 0.08) best = Math.max(best, Math.abs(pos.getX(i))); }
    return best;
  }

  /* ---------------------------------------------------------------- beard & lips (decal shells on the face) */

  private addFaceDetails() {
    const a = this.appearance; const r = this.rig!;
    const wantBeard = a.beard !== 'none' && a.build !== 'feminine';
    const wantLips = !!a.lips;
    if (!wantBeard && !wantLips) return;
    const mouth = this.landmark('mouth'), chin = this.landmark('chin'), earL = this.landmark('ear_l'), eye = this.landmark('eye_l'), nose = this.landmark('nose');
    const geo = r.body.geometry;
    const pos = geo.getAttribute('position'); const regAttr = geo.getAttribute('_region');
    const headRegion = r.model.body.regions.indexOf('head');
    const n = pos.count;
    const mk = (name: string, weight: (x: number, y: number, z: number) => number, mat: THREE.Material, offset: number) => {
      const key = `${r.body.name}|${name}|${a.face}`;
      let zone = r.model.faceZones.get(key);
      if (!zone) {
        const alpha = new Float32Array(n);
        for (let i = 0; i < n; i++) { if (regAttr && regAttr.getX(i) !== headRegion) continue; alpha[i] = weight(pos.getX(i), pos.getY(i), pos.getZ(i)); }
        const idx = geo.getIndex()!; const out: number[] = [];
        for (let t = 0; t < idx.count; t += 3) { const i0 = idx.getX(t), i1 = idx.getX(t + 1), i2 = idx.getX(t + 2); if (alpha[i0] > 0.01 || alpha[i1] > 0.01 || alpha[i2] > 0.01) out.push(i0, i1, i2); }
        if (!out.length) return;
        const g = new THREE.BufferGeometry();
        for (const an of Object.keys(geo.attributes)) g.setAttribute(an, geo.attributes[an]);
        g.setAttribute('_alpha', new THREE.BufferAttribute(alpha, 1));
        g.morphAttributes = geo.morphAttributes; g.morphTargetsRelative = geo.morphTargetsRelative;
        g.setIndex(new THREE.BufferAttribute(n > 65535 ? new Uint32Array(out) : new Uint16Array(out), 1));
        g.boundingSphere = geo.boundingSphere;
        zone = { geo: g, alpha }; r.model.faceZones.set(key, zone);
      }
      const m = mat as THREE.MeshStandardMaterial;
      m.transparent = true; m.depthWrite = false;
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uOff = { value: offset };
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float _alpha; varying float vAlpha; uniform float uOff;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = _alpha;')
          .replace('#include <skinning_vertex>', 'transformed += normal * uOff;\n#include <skinning_vertex>');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
          .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= vAlpha;');
      };
      m.customProgramCacheKey = () => 'gist-decal';
      const mesh = new THREE.SkinnedMesh(zone.geo, m);
      mesh.bind(r.body.skeleton, r.body.bindMatrix);
      mesh.frustumCulled = false; mesh.castShadow = false; mesh.renderOrder = 1;
      const dict = r.body.morphTargetDictionary, inf = r.body.morphTargetInfluences;
      if (dict && inf && mesh.morphTargetInfluences) for (const k of Object.keys(dict)) mesh.morphTargetInfluences[dict[k]] = inf[dict[k]];
      r.scene.add(mesh); r.dynamic.push(mesh);
    };
    const sm = (a0: number, b0: number, x: number) => { const t = THREE.MathUtils.clamp((x - a0) / (b0 - a0), 0, 1); return t * t * (3 - 2 * t); };
    if (wantBeard) {
      const full = a.beard === 'full';
      const earX = Math.abs(earL.x), earZ = earL.z;
      const under = chin.y - 0.035;                       // how far the beard goes under the chin
      const tacheTop = nose.y - 0.006;                    // moustache stops under the nose
      const weight = (x: number, y: number, z: number) => {
        if (z < earZ - 0.012) return 0;                   // nothing behind the ears
        const ax = Math.abs(x);
        // lips stay clear
        const lipZone = (1 - sm(0.007, 0.012, Math.abs(y - mouth.y))) * (1 - sm(0.024, 0.032, ax));
        let w: number;
        if (full) {
          // cheek line rises from the mouth corners towards the sideburns
          const cheekTop = mouth.y + 0.004 + sm(0.03, earX, ax) * 0.06;
          const jaw = sm(under, under + 0.02, y) * (1 - sm(cheekTop - 0.006, cheekTop + 0.006, y));
          const tache = (1 - sm(0.028, 0.04, ax)) * sm(mouth.y + 0.004, mouth.y + 0.01, y) * (1 - sm(tacheTop - 0.005, tacheTop + 0.003, y));
          w = Math.max(jaw, tache) * (0.78 + 0.22 * sm(0.0, 0.05, z - earZ));
        } else {
          const goat = sm(under, under + 0.02, y) * (1 - sm(mouth.y - 0.004, mouth.y + 0.004, y)) * (1 - sm(0.026, 0.036, ax));
          const tache = (1 - sm(0.026, 0.036, ax)) * sm(mouth.y + 0.004, mouth.y + 0.01, y) * (1 - sm(tacheTop - 0.005, tacheTop + 0.003, y));
          w = Math.max(goat, tache);
        }
        w *= 1 - lipZone;
        return THREE.MathUtils.clamp(w, 0, 1) * 0.88;
      };
      const col = new THREE.Color(a.hairColor).multiplyScalar(0.5);
      mk(a.beard, weight, new THREE.MeshStandardMaterial({ color: col, roughness: 0.95, metalness: 0 }), 0.0018);
    }
    if (wantLips) {
      const weight = (x: number, y: number, z: number) => {
        if (z < mouth.z - 0.03) return 0;
        const dy = Math.abs(y - mouth.y) / 0.0095, dx = Math.abs(x) / 0.024;
        const d = Math.sqrt(dx * dx + dy * dy);
        return (1 - sm(0.8, 1.05, d)) * 0.78;
      };
      mk('lips', weight, new THREE.MeshStandardMaterial({ color: a.lips!, roughness: 0.32, metalness: 0 }), 0.0008);
    }
    void eye;
  }
}

/* ------------------------------------------------------------------ shared material cache */

const sharedMats = new Map<string, THREE.Material>();
function sharedMaterial<T extends THREE.Material>(kind: string, sex: string, make: () => T): T {
  const key = kind + '|' + sex;
  let m = sharedMats.get(key) as T | undefined;
  if (!m) { m = make(); m.userData.shared = true; sharedMats.set(key, m); }
  return m;
}
const isDark = (hex: string) => { const c = new THREE.Color(hex); return c.r * 0.3 + c.g * 0.59 + c.b * 0.11 < 0.35; };
