/**
 * Procedural, skinned human avatar.
 *
 * The body is ONE SkinnedMesh lofted from elliptical cross-sections along a
 * 17-bone skeleton, so the waist, shoulders, elbows and knees bend smoothly
 * instead of being separate capsules. Clothes are the same loft with offset
 * radii and their own material ranges (no z-fighting, no gaps). The head is a
 * sculpted lathe with a painted face texture (eyes, brows, nose, lips, makeup);
 * hair, beard and accessories are meshes parented to bones.
 *
 * Everything is driven by `Appearance`, so a saved look renders identically
 * for the player, NPCs and remote players. Swapping in rigged GLTF characters
 * later only replaces this file.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Appearance, BodyType, FaceShape } from './appearance';

/* ------------------------------------------------------------------ materials */

const matCache = new Map<string, THREE.MeshStandardMaterial>();
export function mat(color: string, roughness = 0.8, metalness = 0): THREE.MeshStandardMaterial {
  const key = `${color}|${roughness}|${metalness}`;
  let m = matCache.get(key);
  if (!m) { m = new THREE.MeshStandardMaterial({ color, roughness, metalness }); matCache.set(key, m); }
  return m;
}
const shade = (hex: string, f: number) => '#' + new THREE.Color(hex).multiplyScalar(f).getHexString();
const mix = (a: string, b: string, t: number) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString();
const isDark = (hex: string) => { const c = new THREE.Color(hex); return c.r * 0.3 + c.g * 0.59 + c.b * 0.11 < 0.35; };
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/* ------------------------------------------------------------------ skeleton */

const BONES = ['hips', 'spine', 'chest', 'neck', 'head',
  'armL', 'forearmL', 'handL', 'armR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'] as const;
type BoneName = typeof BONES[number];
const B: Record<BoneName, number> = Object.fromEntries(BONES.map((n, i) => [n, i])) as Record<BoneName, number>;

/** Body-shape multipliers: shoulders, chest, waist, hips, limb thickness. */
const BUILD: Record<BodyType, { sh: number; ch: number; wa: number; hp: number; limb: number; bust: number }> = {
  slim: { sh: 0.94, ch: 0.92, wa: 0.86, hp: 0.92, limb: 0.9, bust: 1 },
  regular: { sh: 1, ch: 1, wa: 1, hp: 1, limb: 1, bust: 1 },
  athletic: { sh: 1.1, ch: 1.08, wa: 0.93, hp: 0.98, limb: 1.08, bust: 1 },
  curvy: { sh: 0.94, ch: 1.02, wa: 0.84, hp: 1.15, limb: 1.03, bust: 1.18 },
};

interface Joints {
  hips: THREE.Vector3; spine: THREE.Vector3; chest: THREE.Vector3; neck: THREE.Vector3; head: THREE.Vector3;
  shoulder: (s: 1 | -1) => THREE.Vector3; elbow: (s: 1 | -1) => THREE.Vector3; wrist: (s: 1 | -1) => THREE.Vector3; handTip: (s: 1 | -1) => THREE.Vector3;
  hip: (s: 1 | -1) => THREE.Vector3; knee: (s: 1 | -1) => THREE.Vector3; ankle: (s: 1 | -1) => THREE.Vector3;
}
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
function joints(bt: BodyType): Joints {
  const { sh, hp } = BUILD[bt];
  return {
    hips: V(0, 0.98, 0), spine: V(0, 1.08, 0), chest: V(0, 1.24, 0), neck: V(0, 1.47, 0), head: V(0, 1.53, 0),
    shoulder: (s) => V(s * 0.185 * sh, 1.405, 0),
    elbow: (s) => V(s * 0.23 * sh, 1.13, 0.012),
    wrist: (s) => V(s * 0.26 * sh, 0.89, 0.035),
    handTip: (s) => V(s * 0.275 * sh, 0.725, 0.05),
    hip: (s) => V(s * 0.095 * hp, 0.94, 0),
    knee: (s) => V(s * 0.1 * hp, 0.5, 0),
    ankle: (s) => V(s * 0.1 * hp, 0.09, 0),
  };
}

function buildBones(J: Joints): THREE.Bone[] {
  const list: THREE.Bone[] = new Array(BONES.length);
  const make = (name: BoneName, world: THREE.Vector3, parent?: THREE.Bone, parentWorld?: THREE.Vector3) => {
    const b = new THREE.Bone(); b.name = name;
    b.position.copy(parentWorld ? world.clone().sub(parentWorld) : world);
    parent?.add(b); list[B[name]] = b; return b;
  };
  const hips = make('hips', J.hips);
  const spine = make('spine', J.spine, hips, J.hips);
  const chest = make('chest', J.chest, spine, J.spine);
  const neck = make('neck', J.neck, chest, J.chest);
  make('head', J.head, neck, J.neck);
  for (const s of [1, -1] as const) {
    const L = s === 1 ? 'L' : 'R';
    const arm = make(`arm${L}` as BoneName, J.shoulder(s), chest, J.chest);
    const fore = make(`forearm${L}` as BoneName, J.elbow(s), arm, J.shoulder(s));
    make(`hand${L}` as BoneName, J.wrist(s), fore, J.elbow(s));
    const thigh = make(`thigh${L}` as BoneName, J.hip(s), hips, J.hips);
    const shin = make(`shin${L}` as BoneName, J.knee(s), thigh, J.hip(s));
    make(`foot${L}` as BoneName, J.ankle(s), shin, J.knee(s));
  }
  return list;
}

/* ------------------------------------------------------------------ loft builder */

type Weights = [number, number][];
interface Ring {
  c: THREE.Vector3; rx: number; rz: number; w: Weights; m: number;
  /** Per-vertex weight override (angle a: 0 = front, ±π = back). */
  wfn?: (a: number) => Weights;
  /** Optional per-vertex radial scale (angle-dependent shaping). */
  shape?: (a: number) => { x: number; z: number; dz?: number };
}

class Loft {
  pos: number[] = []; uv: number[] = []; idx: number[] = []; si: number[] = []; sw: number[] = [];
  groups: { start: number; count: number; m: number }[] = [];
  private n = 0;

  /** Lofts a tube through `rings` (centres in bind-pose world space). */
  tube(rings: Ring[], segs: number, dir?: THREE.Vector3, hint = V(0, 0, 1)) {
    const first = this.n;
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      const d = dir ?? (i < rings.length - 1 ? rings[i + 1].c.clone().sub(r.c) : r.c.clone().sub(rings[i - 1].c)).normalize();
      const u = new THREE.Vector3().crossVectors(d, hint).normalize();
      const v = new THREE.Vector3().crossVectors(u, d).normalize();
      for (let j = 0; j <= segs; j++) {
        const a = Math.PI * 2 * (j / segs - 0.5);
        const sh = r.shape?.(a) ?? { x: 1, z: 1, dz: 0 };
        const p = r.c.clone().addScaledVector(u, r.rx * sh.x * Math.sin(a)).addScaledVector(v, r.rz * sh.z * Math.cos(a) + (sh.dz ?? 0));
        this.pos.push(p.x, p.y, p.z);
        this.uv.push(j / segs, i / (rings.length - 1));
        const w = r.wfn ? r.wfn(a) : r.w;
        this.weights(w);
        this.n++;
      }
    }
    for (let i = 0; i < rings.length - 1; i++) {
      const start = this.idx.length;
      for (let j = 0; j < segs; j++) {
        const A = first + i * (segs + 1) + j, Bv = A + 1, C = A + segs + 2, D = A + segs + 1;
        this.idx.push(A, Bv, C, A, C, D);
      }
      this.group(start, this.idx.length - start, rings[i + 1].m);
    }
  }

  private weights(w: Weights) {
    const sum = w.reduce((t, x) => t + x[1], 0) || 1;
    for (let k = 0; k < 4; k++) { const e = w[k]; this.si.push(e ? e[0] : 0); this.sw.push(e ? e[1] / sum : 0); }
  }
  private group(start: number, count: number, m: number) {
    const last = this.groups[this.groups.length - 1];
    if (last && last.m === m && last.start + last.count === start) last.count += count;
    else this.groups.push({ start, count, m });
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    for (const gr of this.groups) g.addGroup(gr.start, gr.count, gr.m);
    g.computeVertexNormals();
    return g;
  }
}

