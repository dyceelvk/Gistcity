/**
 * Reusable world props: signboards with real text, palms, lamps, cars, the
 * danfo bus, benches, compound walls, kiosks… All procedural, no asset downloads.
 */
import * as THREE from 'three';
import { mat } from './avatar';

export interface AABB { minX: number; maxX: number; minZ: number; maxZ: number; h: number }

export function box(parent: THREE.Object3D, w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, shadow = true) {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z);
  o.castShadow = shadow; o.receiveShadow = true;
  parent.add(o);
  return o;
}
export function cyl(parent: THREE.Object3D, rt: number, rb: number, h: number, m: THREE.Material, x: number, y: number, z: number, seg = 12) {
  const o = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  o.position.set(x, y, z);
  o.castShadow = true; o.receiveShadow = true;
  parent.add(o);
  return o;
}

/* ------------------------------------------------------------- text sprites */

const texCache = new Map<string, THREE.CanvasTexture>();
export function textTexture(text: string, opts: { bg?: string; fg?: string; font?: string; w?: number; h?: number; pad?: number; sub?: string; subColor?: string } = {}) {
  const key = JSON.stringify([text, opts]);
  const hit = texCache.get(key);
  if (hit) return hit;
  const w = opts.w ?? 512, h = opts.h ?? 128;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  if (opts.bg) { g.fillStyle = opts.bg; g.fillRect(0, 0, w, h); }
  g.fillStyle = opts.fg ?? '#ffffff';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = Math.floor(h * (opts.sub ? 0.42 : 0.55));
  g.font = opts.font ?? `800 ${size}px 'Space Grotesk', 'DM Sans', Arial, sans-serif`;
  while (g.measureText(text).width > w - (opts.pad ?? 24) * 2 && size > 10) { size -= 2; g.font = `800 ${size}px 'Space Grotesk', 'DM Sans', Arial, sans-serif`; }
  g.fillText(text, w / 2, opts.sub ? h * 0.38 : h / 2);
  if (opts.sub) {
    g.fillStyle = opts.subColor ?? opts.fg ?? '#fff';
    g.font = `600 ${Math.floor(h * 0.2)}px 'DM Sans', Arial, sans-serif`;
    g.fillText(opts.sub, w / 2, h * 0.75);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

/** Floating label (name tag / speech bubble) that always faces the camera. */
export function makeSprite(text: string, opts: { bg?: string; fg?: string; scale?: number; sub?: string } = {}) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = opts.sub ? 160 : 112;
  const g = c.getContext('2d')!;
  const radius = 36;
  const rr = (x: number, y: number, w: number, h: number) => { g.beginPath(); g.roundRect(x, y, w, h, radius); g.fill(); };
  g.fillStyle = opts.bg ?? 'rgba(8,12,9,0.82)';
  g.font = `700 44px 'DM Sans', Arial, sans-serif`;
  const tw = Math.min(480, g.measureText(text).width + 60);
  rr((512 - tw) / 2, 8, tw, c.height - 16);
  g.fillStyle = opts.fg ?? '#ffffff';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 256, opts.sub ? 56 : c.height / 2, 460);
  if (opts.sub) { g.font = `600 28px 'DM Sans', Arial, sans-serif`; g.fillStyle = '#a5ff38'; g.fillText(opts.sub, 256, 112, 460); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  const sc = opts.scale ?? 1;
  s.scale.set(1.6 * sc, (c.height / 512) * 1.6 * sc, 1);
  return s;
}

/** A shop sign: a plane with text and a thin backing board. */
export function signboard(parent: THREE.Object3D, text: string, w: number, h: number, x: number, y: number, z: number, rotY: number, bg = '#f5c242', fg = '#111', sub?: string) {
  const g = new THREE.Group();
  g.position.set(x, y, z); g.rotation.y = rotY;
  box(g, w, h, 0.08, mat(bg, 0.7), 0, 0, 0);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.1, h - 0.1), new THREE.MeshStandardMaterial({ map: textTexture(text, { bg, fg, sub, w: 1024, h: Math.round(1024 * (h / w)) }), roughness: 0.6 }));
  face.position.z = 0.045;
  g.add(face);
  parent.add(g);
  return g;
}

