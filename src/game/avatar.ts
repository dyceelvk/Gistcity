/**
 * Procedural, fully customizable humanoid avatar.
 *
 * Every visual choice in `Appearance` maps to geometry here: skin, face shape,
 * beard, lips, eight hairstyles, six tops, four bottoms, shoes and six
 * accessories. Limbs are pivot groups so the controller can animate a
 * walk / run cycle without a skeleton.
 */
import * as THREE from 'three';
import type { Appearance } from './appearance';

const matCache = new Map<string, THREE.MeshStandardMaterial>();
export function mat(color: string, roughness = 0.8, metalness = 0): THREE.MeshStandardMaterial {
  const key = `${color}|${roughness}|${metalness}`;
  let m = matCache.get(key);
  if (!m) { m = new THREE.MeshStandardMaterial({ color, roughness, metalness }); matCache.set(key, m); }
  return m;
}

const shade = (hex: string, f: number) => '#' + new THREE.Color(hex).multiplyScalar(f).getHexString();
const isDark = (hex: string) => { const c = new THREE.Color(hex); return c.r * 0.3 + c.g * 0.59 + c.b * 0.11 < 0.35; };

function mesh(geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, parent?: THREE.Object3D) {
  const o = new THREE.Mesh(geo, m);
  o.position.set(x, y, z);
  o.castShadow = true;
  parent?.add(o);
  return o;
}
const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, p?: THREE.Object3D) =>
  mesh(new THREE.BoxGeometry(w, h, d), m, x, y, z, p);
const capsule = (r: number, len: number, m: THREE.Material, x: number, y: number, z: number, p?: THREE.Object3D) =>
  mesh(new THREE.CapsuleGeometry(r, len, 4, 10), m, x, y, z, p);
const sphere = (r: number, m: THREE.Material, x: number, y: number, z: number, p?: THREE.Object3D, ws = 14, hs = 10) =>
  mesh(new THREE.SphereGeometry(r, ws, hs), m, x, y, z, p);
const cyl = (rt: number, rb: number, h: number, m: THREE.Material, x: number, y: number, z: number, p?: THREE.Object3D, seg = 14) =>
  mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m, x, y, z, p);

export interface AvatarParts {
  body: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group; armR: THREE.Group; elbowL: THREE.Group; elbowR: THREE.Group;
  legL: THREE.Group; legR: THREE.Group; kneeL: THREE.Group; kneeR: THREE.Group;
}

export class Avatar {
  readonly root = new THREE.Group();
  parts!: AvatarParts;
  appearance!: Appearance;
  /** Animation phase accumulator. */
  private phase = 0;
  private idleT = Math.random() * 10;

  constructor(appearance: Appearance) {
    this.setAppearance(appearance);
  }

  setAppearance(a: Appearance) {
    this.appearance = a;
    while (this.root.children.length) this.root.remove(this.root.children[0]);
    this.parts = buildBody(a, this.root);
  }

  /**
   * @param speed 0 = idle, 1 = walking, 2 = running.
   */
  animate(dt: number, speed: number) {
    const p = this.parts;
    this.idleT += dt;
    const moving = speed > 0.05;
    const run = speed > 1.5;
    const freq = run ? 11.5 : 7.5;
    if (moving) this.phase += dt * freq;
    const s = Math.sin(this.phase);
    const k = Math.min(1, dt * 14);
    const legAmp = run ? 0.95 : 0.62;
    const armAmp = run ? 0.95 : 0.48;

    const target = moving
      ? { legL: s * legAmp, legR: -s * legAmp, armL: -s * armAmp, armR: s * armAmp,
          kneeL: Math.max(0, -s) * (run ? 1.3 : 0.8), kneeR: Math.max(0, s) * (run ? 1.3 : 0.8),
          elbow: run ? -1.1 : -0.35, bob: Math.abs(Math.cos(this.phase)) * (run ? 0.06 : 0.03), lean: run ? 0.16 : 0.04 }
      : { legL: 0, legR: 0, armL: Math.sin(this.idleT * 1.6) * 0.04, armR: -Math.sin(this.idleT * 1.6) * 0.04,
          kneeL: 0, kneeR: 0, elbow: -0.15, bob: Math.sin(this.idleT * 2.2) * 0.006, lean: 0 };

    const lerp = THREE.MathUtils.lerp;
    p.legL.rotation.x = lerp(p.legL.rotation.x, target.legL, k);
    p.legR.rotation.x = lerp(p.legR.rotation.x, target.legR, k);
    p.kneeL.rotation.x = lerp(p.kneeL.rotation.x, target.kneeL, k);
    p.kneeR.rotation.x = lerp(p.kneeR.rotation.x, target.kneeR, k);
    p.armL.rotation.x = lerp(p.armL.rotation.x, target.armL, k);
    p.armR.rotation.x = lerp(p.armR.rotation.x, target.armR, k);
    p.elbowL.rotation.x = lerp(p.elbowL.rotation.x, target.elbow, k);
    p.elbowR.rotation.x = lerp(p.elbowR.rotation.x, target.elbow, k);
    p.body.position.y = lerp(p.body.position.y, target.bob, k);
    p.body.rotation.x = lerp(p.body.rotation.x, target.lean, k);
    p.head.rotation.x = lerp(p.head.rotation.x, -target.lean * 0.6, k);
  }
}