/** Generic parametric surface (rows × segs grid), used for head, hair and beard. */
function surface(rows: number, segs: number, fn: (i: number, j: number) => THREE.Vector3, closedSeam = true): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= rows; i++) for (let j = 0; j <= segs; j++) {
    const p = fn(i / rows, j / segs); pos.push(p.x, p.y, p.z); uv.push(j / segs, i / rows);
  }
  for (let i = 0; i < rows; i++) for (let j = 0; j < segs; j++) {
    const A = i * (segs + 1) + j, Bv = A + 1, C = A + segs + 2, D = A + segs + 1;
    idx.push(A, Bv, C, A, C, D);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (closedSeam) { // average normals across the seam so it does not show
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i <= rows; i++) {
      const a = i * (segs + 1), b = a + segs;
      const nx = (nrm.getX(a) + nrm.getX(b)) / 2, ny = (nrm.getY(a) + nrm.getY(b)) / 2, nz = (nrm.getZ(a) + nrm.getZ(b)) / 2;
      nrm.setXYZ(a, nx, ny, nz); nrm.setXYZ(b, nx, ny, nz);
    }
    nrm.needsUpdate = true;
  }
  return g;
}

/* ------------------------------------------------------------------ head shape */

const HEAD_H = 0.25;
/** [height, half-width, half-depth] control rings of the head, chin → crown. */
const HEAD_PROFILE: [number, number, number][] = [
  [0.000, 0.034, 0.040], [0.015, 0.062, 0.072], [0.045, 0.084, 0.094], [0.085, 0.097, 0.107],
  [0.135, 0.104, 0.113], [0.175, 0.102, 0.111], [0.210, 0.091, 0.101], [0.235, 0.066, 0.074], [0.250, 0.004, 0.004],
];
function headRadii(h: number, face: FaceShape) {
  let rx = 0, rz = 0;
  for (let i = 0; i < HEAD_PROFILE.length - 1; i++) {
    const [h0, x0, z0] = HEAD_PROFILE[i], [h1, x1, z1] = HEAD_PROFILE[i + 1];
    if (h >= h0 && h <= h1) { const t = (h - h0) / (h1 - h0); rx = x0 + (x1 - x0) * t; rz = z0 + (z1 - z0) * t; break; }
  }
  if (h > HEAD_H) { rx = 0.004; rz = 0.004; }
  if (face === 'round') { const f = 1 + 0.07 * (1 - h / HEAD_H); rx *= f; rz *= 1 + 0.03 * (1 - h / HEAD_H); }
  if (face === 'square' && h < 0.1) { const f = 1 + 0.1 * (1 - h / 0.1); rx *= f; }
  const cz = 0.012 * Math.max(0, 1 - h / 0.1); // chin sits slightly forward
  return { rx, rz, cz };
}
/** Point on the head surface (head-bone space). a: 0 = front, ±π = back. `t` = outward offset. */
function headPoint(h: number, a: number, face: FaceShape, t = 0) {
  const { rx, rz, cz } = headRadii(Math.min(HEAD_H, Math.max(0, h)), face);
  const ca = Math.cos(a), flat = 0.98 - 0.08 * ca; // flatter face, rounder back
  return V((rx + t) * Math.sin(a), h, cz + (rz + t) * ca * flat);
}
/** Hairline height around the head (a: 0 = front). */
function hairline(a: number, lift = 0) {
  const t = Math.abs(a) / Math.PI;
  const h = t < 0.3 ? 0.205 - (t / 0.3) * 0.045 : t < 0.6 ? 0.16 - ((t - 0.3) / 0.3) * 0.045 : 0.115 - ((t - 0.6) / 0.4) * 0.075;
  return h + lift;
}

/* ------------------------------------------------------------------ face texture */