/* ------------------------------------------------------------------ nature */

export function palm(parent: THREE.Object3D, x: number, z: number, scale = 1, colliders?: AABB[]) {
  const g = new THREE.Group();
  g.position.set(x, 0, z); g.scale.setScalar(scale);
  const trunkM = mat('#7a5a3a', 0.95);
  const segs = 5;
  for (let i = 0; i < segs; i++) {
    const t = cyl(g, 0.14 - i * 0.012, 0.17 - i * 0.012, 1.0, trunkM, Math.sin(i * 0.5) * 0.08 * i, 0.5 + i, 0, 7);
    t.rotation.z = -0.05 * i;
  }
  const topY = segs + 0.2, topX = Math.sin(segs * 0.5) * 0.08 * (segs - 1);
  const leafM = mat('#3f8a4a', 0.9);
  for (let i = 0; i < 8; i++) {
    const leaf = box(g, 0.35, 0.06, 2.6, leafM, topX, topY, 0);
    leaf.geometry.translate(0, 0, 1.2);
    leaf.rotation.y = (i / 8) * Math.PI * 2;
    leaf.rotation.x = -0.45 - (i % 2) * 0.2;
  }
  const nutM = mat('#5c3d1f', 0.9);
  for (let i = 0; i < 3; i++) { const n = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), nutM); n.position.set(topX + Math.sin(i) * 0.2, topY - 0.15, Math.cos(i) * 0.2); g.add(n); }
  parent.add(g);
  colliders?.push({ minX: x - 0.3, maxX: x + 0.3, minZ: z - 0.3, maxZ: z + 0.3, h: 1 });
  return g;
}

export function tree(parent: THREE.Object3D, x: number, z: number, scale = 1, colliders?: AABB[]) {
  const g = new THREE.Group();
  g.position.set(x, 0, z); g.scale.setScalar(scale);
  cyl(g, 0.18, 0.26, 2.2, mat('#5b4330', 0.95), 0, 1.1, 0, 8);
  const leafM = mat('#2f7a3e', 0.9);
  const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.7, 1), leafM);
  crown.position.y = 3.1; crown.castShadow = true; g.add(crown);
  const c2 = new THREE.Mesh(new THREE.IcosahedronGeometry(1.2, 1), mat('#3a8f4a', 0.9));
  c2.position.set(0.8, 3.6, 0.4); c2.castShadow = true; g.add(c2);
  parent.add(g);
  colliders?.push({ minX: x - 0.35, maxX: x + 0.35, minZ: z - 0.35, maxZ: z + 0.35, h: 1 });
  return g;
}

/* ------------------------------------------------------------- street stuff */

export function streetLamp(parent: THREE.Object3D, x: number, z: number, colliders?: AABB[]) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const m = mat('#3a3f3d', 0.6, 0.4);
  cyl(g, 0.06, 0.09, 5, m, 0, 2.5, 0, 8);
  box(g, 0.08, 0.08, 1.2, m, 0, 5, 0.55);
  const lampM = new THREE.MeshStandardMaterial({ color: '#fff4cf', emissive: '#ffe9a8', emissiveIntensity: 0.9, roughness: 0.4 });
  box(g, 0.3, 0.12, 0.5, lampM, 0, 4.95, 1.1);
  parent.add(g);
  colliders?.push({ minX: x - 0.15, maxX: x + 0.15, minZ: z - 0.15, maxZ: z + 0.15, h: 1 });
}