/* ------------------------------------------------------------------ builder */

function buildBody(a: Appearance, root: THREE.Group): AvatarParts {
  const skin = mat(a.skin, 0.75);
  const top = mat(a.topColor, 0.85);
  const bottom = mat(a.bottomColor, 0.85);
  const shoes = mat(a.shoesColor, 0.6);
  const hair = mat(a.hairColor, 0.9);
  const dark = mat('#15110f', 0.6);
  const white = mat('#f6f3ee', 0.5);
  const gold = mat('#e0b64a', 0.3, 0.9);

  const body = new THREE.Group();
  root.add(body);

  // ---- torso ------------------------------------------------------------
  const torso = new THREE.Group();
  torso.position.y = 0.92;
  body.add(torso);

  const torsoH = 0.53;
  const trunk = (rt: number, rb: number, h: number, m: THREE.Material, y: number) => { const t = cyl(rt, rb, h, m, 0, y, 0, torso, 14); t.scale.z = 0.64; return t; };
  if (a.top === 'crop') {
    trunk(0.2, 0.185, 0.27, top, torsoH - 0.135);
    trunk(0.185, 0.17, 0.27, skin, 0.135);
  } else {
    trunk(0.2, 0.17, torsoH, top, torsoH / 2);
  }
  // shoulders
  sphere(0.075, top, -0.21, torsoH - 0.03, 0, torso, 10, 8);
  sphere(0.075, top, 0.21, torsoH - 0.03, 0, torso, 10, 8);
  // hips / waistband
  const hip = cyl(0.18, 0.19, 0.12, bottom, 0, 0.0, 0, torso, 14); hip.scale.z = 0.66;

  if (a.top === 'blazer') {
    const lapel = mat(shade(a.topColor, 0.75), 0.8);
    box(0.07, 0.3, 0.02, lapel, -0.08, torsoH - 0.17, 0.115, torso).rotation.z = -0.2;
    box(0.07, 0.3, 0.02, lapel, 0.08, torsoH - 0.17, 0.115, torso).rotation.z = 0.2;
    box(0.09, 0.3, 0.015, white, 0, torsoH - 0.17, 0.115, torso);
    box(0.02, 0.06, 0.02, dark, 0, torsoH - 0.06, 0.12, torso); // tie knot-ish
  } else if (a.top === 'shirt') {
    const collar = mat(shade(a.topColor, 0.8), 0.8);
    box(0.08, 0.05, 0.03, collar, -0.06, torsoH - 0.02, 0.1, torso).rotation.z = 0.5;
    box(0.08, 0.05, 0.03, collar, 0.06, torsoH - 0.02, 0.1, torso).rotation.z = -0.5;
    for (let i = 0; i < 4; i++) box(0.02, 0.02, 0.01, white, 0, torsoH - 0.12 - i * 0.1, 0.115, torso);
  } else if (a.top === 'hoodie') {
    const hoodM = mat(shade(a.topColor, 0.85), 0.9);
    mesh(new THREE.TorusGeometry(0.14, 0.05, 8, 16, Math.PI), hoodM, 0, torsoH + 0.02, -0.06, torso).rotation.x = -0.4;
    box(0.2, 0.1, 0.02, hoodM, 0, 0.14, 0.115, torso); // kangaroo pocket
    box(0.012, 0.12, 0.012, white, -0.05, torsoH - 0.1, 0.12, torso); // drawstrings
    box(0.012, 0.12, 0.012, white, 0.05, torsoH - 0.1, 0.12, torso);
  } else if (a.top === 'native') {
    // Kaftan/senator: long top down to mid-thigh, embroidered neckline.
    cyl(0.21, 0.24, 0.34, top, 0, -0.14, 0, torso, 16);
    const emb = mat(shade(a.topColor, 0.6), 0.6, 0.2);
    box(0.02, 0.2, 0.01, emb, 0, torsoH - 0.12, 0.115, torso);
    box(0.1, 0.02, 0.01, emb, 0, torsoH - 0.02, 0.115, torso);
    // breast pocket
    box(0.07, 0.07, 0.01, emb, 0.1, torsoH - 0.14, 0.115, torso);
  }

  // ---- neck & head --------------------------------------------------------
  const head = new THREE.Group();
  head.position.y = torsoH;
  torso.add(head);
  cyl(0.055, 0.06, 0.08, skin, 0, 0.03, 0, head);
  const r = 0.125;
  const headMesh = sphere(r, skin, 0, 0.2, 0, head, 18, 14);
  if (a.face === 'round') headMesh.scale.set(1.08, 0.96, 1.04);
  if (a.face === 'square') headMesh.scale.set(1.04, 1.02, 0.98);
  if (a.face === 'square') box(0.2, 0.14, 0.2, skin, 0, 0.13, 0, head); // jaw
  const hc = 0.2; // head centre y

  // face
  for (const sx of [-1, 1]) {
    sphere(0.026, white, sx * 0.045, hc + 0.015, 0.105, head, 10, 8);
    sphere(0.013, dark, sx * 0.045, hc + 0.015, 0.126, head, 8, 6);
    box(0.05, 0.012, 0.01, hair, sx * 0.045, hc + 0.058, 0.118, head).rotation.z = sx * 0.12;
  }
  box(0.028, 0.045, 0.035, mat(shade(a.skin, 0.92), 0.75), 0, hc - 0.015, 0.125, head);
  const lipM = a.lips ? mat(a.lips, 0.4) : mat(shade(a.skin, 0.7), 0.6);
  box(0.055, a.lips ? 0.02 : 0.013, 0.012, lipM, 0, hc - 0.062, 0.117, head);
  // ears
  sphere(0.022, skin, -0.12, hc, 0, head, 8, 6);
  sphere(0.022, skin, 0.12, hc, 0, head, 8, 6);

  if (a.beard === 'goatee') box(0.06, 0.05, 0.03, hair, 0, hc - 0.1, 0.1, head);
  if (a.beard === 'full') {
    mesh(new THREE.SphereGeometry(r + 0.006, 16, 8, 0, Math.PI, Math.PI / 2 + 0.05, Math.PI / 2 - 0.05), hair, 0, hc, 0, head);
  }

  // hair
  const capGeo = (rr: number, len = Math.PI / 2 - 0.15) => new THREE.SphereGeometry(rr, 18, 10, 0, Math.PI * 2, 0, len);
  switch (a.hair) {
    case 'lowcut': mesh(capGeo(r + 0.008), hair, 0, hc, 0, head); break;
    case 'fade': {
      mesh(capGeo(r + 0.004, Math.PI / 2 - 0.35), hair, 0, hc, 0, head);
      cyl(0.1, 0.11, 0.06, hair, 0, hc + 0.1, 0, head, 16);
      break;
    }
    case 'afro': sphere(r * 1.55, hair, 0, hc + 0.06, -0.01, head, 20, 14); break;
    case 'braids': {
      mesh(capGeo(r + 0.01), hair, 0, hc, 0, head);
      for (let i = 0; i < 14; i++) {
        const ang = (i / 14) * Math.PI * 2;
        const bx = Math.sin(ang) * (r + 0.01), bz = Math.cos(ang) * (r + 0.01);
        if (bz > 0.1) continue; // leave the face clear
        cyl(0.012, 0.012, 0.34, hair, bx, hc - 0.12, bz, head, 6);
      }
      break;
    }
    case 'locs': {
      mesh(capGeo(r + 0.015), hair, 0, hc, 0, head);
      for (let i = 0; i < 9; i++) {
        const ang = (i / 9) * Math.PI * 2;
        const bx = Math.sin(ang) * (r + 0.02), bz = Math.cos(ang) * (r + 0.02);
        if (bz > 0.09) continue;
        cyl(0.02, 0.016, 0.26, hair, bx, hc - 0.07, bz, head, 6).rotation.z = Math.sin(ang) * 0.15;
      }
      break;
    }
    case 'bun': {
      mesh(capGeo(r + 0.008), hair, 0, hc, 0, head);
      sphere(0.07, hair, 0, hc + 0.1, -0.09, head);
      break;
    }
    case 'gele': {
      const geleM = mat(a.topColor, 0.55);
      mesh(new THREE.TorusGeometry(0.125, 0.06, 10, 20), geleM, 0, hc + 0.07, 0, head).rotation.x = Math.PI / 2;
      const crown = sphere(0.14, geleM, 0, hc + 0.13, -0.02, head);
      crown.scale.set(1.25, 0.75, 1.05);
      // fan fold
      box(0.22, 0.14, 0.03, geleM, 0.08, hc + 0.2, -0.03, head).rotation.z = -0.4;
      break;
    }
    case 'bald': break;
  }

  // head accessories
  if (a.accessories.includes('cap')) {
    const capM = mat(isDark(a.bottomColor) ? '#1a1a1a' : a.bottomColor, 0.8);
    cyl(0.13, 0.14, 0.09, capM, 0, hc + 0.085, 0, head, 18);
    sphere(0.135, capM, 0, hc + 0.085, 0, head).scale.set(1, 0.55, 1);
    box(0.2, 0.015, 0.13, capM, 0, hc + 0.05, 0.16, head);
  }
  if (a.accessories.includes('glasses')) {
    const lens = mat('#0d0d12', 0.2, 0.6);
    box(0.21, 0.05, 0.02, lens, 0, hc + 0.015, 0.125, head);
    box(0.02, 0.012, 0.14, dark, -0.11, hc + 0.025, 0.05, head);
    box(0.02, 0.012, 0.14, dark, 0.11, hc + 0.025, 0.05, head);
  }
  if (a.accessories.includes('earrings')) {
    for (const sx of [-1, 1]) mesh(new THREE.TorusGeometry(0.02, 0.005, 6, 12), gold, sx * 0.125, hc - 0.03, 0, head);
  }

  // ---- arms ---------------------------------------------------------------
  const sleeveLong = a.top === 'shirt' || a.top === 'blazer' || a.top === 'hoodie' || a.top === 'native';
  const sleeveM = top;
  const mkArm = (side: -1 | 1) => {
    const arm = new THREE.Group();
    arm.position.set(side * 0.245, torsoH - 0.04, 0);
    torso.add(arm);
    capsule(0.055, 0.2, sleeveM, 0, -0.14, 0, arm); // upper arm (sleeve)
    const elbow = new THREE.Group();
    elbow.position.y = -0.29;
    arm.add(elbow);
    capsule(0.048, 0.18, sleeveLong ? sleeveM : skin, 0, -0.12, 0, elbow);
    sphere(0.05, skin, 0, -0.26, 0, elbow, 10, 8); // hand
    if (a.accessories.includes('watch') && side === -1) box(0.075, 0.03, 0.075, gold, 0, -0.21, 0, elbow);
    return { arm, elbow };
  };
  const L = mkArm(-1), R = mkArm(1);

  // torso accessories
  if (a.accessories.includes('chain')) {
    mesh(new THREE.TorusGeometry(0.1, 0.012, 8, 24), gold, 0, torsoH - 0.03, 0.06, torso).rotation.x = Math.PI / 2 - 0.5;
    box(0.04, 0.05, 0.015, gold, 0, torsoH - 0.14, 0.12, torso);
  }
  if (a.accessories.includes('bag')) {
    const leather = mat('#5d4037', 0.6);
    box(0.14, 0.17, 0.07, leather, 0.26, 0.05, 0.02, torso);
    const strap = box(0.025, 0.62, 0.012, leather, 0, torsoH / 2 + 0.02, 0.12, torso);
    strap.rotation.z = -0.55;
    const strapBack = box(0.025, 0.62, 0.012, leather, 0, torsoH / 2 + 0.02, -0.12, torso);
    strapBack.rotation.z = -0.55;
  }

  // ---- legs & bottoms -------------------------------------------------------
  const lowerCovered = a.bottom === 'trousers' || a.bottom === 'joggers';
  const upperM = a.bottom === 'skirt' ? skin : bottom;
  const mkLeg = (side: -1 | 1) => {
    const leg = new THREE.Group();
    leg.position.set(side * 0.105, 0.92, 0);
    body.add(leg);
    capsule(0.075, 0.28, upperM, 0, -0.2, 0, leg);
    const knee = new THREE.Group();
    knee.position.y = -0.42;
    leg.add(knee);
    capsule(0.062, 0.24, lowerCovered ? bottom : skin, 0, -0.18, 0, knee);
    if (a.bottom === 'joggers') cyl(0.07, 0.07, 0.05, mat(shade(a.bottomColor, 0.7), 0.9), 0, -0.34, 0, knee, 10);
    box(0.13, 0.1, 0.26, shoes, 0, -0.4, 0.04, knee);
    box(0.135, 0.03, 0.27, mat(isDark(a.shoesColor) ? '#f6f3ee' : '#1a1a1a', 0.6), 0, -0.445, 0.04, knee); // sole
    return { leg, knee };
  };
  const LL = mkLeg(-1), RL = mkLeg(1);
  if (a.bottom === 'skirt') cyl(0.19, 0.25, 0.36, bottom, 0, 0.76, 0, body, 18);
  if (a.bottom === 'shorts') for (const s of [-1, 1]) cyl(0.082, 0.082, 0.1, bottom, s * 0.105, 0.6, 0, body, 10);

  // drop shadow blob
  const blob = new THREE.Mesh(new THREE.CircleGeometry(0.42, 20), new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.22, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.015;
  root.add(blob);

  return { body, torso, head, armL: L.arm, armR: R.arm, elbowL: L.elbow, elbowR: R.elbow, legL: LL.leg, legR: RL.leg, kneeL: LL.knee, kneeR: RL.knee };
}