const faceCache = new Map<string, THREE.CanvasTexture>();
const faceMatCache = new Map<string, THREE.MeshStandardMaterial>();
function faceMaterial(a: Appearance) {
  const tex = faceTexture(a);
  let m = faceMatCache.get(tex.uuid);
  if (!m) { m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }); faceMatCache.set(tex.uuid, m); }
  return m;
}
function faceTexture(a: Appearance): THREE.CanvasTexture {
  const key = `${a.skin}|${a.hairColor}|${a.lips ?? '-'}|${a.face}`;
  const hit = faceCache.get(key); if (hit) return hit;
  const S = 512, cv = document.createElement('canvas'); cv.width = S; cv.height = S;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = a.skin; ctx.fillRect(0, 0, S, S);
  // subtle warmth on cheeks / shadow under the jaw
  const Y = (h: number) => (1 - h / HEAD_H) * S;
  const X = (dx: number, h: number) => (0.5 + dx / (2 * Math.PI * headRadii(h, a.face).rx)) * S;
  const ell = (cx: number, h: number, rx: number, ry: number, fill: string, alpha = 1) => {
    const sx = S / (2 * Math.PI * headRadii(h, a.face).rx), sy = S / HEAD_H;
    ctx.globalAlpha = alpha; ctx.fillStyle = fill; ctx.beginPath(); ctx.ellipse(X(cx, h), Y(h), rx * sx, ry * sy, 0, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
  };
  const grad = ctx.createLinearGradient(0, Y(0.06), 0, Y(0));
  grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = grad; ctx.fillRect(0, Y(0.06), S, S - Y(0.06));
  ell(-0.045, 0.1, 0.03, 0.02, '#ff8a70', 0.08); ell(0.045, 0.1, 0.03, 0.02, '#ff8a70', 0.08);

  // eyes
  const eyeH = 0.146, eyeDX = 0.04, makeup = !!a.lips;
  for (const s of [-1, 1]) {
    const cx = s * eyeDX;
    ell(cx, eyeH - 0.004, 0.02, 0.012, 'rgba(0,0,0,0.18)'); // socket shadow
    ell(cx, eyeH, 0.016, 0.0078, '#f3efe9');                 // sclera
    ell(cx + s * 0.001, eyeH, 0.0072, 0.0072, '#3a2416');     // iris
    ell(cx + s * 0.001, eyeH, 0.0036, 0.0036, '#0d0906');     // pupil
    ell(cx + s * 0.001 - 0.0025, eyeH + 0.0025, 0.0016, 0.0016, '#ffffff', 0.9);
    // lids
    ctx.strokeStyle = makeup ? '#12090a' : 'rgba(20,10,8,0.75)'; ctx.lineWidth = makeup ? 4.5 : 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.ellipse(X(cx, eyeH), Y(eyeH), 0.016 * S / (2 * Math.PI * headRadii(eyeH, a.face).rx), 0.0078 * S / HEAD_H, 0, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
    ctx.strokeStyle = 'rgba(20,10,8,0.3)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(X(cx, eyeH), Y(eyeH), 0.016 * S / (2 * Math.PI * headRadii(eyeH, a.face).rx), 0.0078 * S / HEAD_H, 0, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke();
    if (makeup) { // lashes + liner flick
      ctx.strokeStyle = '#12090a'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(X(cx + s * 0.016, eyeH + 0.004), Y(eyeH + 0.004)); ctx.lineTo(X(cx + s * 0.025, eyeH + 0.009), Y(eyeH + 0.009)); ctx.stroke();
    }
  }
  // brows
  ctx.strokeStyle = mix(a.hairColor, '#000000', 0.2); ctx.lineWidth = makeup ? 6 : 8; ctx.lineCap = 'round';
  for (const s of [-1, 1]) {
    const h0 = 0.172, h1 = 0.183, h2 = 0.176;
    ctx.beginPath(); ctx.moveTo(X(s * 0.018, h0), Y(h0)); ctx.quadraticCurveTo(X(s * 0.04, h1 + 0.004), Y(h1 + 0.004), X(s * 0.064, h2), Y(h2)); ctx.stroke();
  }
  // nose: soft shadow + nostrils (the bridge itself is a mesh)
  ell(0, 0.1, 0.016, 0.006, 'rgba(0,0,0,0.16)');
  ell(-0.0105, 0.1, 0.004, 0.0028, 'rgba(0,0,0,0.42)'); ell(0.0105, 0.1, 0.004, 0.0028, 'rgba(0,0,0,0.42)');
  // lips
  const lipCol = a.lips ?? mix(shade(a.skin, 0.72), '#9a4a46', 0.35);
  const mh = 0.066;
  ctx.fillStyle = lipCol;
  ctx.beginPath();
  ctx.moveTo(X(-0.03, mh), Y(mh));
  ctx.quadraticCurveTo(X(-0.016, mh + 0.009), Y(mh + 0.009), X(-0.006, mh + 0.0075), Y(mh + 0.0075));
  ctx.lineTo(X(0, mh + 0.0055), Y(mh + 0.0055));
  ctx.lineTo(X(0.006, mh + 0.0075), Y(mh + 0.0075));
  ctx.quadraticCurveTo(X(0.016, mh + 0.009), Y(mh + 0.009), X(0.03, mh), Y(mh));
  ctx.closePath(); ctx.fill();
  ell(0, mh - 0.0085, 0.027, 0.0095, lipCol);
  if (makeup) ell(0, mh - 0.01, 0.012, 0.003, '#ffffff', 0.25);
  ctx.strokeStyle = 'rgba(30,10,10,0.7)'; ctx.lineWidth = 2.2;
  ctx.beginPath(); ctx.moveTo(X(-0.029, mh), Y(mh)); ctx.quadraticCurveTo(X(0, mh - 0.0015), Y(mh - 0.0015), X(0.029, mh), Y(mh)); ctx.stroke();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  faceCache.set(key, tex);
  return tex;
}

/* ------------------------------------------------------------------ avatar */

export class Avatar {
  readonly root = new THREE.Group();
  appearance!: Appearance;
  bones!: THREE.Bone[];
  private mesh?: THREE.SkinnedMesh;
  private phase = 0;
  private idleT = Math.random() * 10;
  private hipsY = 0.98;

  constructor(appearance: Appearance) { this.setAppearance(appearance); }

  setAppearance(a: Appearance) {
    this.appearance = a;
    if (this.mesh) {
      this.mesh.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); });
      this.root.remove(this.mesh);
    }
    while (this.root.children.length) this.root.remove(this.root.children[0]);
    const built = buildHuman(a);
    this.mesh = built.mesh; this.bones = built.bones; this.hipsY = built.hipsY;
    this.root.add(built.mesh);
    const blob = new THREE.Mesh(new THREE.CircleGeometry(0.36, 20), new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.16, depthWrite: false }));
    blob.rotation.x = -Math.PI / 2; blob.position.y = 0.012; this.root.add(blob);
  }

  /** @param speed 0 = idle, 1 = walking, 2 = running. @param mps ground speed scales the stride so the feet don't skate. */
  animate(dt: number, speed: number, mps?: number) {
    const bn = this.bones, b = (n: BoneName) => bn[B[n]];
    this.idleT += dt;
    const moving = speed > 0.05, run = speed > 1.5;
    if (moving) {
      const groundMps = mps && mps > 0.2 ? mps : (run ? 6.2 : 3.1);
      const stride = run ? 2.15 : 1.45; // metres per full leg cycle
      const cyclesPerSec = THREE.MathUtils.clamp(groundMps / stride, 1.05, 2.9);
      this.phase += dt * cyclesPerSec * Math.PI * 2;
    }
    const ph = this.phase, s = Math.sin(ph), c = Math.cos(ph), t = this.idleT;
    const k = Math.min(1, dt * 12);
    const L = THREE.MathUtils.lerp;
    const rot = (n: BoneName, x: number, y = 0, z = 0) => { const o = b(n); o.rotation.x = L(o.rotation.x, x, k); o.rotation.y = L(o.rotation.y, y, k); o.rotation.z = L(o.rotation.z, z, k); };

    if (moving) {
      const A = run ? 0.85 : 0.55, K = run ? 1.5 : 0.95, Aa = run ? 0.95 : 0.45, lean = run ? 0.2 : 0.05;
      const kneeL = K * Math.max(0, -c) + 0.1, kneeR = K * Math.max(0, c) + 0.1;
      rot('thighL', A * s, 0, 0.02); rot('thighR', -A * s, 0, -0.02);
      rot('shinL', kneeL); rot('shinR', kneeR);
      rot('footL', -(A * s + kneeL) * 0.45 + 0.15); rot('footR', -(-A * s + kneeR) * 0.45 + 0.15);
      rot('hips', 0, 0.1 * s, 0.035 * s);
      rot('spine', lean * 0.5, -0.05 * s, -0.02 * s);
      rot('chest', lean * 0.5, -0.12 * s, -0.015 * s);
      rot('neck', -lean * 0.4); rot('head', -lean * 0.5, 0.03 * s);
      rot('armL', -Aa * s, 0, run ? 0.2 : 0.07); rot('armR', Aa * s, 0, run ? -0.2 : -0.07);
      rot('forearmL', run ? -(1.15 + 0.2 * Math.max(0, -s)) : -(0.3 + 0.35 * Math.max(0, -s)));
      rot('forearmR', run ? -(1.15 + 0.2 * Math.max(0, s)) : -(0.3 + 0.35 * Math.max(0, s)));
      rot('handL', -0.15, 0, 0.1); rot('handR', -0.15, 0, -0.1);
      const bob = (run ? 0.05 : 0.025) * Math.abs(c) - (run ? 0.02 : 0.01);
      const h = b('hips'); h.position.y = L(h.position.y, this.hipsY + bob, k); h.position.x = L(h.position.x, 0.012 * c, k);
    } else {
      const br = Math.sin(t * 1.5);
      rot('thighL', 0, 0, 0.015); rot('thighR', 0, 0, -0.015); rot('shinL', 0.04); rot('shinR', 0.04); rot('footL', 0); rot('footR', 0);
      rot('hips', 0, 0, 0.012 * Math.sin(t * 0.6));
      rot('spine', 0.01 * br, 0, -0.012 * Math.sin(t * 0.6)); rot('chest', 0.02 * br, 0.02 * Math.sin(t * 0.37));
      const look = 0.22 * Math.sin(t * 0.5) * Math.sin(t * 0.13);
      rot('neck', 0, look * 0.4); rot('head', 0.02 * Math.sin(t * 0.9), look, 0.03 * Math.sin(t * 0.41));
      rot('armL', 0.02 * br, 0, 0.07 + 0.01 * br); rot('armR', 0.02 * br, 0, -(0.07 + 0.01 * br));
      rot('forearmL', -0.12 - 0.02 * br); rot('forearmR', -0.12 - 0.02 * br);
      rot('handL', -0.12, 0, 0.08); rot('handR', -0.12, 0, -0.08);
      const h = b('hips'); h.position.y = L(h.position.y, this.hipsY + 0.003 * br, k); h.position.x = L(h.position.x, 0, k);
    }
  }
}