export function bench(parent: THREE.Object3D, x: number, z: number, rotY: number, colliders?: AABB[]) {
  const g = new THREE.Group();
  g.position.set(x, 0, z); g.rotation.y = rotY;
  const wood = mat('#8a5a2b', 0.9), metal = mat('#2c2f2e', 0.6, 0.3);
  box(g, 1.6, 0.06, 0.45, wood, 0, 0.45, 0);
  box(g, 1.6, 0.4, 0.05, wood, 0, 0.7, -0.22);
  box(g, 0.05, 0.45, 0.45, metal, -0.7, 0.22, 0);
  box(g, 0.05, 0.45, 0.45, metal, 0.7, 0.22, 0);
  parent.add(g);
  colliders?.push({ minX: x - 0.8, maxX: x + 0.8, minZ: z - 0.3, maxZ: z + 0.3, h: 0.8 });
}

export function car(parent: THREE.Object3D, x: number, z: number, rotY: number, color: string, colliders?: AABB[]) {
  const g = new THREE.Group();
  g.position.set(x, 0, z); g.rotation.y = rotY;
  const body = mat(color, 0.35, 0.5), glass = mat('#1f3238', 0.1, 0.6), tyre = mat('#111', 0.9), rim = mat('#c9c9c9', 0.3, 0.8);
  box(g, 1.8, 0.55, 4.2, body, 0, 0.55, 0);
  box(g, 1.6, 0.5, 2.2, body, 0, 1.05, -0.1);
  box(g, 1.62, 0.36, 2.0, glass, 0, 1.08, -0.1);
  for (const [wx, wz] of [[-0.85, 1.35], [0.85, 1.35], [-0.85, -1.35], [0.85, -1.35]]) {
    const t = cyl(g, 0.32, 0.32, 0.25, tyre, wx, 0.32, wz, 12); t.rotation.z = Math.PI / 2;
    const r = cyl(g, 0.18, 0.18, 0.27, rim, wx, 0.32, wz, 8); r.rotation.z = Math.PI / 2;
  }
  box(g, 0.3, 0.15, 0.05, mat('#fff4cf', 0.3), -0.6, 0.6, 2.1); box(g, 0.3, 0.15, 0.05, mat('#fff4cf', 0.3), 0.6, 0.6, 2.1);
  box(g, 0.3, 0.12, 0.05, mat('#c0392b', 0.3), -0.6, 0.6, -2.1); box(g, 0.3, 0.12, 0.05, mat('#c0392b', 0.3), 0.6, 0.6, -2.1);
  parent.add(g);
  const cs = Math.abs(Math.cos(rotY)), sn = Math.abs(Math.sin(rotY));
  const hw = 0.9 * cs + 2.1 * sn, hd = 0.9 * sn + 2.1 * cs;
  colliders?.push({ minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd, h: 1.4 });
}

/** The yellow Lagos danfo. */
export function danfo(parent: THREE.Object3D, x: number, z: number, rotY: number, colliders?: AABB[]) {
  const g = new THREE.Group();
  g.position.set(x, 0, z); g.rotation.y = rotY;
  const yellow = mat('#f2c01d', 0.5), black = mat('#141414', 0.7), glass = mat('#243a3f', 0.1, 0.5), tyre = mat('#111', 0.9);
  box(g, 2.0, 1.9, 4.8, yellow, 0, 1.35, 0);
  box(g, 2.04, 0.2, 4.84, black, 0, 1.2, 0); // the black stripe
  box(g, 2.04, 0.6, 1.2, glass, 0, 1.7, 1.6);
  box(g, 0.05, 0.5, 3.2, glass, 1.02, 1.7, -0.5); box(g, 0.05, 0.5, 3.2, glass, -1.02, 1.7, -0.5);
  for (const [wx, wz] of [[-0.95, 1.5], [0.95, 1.5], [-0.95, -1.5], [0.95, -1.5]]) { const t = cyl(g, 0.36, 0.36, 0.3, tyre, wx, 0.36, wz, 12); t.rotation.z = Math.PI / 2; }
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.3), new THREE.MeshStandardMaterial({ map: textTexture('OSHODI - CMS', { bg: '#f2c01d', fg: '#111' }), roughness: 0.6 }));
  sign.position.set(0, 2.1, 2.41); g.add(sign);
  parent.add(g);
  const cs = Math.abs(Math.cos(rotY)), sn = Math.abs(Math.sin(rotY));
  const hw = 1.0 * cs + 2.4 * sn, hd = 1.0 * sn + 2.4 * cs;
  colliders?.push({ minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd, h: 2.3 });
}

