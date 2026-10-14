/**
 * Gist City — a small, dense Nigerian-inspired neighbourhood.
 *
 * Four inner blocks around a roundabout:
 *   NW market & GIST Fits store · NE residential (your flat, Gist Heights)
 *   SW food & nightlife (Suya Spot, buka, Vibe Lounge) · SE the Pitch & Hustle Hub
 * …ringed by background streets so the skyline never ends abruptly.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mat } from './avatar';
import {
  AABB, box, cyl, signboard, palm, tree, streetLamp, bench, car, danfo, keke,
  compoundWall, kiosk, umbrella, generator, waterTank, satelliteDish, textTexture,
} from './props';

export interface Zone {
  id: string;
  label: string;
  icon: string;
  x: number; z: number;
  radius: number;
  prompt: string;
}

export interface Landmark { x: number; z: number; w: number; d: number; color: string; label?: string }

export interface World {
  group: THREE.Group;
  colliders: AABB[];
  zones: Zone[];
  landmarks: Landmark[];
  roads: { x: number; z: number; w: number; d: number }[];
  paths: THREE.Vector3[][];
  spawn: THREE.Vector3;
  /** Named spots the dispatch job can send you to. */
  deliverySpots: { name: string; x: number; z: number }[];
  animated: ((dt: number, t: number) => void)[];
  bounds: number;
}

const PALETTE = ['#e8d9b5', '#f0c9a0', '#d98c5f', '#9fc5c8', '#cfe3c4', '#e4c067', '#f2efe6', '#c47c6a', '#b9d5e8', '#d6b58a'];

type Facing = 'n' | 's' | 'e' | 'w';
const facingRot: Record<Facing, number> = { s: 0, e: Math.PI / 2, n: Math.PI, w: -Math.PI / 2 };

interface BuildingOpts {
  style?: 'flat' | 'bungalow' | 'shop' | 'duplex' | 'lounge';
  color?: string;
  facing?: Facing;
  sign?: string;
  signColors?: [string, string];
  balconies?: boolean;
  tank?: boolean;
  dish?: boolean;
  gen?: boolean;
}

/**
 * A building whose footprint is `w` (along x) by `d` (along z), centred at (x,z).
 * Windows are merged into a single mesh per building to keep draw calls low.
 */