/* ------------------------------------------------------------------ builder */

function buildHuman(a: Appearance) {
  const bt: BodyType = a.body ?? 'regular';
  const bd = BUILD[bt];
  const J = joints(bt);
  const bones = buildBones(J);
  const bone = (n: BoneName) => bones[B[n]];

  // materials -------------------------------------------------------------
  const skinM = mat(a.skin, 0.62);
  const topM = mat(a.topColor, a.top === 'blazer' ? 0.72 : a.top === 'native' ? 0.8 : 0.92);
  const bottomM = mat(a.bottomColor, a.bottom === 'skirt' ? 0.8 : 0.92);
  const shoeM = mat(a.shoesColor, 0.5);
  const soleM = mat(isDark(a.shoesColor) ? '#efe9df' : '#1c1c1c', 0.7);
  const hairM = mat(a.hairColor, 0.78);
  const cuffM = mat(shade(a.bottomColor, 0.72), 0.92);
  const MATS = [skinM, topM, bottomM, shoeM, cuffM];
  const SKIN = 0, TOP = 1, BOT = 2, SHOE = 3, CUFF = 4;

  const loft = new Loft();
  const W = (...w: Weights) => w;

  // torso -------------------------------------------------------------------
  const topHem = ({ tee: 1.0, shirt: 0.98, hoodie: 0.965, blazer: 0.9, native: 0.94, crop: 1.17 } as Record<string, number>)[a.top];
  const CL = 0.013; // cloth thickness
  const torsoRing = (y: number, rx: number, rz: number, w: Weights, m: number, off = 0, bust = 1): Ring => ({
    c: V(0, y, 0), rx: rx + off, rz: rz + off, w, m,
    shape: bust !== 1 ? (ang) => ({ x: 1, z: 1 + (bust - 1) * Math.max(0, Math.cos(ang)) ** 2 }) : undefined,
  });
  const hipsW = W([B.hips, 1]), waistW = W([B.hips, 0.4], [B.spine, 0.6]), lowChestW = W([B.spine, 0.5], [B.chest, 0.5]), chestW = W([B.chest, 1]), neckW = W([B.neck, 1]);
  const torsoProfile: { y: number; rx: number; rz: number; w: Weights; bust?: number }[] = [
    { y: 0.86, rx: 0.12 * bd.hp, rz: 0.095, w: hipsW },
    { y: 0.94, rx: 0.165 * bd.hp, rz: 0.118, w: hipsW },
    { y: 1.0, rx: 0.155 * (bd.hp + bd.wa) / 2, rz: 0.11, w: hipsW },
    { y: 1.08, rx: 0.135 * bd.wa, rz: 0.1, w: waistW },
    { y: 1.17, rx: 0.15 * (bd.wa + bd.ch) / 2, rz: 0.108, w: lowChestW },
    { y: 1.24, rx: 0.165 * bd.ch, rz: 0.118, w: lowChestW },
    { y: 1.31, rx: 0.175 * bd.ch, rz: 0.125, w: chestW, bust: bd.bust },
    { y: 1.37, rx: 0.172 * bd.sh, rz: 0.115, w: chestW },
    { y: 1.405, rx: 0.16 * bd.sh, rz: 0.1, w: chestW },
    { y: 1.435, rx: 0.125 * bd.sh, rz: 0.088, w: chestW },
    { y: 1.46, rx: 0.09, rz: 0.078, w: W([B.chest, 0.6], [B.neck, 0.4]) },
    { y: 1.48, rx: 0.065, rz: 0.066, w: W([B.chest, 0.3], [B.neck, 0.7]) },
    { y: 1.5, rx: 0.056, rz: 0.058, w: neckW },
    { y: 1.56, rx: 0.052, rz: 0.056, w: W([B.neck, 0.4], [B.head, 0.6]) },
  ];
  const torsoRings: Ring[] = [];
  const topFrom = topHem, topTo = 1.46; // cloth covers [topFrom, topTo]
  const bottomTo = a.bottom === 'skirt' ? 1.0 : 1.0; // waistband height
  const rprev = { rx: 0, rz: 0 };
  const interp = (y: number) => {
    for (let i = 0; i < torsoProfile.length - 1; i++) {
      const p = torsoProfile[i], q = torsoProfile[i + 1];
      if (y >= p.y && y <= q.y) { const t = (y - p.y) / (q.y - p.y); return { rx: p.rx + (q.rx - p.rx) * t, rz: p.rz + (q.rz - p.rz) * t, w: t < 0.5 ? p.w : q.w, bust: 1 + ((p.bust ?? 1) - 1) * (1 - t) + ((q.bust ?? 1) - 1) * t }; }
    }
    return { rx: 0.05, rz: 0.05, w: neckW, bust: 1 };
  };
  const matAt = (y: number) => (y > topFrom && y <= topTo ? TOP : y <= bottomTo && y > 0.0 ? BOT : SKIN);
  const keyYs = [...torsoProfile.map((p) => p.y), topFrom, bottomTo].filter((y, i, arr) => arr.indexOf(y) === i).sort((p, q) => p - q);
  for (const y of keyYs) {
    const r = interp(y);
    const isHem = y === topFrom || y === bottomTo;
    if (isHem) {
      // double ring: material below, then material above with a slightly larger radius so the top overlaps the bottom
      const below = matAt(y - 0.001), above = matAt(y + 0.001);
      torsoRings.push(torsoRing(y, r.rx, r.rz, r.w, below, below === SKIN ? 0 : CL * 0.8, r.bust));
      torsoRings.push(torsoRing(y, r.rx, r.rz, r.w, above, above === SKIN ? 0 : CL * 1.3, r.bust));
    } else {
      const m = matAt(y);
      torsoRings.push(torsoRing(y, r.rx, r.rz, r.w, m, m === SKIN ? 0 : CL, r.bust));
    }
    rprev.rx = r.rx; rprev.rz = r.rz;
  }
  // crotch cap + neck top
  torsoRings.unshift(torsoRing(0.84, 0.03, 0.03, hipsW, BOT));
  loft.tube(torsoRings, 20, V(0, 1, 0));

  // arms ----------------------------------------------------------------------
  const longSleeve = a.top === 'shirt' || a.top === 'blazer' || a.top === 'hoodie' || a.top === 'native';
  const sleeveEnd = a.top === 'crop' ? 0.3 : a.top === 'tee' ? 0.5 : 1.0; // fraction of the upper arm (1 = to the wrist)
  for (const s of [1, -1] as const) {
    const Ls = s === 1 ? 'L' : 'R';
    const arm = B[`arm${Ls}` as BoneName], fore = B[`forearm${Ls}` as BoneName], hand = B[`hand${Ls}` as BoneName];
    const S0 = J.shoulder(s), E = J.elbow(s), Wr = J.wrist(s), T = J.handTip(s);
    const lerpV = (p: THREE.Vector3, q: THREE.Vector3, t: number) => p.clone().lerp(q, t);
    const lb = bd.limb;
    const ring = (c: THREE.Vector3, rx: number, rz: number, w: Weights, m: number, off = 0): Ring => ({ c, rx: rx * lb + off, rz: rz * lb + off, w, m });
    const rings: Ring[] = [];
    const clothU = (t: number) => (t <= sleeveEnd ? TOP : SKIN); // upper arm
    const clothF = longSleeve ? TOP : SKIN;
    const push = (t: number, rx: number, rz: number, w: Weights, segment: 'u' | 'f') => {
      const c = segment === 'u' ? lerpV(S0, E, t) : lerpV(E, Wr, t);
      const m = segment === 'u' ? clothU(t) : clothF;
      rings.push(ring(c, rx, rz, w, m, m === TOP ? CL : 0));
    };
    // deltoid starts inside the torso
    rings.push(ring(lerpV(S0, E, -0.14).add(V(-s * 0.03, 0, 0)), 0.03, 0.03, W([B.chest, 0.8], [arm, 0.2]), clothU(0), clothU(0) === TOP ? CL : 0));
    rings.push(ring(lerpV(S0, E, -0.06).add(V(-s * 0.012, 0, 0)), 0.056, 0.054, W([B.chest, 0.55], [arm, 0.45]), clothU(0), clothU(0) === TOP ? CL : 0));
    push(0.04, 0.06, 0.058, W([B.chest, 0.3], [arm, 0.7]), 'u');
    push(0.18, 0.06, 0.058, W([arm, 1]), 'u');
    push(0.45, 0.054, 0.052, W([arm, 1]), 'u');
    if (sleeveEnd < 1 && sleeveEnd > 0.2) { // sleeve hem
      const t = sleeveEnd;
      rings.push(ring(lerpV(S0, E, t), 0.052, 0.05, W([arm, 1]), TOP, CL * 1.4));
      rings.push(ring(lerpV(S0, E, t + 0.001), 0.052, 0.05, W([arm, 1]), SKIN));
    }
    push(0.8, 0.047, 0.046, W([arm, 0.8], [fore, 0.2]), 'u');
    push(1.0, 0.044, 0.044, W([arm, 0.5], [fore, 0.5]), 'u');
    push(0.18, 0.047, 0.046, W([arm, 0.15], [fore, 0.85]), 'f');
    push(0.5, 0.041, 0.04, W([fore, 1]), 'f');
    push(0.85, 0.034, 0.032, W([fore, 1]), 'f');
    if (longSleeve) { // cuff
      rings.push(ring(lerpV(E, Wr, 0.97), 0.033, 0.03, W([fore, 1]), TOP, CL * 1.3));
      rings.push(ring(lerpV(E, Wr, 0.975), 0.033, 0.03, W([fore, 1]), SKIN));
    }
    push(1.0, 0.03, 0.028, W([fore, 0.5], [hand, 0.5]), 'f');
    // hand (palm faces the thigh: thin sideways, wide front-to-back)
    rings.push(ring(lerpV(Wr, T, 0.22), 0.02, 0.044, W([hand, 1]), SKIN));
    rings.push(ring(lerpV(Wr, T, 0.55), 0.019, 0.047, W([hand, 1]), SKIN));
    rings.push(ring(lerpV(Wr, T, 0.82), 0.016, 0.04, W([hand, 1]), SKIN));
    rings.push(ring(lerpV(Wr, T, 0.96), 0.011, 0.026, W([hand, 1]), SKIN));
    rings.push(ring(lerpV(Wr, T, 1.02), 0.003, 0.006, W([hand, 1]), SKIN));
    loft.tube(rings, 12);
  }

  // legs & bottoms ---------------------------------------------------------------
  const legCloth = a.bottom === 'trousers' || a.bottom === 'joggers' ? 'long' : a.bottom === 'shorts' ? 'short' : 'none';
  for (const s of [1, -1] as const) {
    const Ls = s === 1 ? 'L' : 'R';
    const thigh = B[`thigh${Ls}` as BoneName], shin = B[`shin${Ls}` as BoneName], foot = B[`foot${Ls}` as BoneName];
    const H = J.hip(s), K = J.knee(s), An = J.ankle(s);
    const lb = bd.limb, th = bt === 'curvy' ? 1.1 : 1;
    const ring = (c: THREE.Vector3, rx: number, rz: number, w: Weights, m: number, off = 0): Ring => ({ c, rx: rx * lb + off, rz: rz * lb + off, w, m });
    const rings: Ring[] = [];
    const mAt = (y: number) => (legCloth === 'long' ? (y > 0.12 ? BOT : SKIN) : legCloth === 'short' ? (y > 0.62 ? BOT : SKIN) : SKIN);
    const at = (y: number) => (y >= K.y ? H.clone().lerp(K, (H.y - y) / (H.y - K.y)) : K.clone().lerp(An, (K.y - y) / (K.y - An.y)));
    const push = (y: number, rx: number, rz: number, w: Weights, forceM?: number, off?: number) => {
      const m = forceM ?? mAt(y);
      rings.push(ring(at(y), rx, rz, w, m, off ?? (m === SKIN ? 0 : CL)));
    };
    push(0.95, 0.085 * th, 0.092 * th, W([B.hips, 0.45], [thigh, 0.55]));
    push(0.82, 0.082 * th, 0.088 * th, W([thigh, 1]));
    if (legCloth === 'short') { push(0.62, 0.068, 0.072, W([thigh, 1]), BOT, CL * 1.5); push(0.619, 0.068, 0.072, W([thigh, 1]), SKIN, 0); }
    push(0.6, 0.066, 0.07, W([thigh, 0.9], [shin, 0.1]));
    push(0.53, 0.058, 0.062, W([thigh, 0.7], [shin, 0.3]));
    push(0.5, 0.055, 0.06, W([thigh, 0.5], [shin, 0.5]));
    push(0.46, 0.054, 0.06, W([thigh, 0.25], [shin, 0.75]));
    push(0.37, 0.058, 0.066, W([shin, 1]));
    push(0.24, 0.046, 0.05, W([shin, 1]));
    if (a.bottom === 'joggers') { push(0.17, 0.038, 0.042, W([shin, 1]), BOT, CL * 1.2); push(0.165, 0.036, 0.04, W([shin, 1]), CUFF, CL * 0.6); push(0.12, 0.036, 0.04, W([shin, 0.8], [foot, 0.2]), CUFF, CL * 0.6); push(0.119, 0.036, 0.04, W([shin, 0.8], [foot, 0.2]), SKIN, 0); }
    else if (legCloth === 'long') { push(0.12, 0.04, 0.044, W([shin, 0.8], [foot, 0.2]), BOT, CL * 1.6); push(0.119, 0.036, 0.04, W([shin, 0.8], [foot, 0.2]), SKIN, 0); }
    else push(0.12, 0.036, 0.04, W([shin, 0.8], [foot, 0.2]));
    push(0.09, 0.034, 0.038, W([shin, 0.4], [foot, 0.6]));
    push(0.05, 0.03, 0.034, W([foot, 1]));
    loft.tube(rings, 12);

    // shoe: lofted along +z from heel to toe
    const sx = An.x;
    const shoeRings: Ring[] = [
      { c: V(sx, 0.05, -0.075), rx: 0.002, rz: 0.002, w: W([foot, 1]), m: SHOE },
      { c: V(sx, 0.05, -0.07), rx: 0.045, rz: 0.042, w: W([foot, 1]), m: SHOE },
      { c: V(sx, 0.052, -0.02), rx: 0.052, rz: 0.05, w: W([foot, 1]), m: SHOE },
      { c: V(sx, 0.045, 0.05), rx: 0.054, rz: 0.044, w: W([foot, 1]), m: SHOE },
      { c: V(sx, 0.036, 0.11), rx: 0.05, rz: 0.034, w: W([foot, 1]), m: SHOE },
      { c: V(sx, 0.028, 0.15), rx: 0.036, rz: 0.024, w: W([foot, 1]), m: SHOE },
      { c: V(sx, 0.024, 0.165), rx: 0.002, rz: 0.002, w: W([foot, 1]), m: SHOE },
    ];
    loft.tube(shoeRings, 12, V(0, 0, 1), V(0, 1, 0));
    const sole: Ring[] = [
      { c: V(sx, 0.012, -0.078), rx: 0.002, rz: 0.002, w: W([foot, 1]), m: SOLE_IDX },
      { c: V(sx, 0.012, -0.072), rx: 0.048, rz: 0.012, w: W([foot, 1]), m: SOLE_IDX },
      { c: V(sx, 0.012, 0.05), rx: 0.056, rz: 0.012, w: W([foot, 1]), m: SOLE_IDX },
      { c: V(sx, 0.012, 0.15), rx: 0.04, rz: 0.01, w: W([foot, 1]), m: SOLE_IDX },
      { c: V(sx, 0.012, 0.17), rx: 0.002, rz: 0.002, w: W([foot, 1]), m: SOLE_IDX },
    ];
    loft.tube(sole, 10, V(0, 0, 1), V(0, 1, 0));
  }
  MATS.push(soleM); // SOLE_IDX === 5

  // skirt / kaftan: a flared loft around both legs, swinging with whichever leg is nearer
  const splitW = (hipsShare: number) => (ang: number): Weights => {
    const left = Math.sin(ang) > 0; // +x side
    const thigh = left ? B.thighL : B.thighR;
    const blend = Math.min(1, Math.abs(Math.sin(ang)) * 1.4);
    return [[B.hips, hipsShare + (1 - hipsShare) * (1 - blend)], [thigh, (1 - hipsShare) * blend]];
  };
  if (a.bottom === 'skirt') {
    const rings: Ring[] = [
      { c: V(0, 1.02, 0), rx: 0.15 * (bd.hp + bd.wa) / 2 + CL * 0.6, rz: 0.108 + CL * 0.6, w: hipsW, m: BOT },
      { c: V(0, 0.94, 0), rx: 0.17 * bd.hp + CL, rz: 0.125 + CL, w: hipsW, m: BOT },
      { c: V(0, 0.82, 0), rx: 0.175 * bd.hp + CL, rz: 0.135 + CL, w: hipsW, m: BOT, wfn: splitW(0.7) },
      { c: V(0, 0.66, 0), rx: 0.17 * bd.hp + CL, rz: 0.135 + CL, w: hipsW, m: BOT, wfn: splitW(0.45) },
      { c: V(0, 0.52, 0), rx: 0.165 * bd.hp + CL, rz: 0.13 + CL, w: hipsW, m: BOT, wfn: splitW(0.3) },
      { c: V(0, 0.515, 0), rx: 0.03, rz: 0.03, w: hipsW, m: BOT, wfn: splitW(0.3) },
    ];
    loft.tube(rings, 20, V(0, -1, 0));
  }
  if (a.top === 'native') {
    const rings: Ring[] = [
      { c: V(0, 0.96, 0), rx: 0.165 * bd.hp + CL * 1.6, rz: 0.12 + CL * 1.6, w: hipsW, m: TOP },
      { c: V(0, 0.84, 0), rx: 0.17 * bd.hp + CL * 1.6, rz: 0.13 + CL * 1.6, w: hipsW, m: TOP, wfn: splitW(0.7) },
      { c: V(0, 0.7, 0), rx: 0.175 * bd.hp + CL * 1.6, rz: 0.14 + CL * 1.6, w: hipsW, m: TOP, wfn: splitW(0.45) },
      { c: V(0, 0.695, 0), rx: 0.03, rz: 0.03, w: hipsW, m: TOP, wfn: splitW(0.45) },
    ];
    loft.tube(rings, 20, V(0, -1, 0));
  }

  // assemble the skinned body --------------------------------------------------------
  const geo = loft.build();
  const mesh = new THREE.SkinnedMesh(geo, MATS);
  mesh.castShadow = true; mesh.frustumCulled = false;
  mesh.add(bone('hips'));
  mesh.bind(new THREE.Skeleton(bones));

  // head ------------------------------------------------------------------------------
  const head = bone('head');
  const faceM = faceMaterial(a);
  const headGeo = surface(22, 28, (v, u) => headPoint(v * HEAD_H, (u - 0.5) * Math.PI * 2, a.face));
  const headMesh = new THREE.Mesh(headGeo, faceM); headMesh.castShadow = true; headMesh.position.y = -0.008; head.add(headMesh);
  const headSkin = mat(a.skin, 0.62);
  // nose, ears
  const noseParts: THREE.BufferGeometry[] = [];
  const nz = headPoint(0.11, 0, a.face).z;
  const tip = new THREE.SphereGeometry(1, 10, 8); tip.scale(0.02, 0.017, 0.019); tip.translate(0, 0.107, nz + 0.003); noseParts.push(tip);
  const bridge = new THREE.SphereGeometry(1, 8, 8); bridge.scale(0.009, 0.024, 0.01); bridge.translate(0, 0.127, headPoint(0.127, 0, a.face).z - 0.0045); noseParts.push(bridge);
  for (const s of [-1, 1]) {
    const e = new THREE.SphereGeometry(1, 8, 8); e.scale(0.011, 0.028, 0.02);
    const ep = headPoint(0.135, s * Math.PI / 2, a.face); e.translate(ep.x, 0.13, ep.z - 0.012); noseParts.push(e);
  }
  const noseEars = new THREE.Mesh(mergeGeometries(noseParts), headSkin); noseEars.position.y = -0.008; head.add(noseEars);

  // beard
  if (a.beard !== 'none') {
    const beardTop = (ang: number) => {
      const t = Math.abs(ang) / Math.PI;
      if (a.beard === 'goatee') return t < 0.13 ? 0.05 : 0.0;
      return t < 0.3 ? 0.05 : 0.05 + Math.min(1, (t - 0.3) / 0.2) * 0.09;
    };
    const beardOK = (ang: number) => (a.beard === 'goatee' ? Math.abs(ang) / Math.PI < 0.13 : Math.abs(ang) / Math.PI < 0.56);
    const bg = surface(6, 36, (v, u) => {
      let ang = (u - 0.5) * Math.PI * 2;
      if (a.beard === 'goatee') ang *= 0.55 + 0.45 * v; // taper toward the chin
      if (!beardOK(ang)) return headPoint(0.02, ang, a.face, -0.02); // tucked inside the head
      const top = beardTop(ang);
      return headPoint(0.004 + v * (top - 0.004), ang, a.face, 0.011 + 0.004 * (1 - v));
    }, false);
    const bm = new THREE.Mesh(bg, hairM); bm.position.y = -0.008; head.add(bm);
    if (a.beard === 'full') {
      const mg = surface(3, 12, (v, u) => headPoint(0.077 + v * 0.016, (u - 0.5) * 0.52, a.face, 0.009), false);
      const mm = new THREE.Mesh(mg, hairM); mm.position.y = -0.008; head.add(mm);
    }
  }

  // hair ------------------------------------------------------------------------------
  const capSurface = (thick: (h: number, ang: number) => number, lift = 0, rows = 10) =>
    surface(rows, 32, (v, u) => {
      const ang = (u - 0.5) * Math.PI * 2;
      const h0 = hairline(ang, lift), h = h0 + v * (HEAD_H + 0.004 - h0);
      return headPoint(Math.min(HEAD_H, h), ang, a.face, thick(h, ang));
    });
  const hairMesh = (g: THREE.BufferGeometry, m: THREE.Material = hairM) => { const mm = new THREE.Mesh(g, m); mm.castShadow = true; mm.position.y = -0.008; head.add(mm); return mm; };
  const strands = (count: number, radius: number, length: number, wobble: number, startLift = 0) => {
    const gs: THREE.BufferGeometry[] = [];
    let seed = 7;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let i = 0; i < count; i++) {
      const ang = Math.PI * (0.22 + (i / (count - 1)) * 1.56) * (i % 2 ? 1 : -1); // around the back and sides, not the face
      const h0 = hairline(ang, startLift) + 0.02 + rnd() * 0.03;
      const p0 = headPoint(h0, ang, a.face, 0.014);
      const out = V(p0.x, 0, p0.z - headRadii(h0, a.face).cz).normalize();
      const pts = [p0, p0.clone().addScaledVector(out, 0.03).add(V(0, -0.04, 0))];
      const end = p0.clone().addScaledVector(out, 0.035 + rnd() * wobble).add(V(0, -length * (0.8 + rnd() * 0.4), 0));
      pts.push(p0.clone().lerp(end, 0.55).addScaledVector(out, 0.01), end);
      const curve = new THREE.CatmullRomCurve3(pts);
      gs.push(new THREE.TubeGeometry(curve, 7, radius, 6, false));
    }
    return mergeGeometries(gs);
  };
  switch (a.hair) {
    case 'lowcut': hairMesh(capSurface(() => 0.007)); break;
    case 'fade': hairMesh(capSurface((h) => 0.004 + 0.018 * smooth(0.15, 0.25, h), 0.012)); break;
    case 'afro': hairMesh(capSurface((h, ang) => 0.055 + 0.03 * smooth(0.1, 0.25, h) + 0.006 * Math.sin(ang * 9) * Math.sin(h * 90), -0.012, 14)); break;
    case 'braids': hairMesh(capSurface((_h, ang) => 0.011 + 0.003 * Math.abs(Math.sin(ang * 8)))); hairMesh(strands(26, 0.009, 0.34, 0.03)); break;
    case 'locs': hairMesh(capSurface(() => 0.014)); hairMesh(strands(18, 0.014, 0.26, 0.05)); break;
    case 'bun': {
      hairMesh(capSurface(() => 0.008));
      const bun = new THREE.SphereGeometry(1, 14, 10); bun.scale(0.06, 0.05, 0.055); bun.translate(0, 0.205, -0.105); hairMesh(bun);
      break;
    }
    case 'gele': {
      const geleM = mat(a.topColor, 0.5);
      const gs: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 4; i++) {
        const t = new THREE.TorusGeometry(0.1 + i * 0.012, 0.03 + i * 0.004, 10, 28); t.rotateX(Math.PI / 2); t.translate(0, 0.165 + i * 0.03, -0.01 - i * 0.008); gs.push(t);
      }
      const crown = new THREE.SphereGeometry(1, 20, 12); crown.scale(0.15, 0.085, 0.13); crown.translate(0, 0.27, -0.03); gs.push(crown);
      const fan = new THREE.CylinderGeometry(0.17, 0.12, 0.03, 20, 1, false, 0, Math.PI); fan.rotateZ(-0.5); fan.translate(0.1, 0.32, -0.02); gs.push(fan);
      hairMesh(mergeGeometries(gs), geleM);
      // visible edge of hair under the gele
      hairMesh(capSurface(() => 0.006, 0.0, 3));
      break;
    }
    case 'bald': break;
  }

  // head accessories ------------------------------------------------------------
  const gold = mat('#e2b84d', 0.28, 0.9);
  const dark = mat('#15110f', 0.5);
  if (a.accessories.includes('cap')) {
    const capM = mat(isDark(a.bottomColor) ? '#1b1b1b' : a.bottomColor, 0.85);
    const gs: THREE.BufferGeometry[] = [];
    const crown = new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2); crown.scale(0.118, 0.1, 0.125); crown.translate(0, 0.17, -0.004); gs.push(crown);
    const band = new THREE.CylinderGeometry(0.118, 0.122, 0.035, 20, 1, true); band.translate(0, 0.165, -0.004); gs.push(band);
    const brim = new THREE.CylinderGeometry(0.125, 0.125, 0.012, 20, 1, false, -Math.PI / 2, Math.PI); brim.scale(1.25, 1, 1.35); brim.translate(0, 0.152, 0.055); gs.push(brim);
    hairMesh(mergeGeometries(gs), capM);
  }
  if (a.accessories.includes('glasses')) {
    const lensM = new THREE.MeshStandardMaterial({ color: '#0a0a10', roughness: 0.12, metalness: 0.6 });
    const z = headPoint(0.146, 0, a.face).z;
    const gs: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1]) { const l = new THREE.CylinderGeometry(0.026, 0.026, 0.008, 16); l.scale(1.25, 1, 0.9); l.rotateX(Math.PI / 2); l.translate(s * 0.04, 0.146, z + 0.004); gs.push(l); }
    const bridgeG = new THREE.BoxGeometry(0.02, 0.006, 0.006); bridgeG.translate(0, 0.15, z + 0.004); gs.push(bridgeG);
    for (const s of [-1, 1]) { const t = new THREE.BoxGeometry(0.006, 0.006, 0.13); const hp = headPoint(0.15, s * Math.PI / 2, a.face); t.translate(hp.x * 1.02, 0.152, hp.z + 0.05); gs.push(t); }
    hairMesh(mergeGeometries(gs), lensM);
  }
  if (a.accessories.includes('earrings')) {
    const gs: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1]) { const ep = headPoint(0.12, s * Math.PI / 2, a.face); const r = new THREE.TorusGeometry(0.018, 0.0035, 8, 16); r.translate(ep.x, 0.095, ep.z - 0.012); gs.push(r); }
    hairMesh(mergeGeometries(gs), gold);
  }

  // clothing details (parented to the chest) ----------------------------------
  const chest = bone('chest');
  const attach = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Bone, pWorld: THREE.Vector3) => {
    g.translate(-pWorld.x, -pWorld.y, -pWorld.z); // chest-local
    const mm = new THREE.Mesh(g, m); mm.castShadow = true; parent.add(mm); return mm;
  };
  const frontZ = (y: number) => interp(y).rz + CL + 0.004;
  if (a.top === 'shirt') {
    const collarM = mat(shade(a.topColor, 0.85), 0.9);
    const gs: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1]) { const c = new THREE.BoxGeometry(0.075, 0.05, 0.012); c.rotateZ(s * 0.55); c.rotateX(-0.25); c.translate(s * 0.05, 1.45, 0.068); gs.push(c); }
    attach(mergeGeometries(gs), collarM, chest, J.chest);
    const bs: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 5; i++) { const b2 = new THREE.CylinderGeometry(0.008, 0.008, 0.004, 8); b2.rotateX(Math.PI / 2); const y = 1.4 - i * 0.085; b2.translate(0, y, frontZ(y)); bs.push(b2); }
    attach(mergeGeometries(bs), mat('#f6f3ee', 0.5), chest, J.chest);
  } else if (a.top === 'blazer') {
    const lapelM = mat(shade(a.topColor, 0.78), 0.7);
    const gs: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1]) {
      const shape = new THREE.Shape(); shape.moveTo(0, 0); shape.lineTo(s * 0.075, 0.03); shape.lineTo(s * 0.03, -0.17); shape.lineTo(0, -0.2); shape.closePath();
      const g = new THREE.ShapeGeometry(shape); g.translate(0, 1.425, 0); gs.push(g);
    }
    const lap = mergeGeometries(gs);
    // wrap the flat lapels onto the chest curve
    const p = lap.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i); const r = interp(Math.min(1.425, y)); p.setZ(i, (r.rz + CL + 0.005) * Math.sqrt(Math.max(0, 1 - (x / (r.rx + CL)) ** 2))); }
    lap.computeVertexNormals();
    attach(lap, lapelM, chest, J.chest);
    // shirt + tie
    const shirt = new THREE.BoxGeometry(0.07, 0.22, 0.008); shirt.translate(0, 1.33, frontZ(1.33) - 0.006); attach(shirt, mat('#f6f3ee', 0.5), chest, J.chest);
    const tie = new THREE.BoxGeometry(0.028, 0.2, 0.006); tie.translate(0, 1.31, frontZ(1.31)); attach(tie, mat(isDark(a.bottomColor) ? '#8b1e2d' : a.bottomColor, 0.6), chest, J.chest);
    const pocket = new THREE.BoxGeometry(0.06, 0.012, 0.006); pocket.translate(0.11, 1.33, frontZ(1.33) - 0.012); attach(pocket, mat('#f6f3ee', 0.5), chest, J.chest);
  } else if (a.top === 'hoodie') {
    const hoodM = mat(shade(a.topColor, 0.86), 0.95);
    const hood = new THREE.TorusGeometry(0.11, 0.045, 10, 20, Math.PI); hood.rotateX(-0.55); hood.rotateZ(Math.PI); hood.translate(0, 1.455, -0.07); attach(hood, hoodM, chest, J.chest);
    const pocket = new THREE.BoxGeometry(0.2, 0.09, 0.016); pocket.translate(0, 1.06, interp(1.06).rz + CL + 0.004); attach(pocket, hoodM, chest, J.chest);
    const ds: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1]) { const d = new THREE.CylinderGeometry(0.004, 0.004, 0.13, 6); d.translate(s * 0.045, 1.38, frontZ(1.38)); ds.push(d); }
    attach(mergeGeometries(ds), mat('#f3f0ea', 0.6), chest, J.chest);
  } else if (a.top === 'native') {
    const emb = mat(shade(a.topColor, 0.55), 0.55, 0.25);
    const gs: THREE.BufferGeometry[] = [];
    const vline = new THREE.BoxGeometry(0.014, 0.17, 0.006); vline.translate(0, 1.37, frontZ(1.37)); gs.push(vline);
    const collar = new THREE.TorusGeometry(0.064, 0.009, 8, 20); collar.rotateX(Math.PI / 2); collar.translate(0, 1.455, 0); gs.push(collar);
    const pocket = new THREE.BoxGeometry(0.07, 0.07, 0.006); pocket.translate(0.1, 1.32, frontZ(1.32) - 0.01); gs.push(pocket);
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++) { const e = new THREE.CylinderGeometry(0.006, 0.006, 0.005, 8); e.rotateX(Math.PI / 2); e.translate(s * 0.03, 1.42 - i * 0.045, frontZ(1.42 - i * 0.045)); gs.push(e); }
    attach(mergeGeometries(gs), emb, chest, J.chest);
  } else if (a.top === 'crop' || a.top === 'tee') {
    const neckM = mat(shade(a.topColor, 0.85), 0.92);
    const ring = new THREE.TorusGeometry(0.062, 0.009, 8, 22); ring.rotateX(Math.PI / 2); ring.scale(1, 1, 0.9); ring.translate(0, 1.458, -0.005); attach(ring, neckM, chest, J.chest);
  }

  // body accessories -----------------------------------------------------------------
  if (a.accessories.includes('chain')) {
    const gs: THREE.BufferGeometry[] = [];
    const ch = new THREE.TorusGeometry(0.085, 0.007, 8, 32); ch.rotateX(Math.PI / 2 - 0.55); ch.translate(0, 1.39, 0.05); gs.push(ch);
    const pend = new THREE.CylinderGeometry(0.02, 0.02, 0.006, 16); pend.rotateX(Math.PI / 2); pend.translate(0, 1.33, frontZ(1.33) + 0.004); gs.push(pend);
    attach(mergeGeometries(gs), gold, chest, J.chest);
  }
  if (a.accessories.includes('watch')) {
    const hand = bone('handR');
    const gs: THREE.BufferGeometry[] = [];
    const band = new THREE.TorusGeometry(0.034, 0.007, 8, 18); band.rotateX(Math.PI / 2); band.scale(0.75, 1, 1); gs.push(band);
    const face = new THREE.CylinderGeometry(0.018, 0.018, 0.008, 16); face.rotateZ(Math.PI / 2); face.translate(-0.03, 0, 0); gs.push(face);
    const g = mergeGeometries(gs); g.translate(0, 0.0, 0);
    const mm = new THREE.Mesh(g, gold); hand.add(mm);
  }
  if (a.accessories.includes('bag')) {
    const leather = mat('#5a3a2a', 0.55);
    const hips = bone('hips');
    const bag = new THREE.BoxGeometry(0.15, 0.17, 0.07); bag.translate(0.24 * bd.hp, 0.99, 0.0);
    const flap = new THREE.BoxGeometry(0.152, 0.07, 0.074); flap.translate(0.24 * bd.hp, 1.045, 0.0);
    const bg = mergeGeometries([bag, flap]); attach(bg, leather, hips, J.hips);
    const strap = new THREE.TorusGeometry(0.235, 0.011, 6, 36, Math.PI * 1.05); strap.rotateY(Math.PI / 2); strap.rotateZ(-0.75); strap.rotateX(0.1); strap.translate(0.03, 1.24, 0.0);
    attach(strap, leather, chest, J.chest);
  }

  return { mesh, bones, hipsY: J.hips.y };
}
const SOLE_IDX = 5;