export function keke(parent: THREE.Object3D, x: number, z: number, rotY: number, colliders?: AABB[]) {
  const g = new THREE.Group();
  g.position.set(x, 0, z); g.rotation.y = rotY;
  const y = mat('#f2c01d', 0.5), blk = mat('#141414', 0.7);
  box(g, 1.2, 0.9, 2.2, y, 0, 0.75, 0);
  box(g, 1.25, 0.1, 2.3, blk, 0, 1.3, 0);
  for (const [px, pz] of [[-0.55, 0.9], [0.55, 0.9], [-0.55, -0.9], [0.55, -0.9]]) cyl(g, 0.03, 0.03, 0.9, blk, px, 1.0, pz, 6);
  const t = cyl(g, 0.25, 0.25, 0.15, blk, 0, 0.25, 1.1, 10); t.rotation.z = Math.PI / 2;
  for (const wx of [-0.55, 0.55]) { const w = cyl(g, 0.25, 0.25, 0.15, blk, wx, 0.25, -0.8, 10); w.rotation.z = Math.PI / 2; }
  parent.add(g);
  colliders?.push({ minX: x - 1.2, maxX: x + 1.2, minZ: z - 1.2, maxZ: z + 1.2, h: 1.4 });
}

/** Low compound wall with a gate, around a lot. */
export function compoundWall(parent: THREE.Object3D, cx: number, cz: number, w: number, d: number, gateSide: 'n' | 's' | 'e' | 'w', colliders?: AABB[], color = '#cfc6b4') {
  const m = mat(color, 0.95), capM = mat('#8d8a7f', 0.9), gateM = mat('#2f3f4a', 0.5, 0.5);
  const h = 1.9, t = 0.22, gate = 3.2;
  const seg = (x: number, z: number, len: number, alongX: boolean) => {
    box(parent, alongX ? len : t, h, alongX ? t : len, m, x, h / 2, z);
    box(parent, alongX ? len : t + 0.08, 0.1, alongX ? t + 0.08 : len, capM, x, h + 0.05, z);
    colliders?.push(alongX
      ? { minX: x - len / 2, maxX: x + len / 2, minZ: z - t / 2, maxZ: z + t / 2, h }
      : { minX: x - t / 2, maxX: x + t / 2, minZ: z - len / 2, maxZ: z + len / 2, h });
  };
  const side = (s: 'n' | 's' | 'e' | 'w') => {
    const alongX = s === 'n' || s === 's';
    const len = alongX ? w : d;
    const x = s === 'e' ? cx + w / 2 : s === 'w' ? cx - w / 2 : cx;
    const z = s === 'n' ? cz - d / 2 : s === 's' ? cz + d / 2 : cz;
    if (s !== gateSide) { seg(x, z, len, alongX); return; }
    const half = (len - gate) / 2;
    if (alongX) { seg(x - gate / 2 - half / 2, z, half, true); seg(x + gate / 2 + half / 2, z, half, true); }
    else { seg(x, z - gate / 2 - half / 2, half, false); seg(x, z + gate / 2 + half / 2, half, false); }
    // gate pillars + open gate leaf
    const px = alongX ? [x - gate / 2, x + gate / 2] : [x, x];
    const pz = alongX ? [z, z] : [z - gate / 2, z + gate / 2];
    for (let i = 0; i < 2; i++) { box(parent, 0.4, 2.3, 0.4, capM, px[i], 1.15, pz[i]); }
    const leaf = box(parent, alongX ? 0.06 : 1.4, 1.7, alongX ? 1.4 : 0.06, gateM, px[0] + (alongX ? 0 : 0.7) , 0.9, pz[0] + (alongX ? 0.7 : 0));
    leaf.castShadow = true;
  };
  (['n', 's', 'e', 'w'] as const).forEach(side);
}