function building(parent: THREE.Object3D, colliders: AABB[], landmarks: Landmark[], x: number, z: number, w: number, d: number, floors: number, o: BuildingOpts = {}) {
  const style = o.style ?? 'flat';
  const color = o.color ?? PALETTE[Math.floor(Math.abs(x * 7 + z * 13)) % PALETTE.length];
  const facing: Facing = o.facing ?? 's';
  const fh = style === 'shop' ? 3.6 : 3.1;
  const h = floors * fh;
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  parent.add(g);

  const wallM = mat(color, 0.92);
  const trimM = mat('#f6f1e4', 0.9);
  const darkM = mat('#3b3a36', 0.8);

  // We build the facade on local +z and rotate the whole group to face the street.
  g.rotation.y = facingRot[facing];
  const fw = facing === 'n' || facing === 's' ? w : d;   // width of the front face
  const fd = facing === 'n' || facing === 's' ? d : w;   // depth (front to back)
  box(g, fw, h, fd, wallM, 0, h / 2, 0);
  box(g, fw + 0.1, 0.5, fd + 0.1, mat('#8d8578', 0.95), 0, 0.25, 0); // plinth

  // windows (merged)
  const winGeos: THREE.BufferGeometry[] = [];
  const frameGeos: THREE.BufferGeometry[] = [];
  const acGeos: THREE.BufferGeometry[] = [];
  const addWindow = (wx: number, wy: number, wz: number, ry: number, ww = 1.1, wh = 1.3) => {
    const gw = new THREE.BoxGeometry(ww, wh, 0.08); gw.rotateY(ry); gw.translate(wx, wy, wz); winGeos.push(gw);
    const gf = new THREE.BoxGeometry(ww + 0.18, wh + 0.18, 0.05); gf.rotateY(ry); gf.translate(wx, wy, wz); frameGeos.push(gf);
  };
  const startY = style === 'shop' ? fh : 0;
  for (let f = (style === 'shop' ? 1 : 0); f < floors; f++) {
    const wy = startY + (f - (style === 'shop' ? 1 : 0)) * fh + fh * 0.58;
    // front & back
    const nx = Math.max(1, Math.floor(fw / 2.6));
    for (let i = 0; i < nx; i++) {
      const wx = -fw / 2 + (i + 0.5) * (fw / nx);
      if (f === 0 && i === Math.floor(nx / 2) && style !== 'shop') continue; // door spot
      addWindow(wx, wy, fd / 2 + 0.02, 0);
      addWindow(wx, wy, -fd / 2 - 0.02, 0);
      if ((i + f) % 3 === 1) { const ac = new THREE.BoxGeometry(0.7, 0.5, 0.4); ac.translate(wx + 0.9, wy - 0.3, fd / 2 + 0.22); acGeos.push(ac); }
    }
    // sides
    const nz = Math.max(1, Math.floor(fd / 3));
    for (let i = 0; i < nz; i++) {
      const wz = -fd / 2 + (i + 0.5) * (fd / nz);
      addWindow(fw / 2 + 0.02, wy, wz, Math.PI / 2, 1.0, 1.2);
      addWindow(-fw / 2 - 0.02, wy, wz, Math.PI / 2, 1.0, 1.2);
    }
  }
  if (winGeos.length) {
    const wm = new THREE.Mesh(mergeGeometries(winGeos)!, mat('#2f4a55', 0.25, 0.4));
    g.add(wm);
    const fm = new THREE.Mesh(mergeGeometries(frameGeos)!, trimM); fm.castShadow = true; g.add(fm);
  }
  if (acGeos.length) { const am = new THREE.Mesh(mergeGeometries(acGeos)!, mat('#d9d9d4', 0.6)); am.castShadow = true; g.add(am); }

  // door (front, ground floor)
  if (style !== 'shop') {
    box(g, 1.3, 2.3, 0.1, mat('#5a3b2a', 0.7), 0, 1.15, fd / 2 + 0.04);
    box(g, 1.7, 0.15, 0.9, darkM, 0, 2.45, fd / 2 + 0.4); // small canopy
    box(g, 2.0, 0.3, 1.0, mat('#9a9389', 0.9), 0, 0.15, fd / 2 + 0.5); // step
  } else {
    // shop front: glass + door + awning + sign
    box(g, fw - 1.2, fh - 1.0, 0.1, mat('#355d6b', 0.15, 0.6), 0, fh / 2 + 0.15, fd / 2 + 0.03);
    box(g, 1.4, 2.6, 0.12, mat('#1d2a2e', 0.4, 0.4), 0, 1.3, fd / 2 + 0.08);
    const awn = box(g, fw - 0.6, 0.08, 1.6, mat(o.signColors?.[0] ?? '#e74c3c', 0.8), 0, fh - 0.3, fd / 2 + 0.8); awn.rotation.x = 0.18;
    if (o.sign) signboard(g, o.sign, Math.min(fw - 0.8, 10), 1.2, 0, fh + 0.4, fd / 2 + 0.1, 0, o.signColors?.[0] ?? '#e74c3c', o.signColors?.[1] ?? '#fff');
  }
  if (style === 'lounge') {
    const neon = new THREE.MeshStandardMaterial({ color: '#ff3cac', emissive: '#ff3cac', emissiveIntensity: 1.6, roughness: 0.3 });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(fw - 1, 9), 1.3), new THREE.MeshStandardMaterial({ map: textTexture(o.sign ?? 'LOUNGE', { bg: '#120816', fg: '#ff3cac', sub: 'open till mama born', subColor: '#9be8ff' }), emissive: '#ff3cac', emissiveIntensity: 0.35, roughness: 0.4 }));
    sign.position.set(0, h - 1.2, fd / 2 + 0.06); g.add(sign);
    box(g, fw, 0.08, 0.12, neon, 0, fh + 0.2, fd / 2 + 0.08);
    box(g, fw, 0.08, 0.12, neon, 0, h - 0.4, fd / 2 + 0.08);
    // door, speakers, rope barrier
    box(g, 1.6, 2.6, 0.12, mat('#1a1a1a', 0.5), 0, 1.3, fd / 2 + 0.08);
    for (const sx of [-1.6, 1.6]) box(g, 0.6, 1.0, 0.5, mat('#111', 0.7), sx, 0.5, fd / 2 + 0.5);
    for (const sx of [-1.2, 1.2]) { cyl(g, 0.04, 0.04, 1.0, mat('#d8b46a', 0.3, 0.8), sx, 0.5, fd / 2 + 1.6, 6); }
    box(g, 2.4, 0.04, 0.04, mat('#b3002d', 0.6), 0, 0.95, fd / 2 + 1.6);
  }
  if (o.sign && style !== 'shop' && style !== 'lounge') {
    signboard(g, o.sign, Math.min(fw - 1, 7), 0.9, 0, h - 0.7, fd / 2 + 0.08, 0, o.signColors?.[0] ?? '#1b1b1b', o.signColors?.[1] ?? '#f5c242');
  }
  if (o.balconies) {
    for (let f = 1; f < floors; f++) {
      const by = f * fh + 0.05;
      box(g, fw - 1.0, 0.12, 1.2, trimM, 0, by, fd / 2 + 0.6);
      box(g, fw - 1.0, 0.9, 0.08, mat('#6f8f99', 0.6, 0.3), 0, by + 0.5, fd / 2 + 1.16);
    }
  }
  // roof
  if (style === 'bungalow' || style === 'duplex') {
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 4), mat(style === 'bungalow' ? '#8a4b3a' : '#4d5a66', 0.85, 0.2));
    roof.rotation.y = Math.PI / 4;
    const rh = style === 'bungalow' ? 1.8 : 2.2;
    roof.scale.set((fw + 1.2) * 0.72, rh, (fd + 1.2) * 0.72);
    roof.position.y = h + rh / 2 - 0.05; roof.castShadow = true;
    g.add(roof);
  } else {
    box(g, fw + 0.2, 0.3, fd + 0.2, mat('#6b665c', 0.9), 0, h + 0.1, 0); // parapet slab
    box(g, fw + 0.2, 0.6, 0.2, mat(color, 0.9), 0, h + 0.4, fd / 2);
    box(g, fw + 0.2, 0.6, 0.2, mat(color, 0.9), 0, h + 0.4, -fd / 2);
    box(g, 0.2, 0.6, fd + 0.2, mat(color, 0.9), fw / 2, h + 0.4, 0);
    box(g, 0.2, 0.6, fd + 0.2, mat(color, 0.9), -fw / 2, h + 0.4, 0);
  }
  if (o.tank) waterTank(g, -fw / 4, h + 0.25, -fd / 4);
  if (o.dish) satelliteDish(g, fw / 3, h + 0.6, fd / 3);
  if (o.gen) generator(g, fw / 2 + 0.8, -fd / 3, Math.PI / 2);

  colliders.push({ minX: x - w / 2 - 0.1, maxX: x + w / 2 + 0.1, minZ: z - d / 2 - 0.1, maxZ: z + d / 2 + 0.1, h });
  landmarks.push({ x, z, w, d, color, label: o.sign });
  return g;
}