export function kiosk(parent: THREE.Object3D, x: number, z: number, rotY: number, title: string, colliders?: AABB[], color = '#e0a84b') {
  const g = new THREE.Group();
  g.position.set(x, 0, z); g.rotation.y = rotY;
  box(g, 2.8, 2.3, 2.2, mat(color, 0.85), 0, 1.15, 0);
  box(g, 3.1, 0.15, 2.5, mat('#5a5b50', 0.9), 0, 2.37, 0);
  box(g, 1.4, 0.8, 0.06, mat('#2a3a3a', 0.3, 0.3), 0, 1.45, 1.12);
  box(g, 3.0, 0.12, 0.7, mat('#6b4a2b', 0.9), 0, 0.95, 1.4);
  const awn = box(g, 3.2, 0.06, 1.4, mat('#a5ff38', 0.8), 0, 2.2, 1.6); awn.rotation.x = 0.25;
  signboard(g, title, 2.6, 0.5, 0, 2.75, 0.2, 0, '#1b1b1b', '#a5ff38');
  // goods
  for (let i = 0; i < 5; i++) box(g, 0.22, 0.3, 0.22, mat(['#e74c3c', '#3498db', '#f1c40f', '#2ecc71', '#ecf0f1'][i], 0.6), -1.1 + i * 0.5, 1.15, 1.4);
  parent.add(g);
  colliders?.push({ minX: x - 1.7, maxX: x + 1.7, minZ: z - 1.4, maxZ: z + 1.7, h: 2.4 });
  return g;
}

export function umbrella(parent: THREE.Object3D, x: number, z: number, color = '#e74c3c') {
  const g = new THREE.Group(); g.position.set(x, 0, z);
  cyl(g, 0.03, 0.03, 2.4, mat('#cfcfcf', 0.4, 0.6), 0, 1.2, 0, 6);
  const top = new THREE.Mesh(new THREE.ConeGeometry(1.4, 0.5, 10, 1, true), new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.8 }));
  top.position.y = 2.45; top.castShadow = true; g.add(top);
  parent.add(g);
}

export function generator(parent: THREE.Object3D, x: number, z: number, rotY = 0) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rotY;
  box(g, 0.9, 0.7, 0.6, mat('#2d6b3f', 0.6, 0.2), 0, 0.35, 0);
  box(g, 0.3, 0.3, 0.3, mat('#c0392b', 0.5), -0.2, 0.85, 0);
  cyl(g, 0.04, 0.04, 0.5, mat('#333', 0.6), 0.35, 0.95, 0, 6);
  parent.add(g);
}

export function waterTank(parent: THREE.Object3D, x: number, y: number, z: number) {
  const g = new THREE.Group(); g.position.set(x, y, z);
  const m = mat('#2c2c2c', 0.6);
  for (const [lx, lz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) cyl(g, 0.04, 0.04, 1.4, m, lx, 0.7, lz, 6);
  cyl(g, 0.75, 0.75, 1.1, m, 0, 1.95, 0, 14);
  cyl(g, 0.0, 0.75, 0.3, m, 0, 2.65, 0, 14);
  parent.add(g);
}

export function satelliteDish(parent: THREE.Object3D, x: number, y: number, z: number) {
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 8, 0, Math.PI * 2, 0, Math.PI / 3), mat('#dcdcdc', 0.4, 0.3));
  dish.position.set(x, y, z); dish.rotation.x = -Math.PI / 2 + 0.7; dish.scale.y = 0.4;
  parent.add(dish);
}