export function buildWorld(): World {
  const group = new THREE.Group();
  const colliders: AABB[] = [];
  const landmarks: Landmark[] = [];
  const zones: Zone[] = [];
  const animated: World['animated'] = [];
  const bounds = 74;

  // ---- ground, lots, roads ---------------------------------------------
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), mat('#7f8f66', 1));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; group.add(ground);

  const lot = (x: number, z: number, w: number, d: number, color: string) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(color, 1));
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.012, z); m.receiveShadow = true; group.add(m);
  };
  lot(-26.75, -26.75, 41.5, 41.5, '#a8a494'); // market
  lot(26.75, -26.75, 41.5, 41.5, '#b48a66');  // residential earth
  lot(-26.75, 26.75, 41.5, 41.5, '#a39f90');  // food
  lot(26.75, 26.75, 41.5, 41.5, '#8ea56e');   // pitch block

  const roads: World['roads'] = [
    { x: 0, z: 0, w: 12, d: 160 }, { x: 0, z: 0, w: 160, d: 12 },
    { x: -52, z: 0, w: 9, d: 160 }, { x: 52, z: 0, w: 9, d: 160 },
    { x: 0, z: -52, w: 160, d: 9 }, { x: 0, z: 52, w: 160, d: 9 },
  ];
  const roadM = mat('#3a3f3e', 0.95);
  for (const r of roads) { const m = new THREE.Mesh(new THREE.BoxGeometry(r.w, 0.08, r.d), roadM); m.position.set(r.x, 0.03, r.z); m.receiveShadow = true; group.add(m); }

  // markings (merged)
  const markGeos: THREE.BufferGeometry[] = [];
  for (let z = -78; z < 78; z += 4) { if (Math.abs(z) < 10) continue; const gm = new THREE.BoxGeometry(0.18, 0.02, 2); gm.translate(0, 0.08, z); markGeos.push(gm); }
  for (let x = -78; x < 78; x += 4) { if (Math.abs(x) < 10) continue; const gm = new THREE.BoxGeometry(2, 0.02, 0.18); gm.translate(x, 0.08, 0); markGeos.push(gm); }
  for (const s of [-1, 1]) for (let i = 0; i < 8; i++) { // zebra crossings at the junction
    const g1 = new THREE.BoxGeometry(0.8, 0.02, 2.4); g1.translate(-5.25 + i * 1.5, 0.08, s * 9.5); markGeos.push(g1);
    const g2 = new THREE.BoxGeometry(2.4, 0.02, 0.8); g2.translate(s * 9.5, 0.08, -5.25 + i * 1.5); markGeos.push(g2);
  }
  group.add(new THREE.Mesh(mergeGeometries(markGeos)!, mat('#e8e2c8', 0.9)));

  // sidewalks along both avenues
  const walkM = mat('#bcb7a6', 0.95);
  for (const s of [-1, 1]) for (const seg of [[-78, -9], [9, 78]]) {
    const len = seg[1] - seg[0], mid = (seg[0] + seg[1]) / 2;
    const a = new THREE.Mesh(new THREE.BoxGeometry(3, 0.16, len), walkM); a.position.set(s * 7.5, 0.08, mid); a.receiveShadow = true; group.add(a);
    const b = new THREE.Mesh(new THREE.BoxGeometry(len, 0.16, 3), walkM); b.position.set(mid, 0.08, s * 7.5); b.receiveShadow = true; group.add(b);
  }

  // ---- roundabout ------------------------------------------------------
  const rb = new THREE.Mesh(new THREE.CylinderGeometry(7, 7.3, 0.35, 40), mat('#6f9d5a', 1)); rb.position.y = 0.17; rb.receiveShadow = true; group.add(rb);
  const kerb = new THREE.Mesh(new THREE.TorusGeometry(7.1, 0.2, 6, 40), mat('#d8d3c4', 0.9)); kerb.rotation.x = Math.PI / 2; kerb.position.y = 0.3; group.add(kerb);
  box(group, 3.2, 1.2, 3.2, mat('#8d8578', 0.9), 0, 0.9, 0);
  const plinthSign = new THREE.Mesh(new THREE.BoxGeometry(3.0, 1.6, 0.6), mat('#141a16', 0.6));
  plinthSign.position.y = 2.3; plinthSign.castShadow = true; group.add(plinthSign);
  for (const ry of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const face = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.4), new THREE.MeshStandardMaterial({ map: textTexture('GIST', { bg: '#141a16', fg: '#a5ff38', sub: 'YOUR CITY. YOUR STORY.', subColor: '#f6f8f4' }), emissive: '#a5ff38', emissiveIntensity: 0.25, roughness: 0.5 }));
    face.rotation.y = ry;
    face.position.set(Math.sin(ry) * 0.31, 2.3, Math.cos(ry) * 0.31);
    if (ry === Math.PI / 2 || ry === -Math.PI / 2) { face.position.set(Math.sin(ry) * 1.51, 2.3, 0); }
    group.add(face);
  }
  colliders.push({ minX: -1.7, maxX: 1.7, minZ: -1.7, maxZ: 1.7, h: 3.2 });
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; palm(group, Math.cos(a) * 4.6, Math.sin(a) * 4.6, 1.1, colliders); }

  // ---- NW: market & GIST Fits ------------------------------------------
  building(group, colliders, landmarks, -17.5, -22, 13, 14, 2, { style: 'shop', facing: 'e', color: '#f2efe6', sign: 'GIST FITS', signColors: ['#a5ff38', '#0b0e0c'] });
  zones.push({ id: 'store', label: 'GIST Fits', icon: '👕', x: -9.8, z: -22, radius: 2.6, prompt: 'Enter GIST Fits' });
  // mannequins in the window are overkill; a rack outside instead
  for (let i = 0; i < 5; i++) box(group, 0.5, 1.0, 0.1, mat(['#e33e79', '#1f3a93', '#f5c242', '#1a1a1a', '#2ecc71'][i], 0.8), -10.3, 1.0, -30 + i * 0.7);
  box(group, 0.06, 1.6, 3.4, mat('#555', 0.5, 0.5), -10.5, 1.0, -28.6);
  colliders.push({ minX: -10.9, maxX: -10.0, minZ: -30.4, maxZ: -26.8, h: 1.6 });

  kiosk(group, -12.4, -37, Math.PI / 2, 'MAMA BISI PROVISIONS', colliders, '#d98c5f');
  kiosk(group, -12.4, -43.5, Math.PI / 2, 'PHONE ACCESSORIES', colliders, '#9fc5c8');
  kiosk(group, -20, -11.2, 0, 'QUICKCASH POS', colliders, '#e4c067');
  zones.push({ id: 'pos', label: 'QuickCash POS', icon: '💳', x: -20, z: -8.3, radius: 2.4, prompt: 'Work the POS stand' });
  umbrella(group, -16, -12, '#2e86de'); umbrella(group, -24.5, -12, '#f5c242');
  building(group, colliders, landmarks, -38, -18, 12, 16, 3, { facing: 'w', color: '#e8d9b5', balconies: true, tank: true, gen: true });
  building(group, colliders, landmarks, -38, -38, 12, 14, 4, { facing: 'w', color: '#9fc5c8', tank: true, dish: true });
  building(group, colliders, landmarks, -22, -41, 12, 8, 1, { style: 'bungalow', facing: 'n', color: '#cfe3c4', dish: true });
  tree(group, -30, -28, 1.1, colliders); tree(group, -27, -10.5, 0.9, colliders);
  // market stalls (tables with goods) on the lot
  for (let i = 0; i < 4; i++) {
    const sx = -30 + (i % 2) * 5, sz = -30 - Math.floor(i / 2) * 4;
    box(group, 2.4, 0.08, 1.2, mat('#8a5a2b', 0.9), sx, 0.85, sz);
    for (const lx of [-1, 1]) box(group, 0.08, 0.85, 1.1, mat('#6b4a2b', 0.9), sx + lx * 1.1, 0.42, sz);
    for (let k = 0; k < 4; k++) box(group, 0.4, 0.3, 0.4, mat(['#e74c3c', '#f1c40f', '#2ecc71', '#e67e22'][(k + i) % 4], 0.7), sx - 0.9 + k * 0.6, 1.05, sz);
    const u = umbrella(group, sx, sz, ['#e74c3c', '#2e86de', '#f5c242', '#2ecc71'][i]);
    void u;
    colliders.push({ minX: sx - 1.3, maxX: sx + 1.3, minZ: sz - 0.7, maxZ: sz + 0.7, h: 1 });
  }

  // ---- NE: residential, Gist Heights -----------------------------------
  compoundWall(group, 20.5, -24, 23, 22, 'w', colliders, '#d9d0bf');
  building(group, colliders, landmarks, 23, -24, 12, 14, 3, { facing: 'w', color: '#f0c9a0', sign: 'GIST HEIGHTS', signColors: ['#1b1b1b', '#f5c242'], balconies: true, tank: true, dish: true, gen: true });
  zones.push({ id: 'home', label: 'Gist Heights · Your flat', icon: '🏠', x: 15.4, z: -24, radius: 2.4, prompt: 'Go inside your apartment' });
  lot(20.5, -24, 22.6, 21.6, '#9c9589'); // paved compound
  car(group, 13.5, -18, 0, '#c0392b', colliders);
  car(group, 13.5, -30, 0, '#2c3e50', colliders);
  tree(group, 27, -14.5, 0.9, colliders);
  building(group, colliders, landmarks, 39, -14, 13, 10, 1, { style: 'bungalow', facing: 'e', color: '#cfe3c4', gen: true });
  building(group, colliders, landmarks, 39, -40, 13, 11, 1, { style: 'bungalow', facing: 'e', color: '#e4c067', dish: true });
  building(group, colliders, landmarks, 20, -41, 14, 10, 2, { style: 'duplex', facing: 'n', color: '#f2efe6', balconies: true, gen: true });
  tree(group, 30, -37.5, 1.2, colliders); tree(group, 10.5, -44, 0.9, colliders);

  // ---- SW: food & nightlife --------------------------------------------
  kiosk(group, -13, 16, Math.PI / 2, 'SUYA SPOT', colliders, '#c47c6a');
  // the grill
  box(group, 1.8, 0.9, 0.7, mat('#333', 0.7, 0.3), -13, 0.45, 20.2);
  const coals = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 0.5), new THREE.MeshStandardMaterial({ color: '#ff6a00', emissive: '#ff4500', emissiveIntensity: 1.4 }));
  coals.position.set(-13, 0.92, 20.2); group.add(coals);
  for (let i = 0; i < 6; i++) box(group, 0.08, 0.06, 0.6, mat('#7a3b1e', 0.8), -13.6 + i * 0.25, 0.98, 20.2);
  colliders.push({ minX: -14, maxX: -12, minZ: 19.7, maxZ: 20.7, h: 1 });
  // smoke
  const smokeM = new THREE.SpriteMaterial({ color: '#e8e8e8', transparent: true, opacity: 0.35, depthWrite: false });
  const puffs: THREE.Sprite[] = [];
  for (let i = 0; i < 7; i++) { const s = new THREE.Sprite(smokeM.clone()); s.position.set(-13, 1.2 + i * 0.4, 20.2); s.scale.setScalar(0.4); group.add(s); puffs.push(s); }
  animated.push((dt, t) => { puffs.forEach((p, i) => { p.position.y += dt * 0.6; p.position.x = -13 + Math.sin(t * 1.3 + i) * 0.25; const life = (p.position.y - 1.2) / 3.2; p.scale.setScalar(0.4 + life * 1.1); (p.material as THREE.SpriteMaterial).opacity = Math.max(0, 0.4 - life * 0.4); if (life > 1) p.position.y = 1.2; }); });
  umbrella(group, -17, 14, '#e74c3c'); umbrella(group, -17.5, 20, '#f5c242');
  bench(group, -17, 16.2, 0, colliders); bench(group, -17.5, 22.2, 0, colliders);
  zones.push({ id: 'suya', label: 'Suya Spot', icon: '🍢', x: -10, z: 17.5, radius: 2.4, prompt: 'Buy suya · ₦500' });

  building(group, colliders, landmarks, -32, 15, 13, 10, 1, { style: 'shop', facing: 'n', color: '#e4c067', sign: 'MAMA NKECHI KITCHEN', signColors: ['#2ecc71', '#0b0e0c'] });
  zones.push({ id: 'buka', label: 'Mama Nkechi Kitchen', icon: '🍲', x: -32, z: 8.2, radius: 2.4, prompt: 'Eat · ₦800' });
  building(group, colliders, landmarks, -19, 36, 14, 12, 2, { style: 'lounge', facing: 'e', color: '#1e1526', sign: 'VIBE LOUNGE' });
  zones.push({ id: 'lounge', label: 'Vibe Lounge', icon: '🪩', x: -9.8, z: 36, radius: 2.6, prompt: 'Pull up · ₦1,500' });
  building(group, colliders, landmarks, -39, 33, 12, 12, 3, { facing: 'w', color: '#d6b58a', balconies: true, tank: true });
  building(group, colliders, landmarks, -38, 44, 11, 6, 1, { style: 'bungalow', facing: 's', color: '#b9d5e8' });
  tree(group, -28, 26, 1.1, colliders); palm(group, -26, 44, 1, colliders);

  // ---- SE: the Pitch & Hustle Hub ----------------------------------------
  // notice board / hustle hub
  {
    const g = new THREE.Group(); g.position.set(11.2, 0, 13); g.rotation.y = -Math.PI / 2; group.add(g);
    for (const px of [-1.4, 1.4]) cyl(g, 0.07, 0.07, 2.6, mat('#4b4b4b', 0.6, 0.3), px, 1.3, 0, 8);
    box(g, 3.4, 0.1, 1.2, mat('#2f6f4f', 0.8), 0, 2.7, 0);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.5), new THREE.MeshStandardMaterial({ map: textTexture('HUSTLE HUB', { bg: '#1b1b1b', fg: '#a5ff38', sub: 'jobs posted daily · no 419', subColor: '#f6f8f4' }), roughness: 0.6 }));
    board.position.set(0, 1.7, 0.04); g.add(board);
    box(g, 3.0, 1.7, 0.08, mat('#8a5a2b', 0.9), 0, 1.7, -0.02);
    colliders.push({ minX: 10.5, maxX: 11.9, minZ: 11.4, maxZ: 14.6, h: 2.6 });
    zones.push({ id: 'jobs', label: 'Hustle Hub', icon: '💼', x: 9.4, z: 13, radius: 2.4, prompt: 'Check the job board' });
  }
  // the pitch
  {
    const px = 31, pz = 30, pw = 18, pd = 28;
    const turf = new THREE.Mesh(new THREE.PlaneGeometry(pw, pd), mat('#3f9a4a', 1)); turf.rotation.x = -Math.PI / 2; turf.position.set(px, 0.02, pz); turf.receiveShadow = true; group.add(turf);
    const lineM = mat('#f2f2f2', 0.9);
    const lines: THREE.BufferGeometry[] = [];
    const L = (w: number, d: number, x: number, z: number) => { const g = new THREE.BoxGeometry(w, 0.02, d); g.translate(x, 0.04, z); lines.push(g); };
    L(pw, 0.15, px, pz - pd / 2); L(pw, 0.15, px, pz + pd / 2); L(0.15, pd, px - pw / 2, pz); L(0.15, pd, px + pw / 2, pz); L(pw, 0.15, px, pz);
    L(8, 0.15, px, pz - pd / 2 + 4); L(0.15, 4, px - 4, pz - pd / 2 + 2); L(0.15, 4, px + 4, pz - pd / 2 + 2);
    L(8, 0.15, px, pz + pd / 2 - 4); L(0.15, 4, px - 4, pz + pd / 2 - 2); L(0.15, 4, px + 4, pz + pd / 2 - 2);
    group.add(new THREE.Mesh(mergeGeometries(lines)!, lineM));
    const circle = new THREE.Mesh(new THREE.RingGeometry(2.9, 3.05, 32), lineM); circle.rotation.x = -Math.PI / 2; circle.position.set(px, 0.04, pz); group.add(circle);
    const postM = mat('#f6f6f6', 0.5, 0.2);
    for (const s of [-1, 1]) {
      const gz = pz + s * (pd / 2 - 0.1);
      cyl(group, 0.06, 0.06, 2.0, postM, px - 1.8, 1, gz, 8); cyl(group, 0.06, 0.06, 2.0, postM, px + 1.8, 1, gz, 8);
      box(group, 3.72, 0.12, 0.12, postM, px, 2.0, gz);
      const net = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.0, 1.2), new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.18, roughness: 1 }));
      net.position.set(px, 1.0, gz + s * 0.6); group.add(net);
      colliders.push({ minX: px - 1.9, maxX: px + 1.9, minZ: gz + (s > 0 ? 0 : -1.2), maxZ: gz + (s > 0 ? 1.2 : 0), h: 2 });
    }
    // fence with an opening on the west side
    const fenceM = new THREE.MeshStandardMaterial({ color: '#8fa3a8', transparent: true, opacity: 0.35, side: THREE.DoubleSide, roughness: 0.8 });
    const fh2 = 3.2;
    const fence = (w: number, x: number, z: number, ry: number) => { const f = new THREE.Mesh(new THREE.PlaneGeometry(w, fh2), fenceM); f.position.set(x, fh2 / 2, z); f.rotation.y = ry; group.add(f); };
    fence(pw + 2, px, pz - pd / 2 - 1, 0); fence(pw + 2, px, pz + pd / 2 + 1, 0); fence(pd + 2, px + pw / 2 + 1, pz, Math.PI / 2);
    fence(pd / 2 - 2, px - pw / 2 - 1, pz - pd / 4 - 1.5, Math.PI / 2); fence(pd / 2 - 2, px - pw / 2 - 1, pz + pd / 4 + 1.5, Math.PI / 2);
    colliders.push({ minX: px - pw / 2 - 1.1, maxX: px + pw / 2 + 1.1, minZ: pz - pd / 2 - 1.1, maxZ: pz - pd / 2 - 0.9, h: fh2 });
    colliders.push({ minX: px - pw / 2 - 1.1, maxX: px + pw / 2 + 1.1, minZ: pz + pd / 2 + 0.9, maxZ: pz + pd / 2 + 1.1, h: fh2 });
    colliders.push({ minX: px + pw / 2 + 0.9, maxX: px + pw / 2 + 1.1, minZ: pz - pd / 2 - 1.1, maxZ: pz + pd / 2 + 1.1, h: fh2 });
    colliders.push({ minX: px - pw / 2 - 1.1, maxX: px - pw / 2 - 0.9, minZ: pz - pd / 2 - 1.1, maxZ: pz - 3, h: fh2 });
    colliders.push({ minX: px - pw / 2 - 1.1, maxX: px - pw / 2 - 0.9, minZ: pz + 3, maxZ: pz + pd / 2 + 1.1, h: fh2 });
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; cyl(group, 0.06, 0.06, fh2, mat('#5f6f73', 0.5, 0.4), px + Math.cos(a) * (pw / 2 + 1), fh2 / 2, pz + Math.sin(a) * (pd / 2 + 1), 6); }
    for (const [lx, lz] of [[px - pw / 2 - 1, pz - pd / 2 - 1], [px + pw / 2 + 1, pz - pd / 2 - 1], [px - pw / 2 - 1, pz + pd / 2 + 1], [px + pw / 2 + 1, pz + pd / 2 + 1]]) streetLamp(group, lx, lz, colliders);
    signboard(group, 'THE PITCH', 5, 1.0, px - pw / 2 - 1.2, 3.8, pz, -Math.PI / 2, '#2ecc71', '#0b0e0c', '5-a-side · bring your boots');
    bench(group, px - pw / 2 - 2.5, pz - 6, Math.PI / 2, colliders); bench(group, px - pw / 2 - 2.5, pz + 6, Math.PI / 2, colliders);
    zones.push({ id: 'pitch', label: 'The Pitch', icon: '⚽', x: px - pw / 2 + 2.5, z: pz, radius: 2.8, prompt: 'Play a penalty shootout' });
    landmarks.push({ x: px, z: pz, w: pw, d: pd, color: '#3f9a4a', label: 'THE PITCH' });
  }
  building(group, colliders, landmarks, 13.5, 30, 8, 12, 2, { style: 'duplex', facing: 'w', color: '#f2efe6', balconies: true, gen: true });
  building(group, colliders, landmarks, 13.5, 42, 8, 8, 1, { style: 'bungalow', facing: 'w', color: '#f0c9a0', dish: true });
  kiosk(group, 26, 12.2, Math.PI, 'ZOBO & CHAPMAN', colliders, '#9fc5c8');
  tree(group, 12, 20, 1.0, colliders); tree(group, 44, 12, 1.2, colliders); palm(group, 45, 22, 1, colliders);

  // ---- outer ring (background streets) ----------------------------------
  let seed = 3;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (const s of [-1, 1]) {
    for (let z = -70; z <= 70; z += 14.5) {
      const floors = 2 + Math.floor(rnd() * 4), w = 9 + Math.floor(rnd() * 3), d = 10 + Math.floor(rnd() * 3);
      building(group, colliders, landmarks, s * 64, z, d, w, floors, { facing: s < 0 ? 'e' : 'w', color: PALETTE[Math.floor(rnd() * PALETTE.length)], balconies: rnd() > 0.5, tank: rnd() > 0.5, dish: rnd() > 0.5 });
    }
    for (let x = -42; x <= 42; x += 14.5) {
      const floors = 2 + Math.floor(rnd() * 4), w = 9 + Math.floor(rnd() * 3), d = 10 + Math.floor(rnd() * 3);
      building(group, colliders, landmarks, x, s * 64, w, d, floors, { facing: s < 0 ? 's' : 'n', color: PALETTE[Math.floor(rnd() * PALETTE.length)], balconies: rnd() > 0.5, tank: rnd() > 0.5 });
    }
  }
  // boundary trees (soft edge)
  for (let i = 0; i < 26; i++) { const a = (i / 26) * Math.PI * 2; const rr = 82 + (i % 3) * 3; tree(group, Math.cos(a) * rr, Math.sin(a) * rr, 1.2 + (i % 2) * 0.4); }
  // billboard at the north end of the avenue
  {
    const g = new THREE.Group(); g.position.set(0, 0, -86); group.add(g);
    for (const px of [-3, 3]) cyl(g, 0.15, 0.15, 7, mat('#4b4b4b', 0.6, 0.4), px, 3.5, 0, 8);
    signboard(g, 'GIST', 10, 3.6, 0, 8.5, 0, 0, '#0b0e0c', '#a5ff38', 'YOUR CITY. YOUR STYLE. YOUR STORY.  ·  powered by Crushly');
  }

  // ---- street furniture -----------------------------------------------------
  for (const z of [-66, -50, -34, -16, 14, 28, 46, 62]) streetLamp(group, -8.6, z, colliders);
  for (const z of [-62, -44, -32, -14, 22, 40, 58]) streetLamp(group, 8.6, z, colliders);
  for (const x of [-66, -46, -30, -14, 14, 30, 46, 62]) streetLamp(group, x, -8.6, colliders);
  for (const x of [-62, -42, -24, 16, 36, 54]) streetLamp(group, x, 8.6, colliders);
  car(group, 4.6, 24, 0, '#f1c40f', colliders); car(group, 4.6, 33, 0, '#ecf0f1', colliders);
  car(group, -4.6, -30, Math.PI, '#2980b9', colliders); car(group, 4.6, -46, 0, '#7f8c8d', colliders);
  danfo(group, -4.6, -42, Math.PI, colliders); danfo(group, 30, 4.6, Math.PI / 2, colliders);
  keke(group, 4.6, -13, 0, colliders); keke(group, -24, 4.6, Math.PI / 2, colliders);
  palm(group, -8, -60, 1.2, colliders); palm(group, 8, 60, 1.3, colliders); palm(group, 60, -8, 1, colliders); palm(group, -60, 8, 1.1, colliders);

  // ---- NPC walking loops (on sidewalks) --------------------------------------
  const V = (x: number, z: number) => new THREE.Vector3(x, 0, z);
  const paths: THREE.Vector3[][] = [
    [V(7.5, 12), V(7.5, 46), V(46, 46), V(46, 7.5), V(12, 7.5)],
    [V(-7.5, 12), V(-7.5, 28), V(-10.5, 36), V(-7.5, 46), V(-7.5, 30)],
    [V(7.5, -12), V(7.5, -47), V(46.5, -47), V(46.5, -7.5), V(12, -7.5)],
    [V(-7.5, -12), V(-7.5, -47), V(-46.5, -47), V(-46.5, -7.5), V(-12, -7.5)],
    [V(-7.5, -70), V(-7.5, -12), V(-12, -7.5), V(-70, -7.5)],
    [V(7.5, 70), V(7.5, 12), V(12, 7.5), V(70, 7.5)],
    [V(-9.5, -36), V(-9.5, -44), V(-16, -46.5), V(-27.5, -32), V(-9.5, -28)],
    [V(-10, 22), V(-9.5, 30), V(-9.5, 40), V(-13, 44), V(-9.5, 12)],
  ];

  const deliverySpots = [
    { name: 'Gist Heights gate', x: 7.5, z: -24 },
    { name: 'Mama Nkechi Kitchen', x: -32, z: 7.5 },
    { name: 'Vibe Lounge', x: -9.5, z: 40 },
    { name: 'The Pitch entrance', x: 19, z: 30 },
    { name: 'Mama Bisi Provisions', x: -9.5, z: -37 },
    { name: 'the danfo park', x: 30, z: 7.5 },
    { name: 'QuickCash POS', x: -20, z: -7.5 },
    { name: 'the north billboard', x: 7.5, z: -66 },
  ];

  return { group, colliders, zones, landmarks, roads, paths, spawn: new THREE.Vector3(7.5, 0, 18), deliverySpots, animated, bounds };
}

/** Gradient sky dome + a few drifting clouds. */
export function buildSky(scene: THREE.Scene, animated: World['animated']) {
  const skyGeo = new THREE.SphereGeometry(420, 24, 12);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: new THREE.Color('#3f86d6') }, mid: { value: new THREE.Color('#9fd0ee') }, bottom: { value: new THREE.Color('#f3dfc0') } },
    vertexShader: `varying vec3 vP; void main(){ vP = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vP; void main(){ float h = normalize(vP).y; vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.6)) : mix(mid, bottom, clamp(-h*6.0, 0.0, 1.0)); gl_FragColor = vec4(c, 1.0); }`,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  scene.add(sky);
  const cloudM = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, transparent: true, opacity: 0.9, emissive: '#dfe9f3', emissiveIntensity: 0.3 });
  const clouds: THREE.Group[] = [];
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 12; i++) {
    const g = new THREE.Group();
    const n = 3 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) { const s = new THREE.Mesh(new THREE.SphereGeometry(6 + rnd() * 7, 10, 8), cloudM); s.position.set(k * 8 - n * 4 + rnd() * 3, rnd() * 3, rnd() * 5); s.scale.y = 0.45; g.add(s); }
    g.position.set(-200 + rnd() * 400, 70 + rnd() * 30, -200 + rnd() * 400);
    scene.add(g); clouds.push(g);
  }
  animated.push((dt) => { for (const c of clouds) { c.position.x += dt * 1.2; if (c.position.x > 240) c.position.x = -240; } });
  return sky;
}
