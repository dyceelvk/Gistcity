/**
 * Reusable world props: signboards with real text, palms, lamps, cars, the
 * danfo bus, benches, compound walls, kiosks… All procedural, no asset downloads.
 */
import * as THREE from 'three';
import { mat } from './avatar';
import { barkTex, leafTex, frondTex, wallMaterial, tiledRoofMaterial } from './textures';

/** Tile textured box faces at a consistent world scale (one repeat ≈ `tile` metres). */
export function scaleBoxUVs(geo: THREE.BoxGeometry, w: number, h: number, d: number, tile = 3) {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = dims[f]!;
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * (su / tile), uv.getY(k) * (sv / tile));
    }
  }
  uv.needsUpdate = true;
}

export interface AABB { minX: number; maxX: number; minZ: number; maxZ: number; h: number }

export function box(parent: THREE.Object3D, w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, shadow = true) {
  const geo = new THREE.BoxGeometry(w, h, d);
  scaleBoxUVs(geo, w, h, d);
  const o = new THREE.Mesh(geo, m);
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
  const trunkM = new THREE.MeshStandardMaterial({ map: barkTex('#8a6a48'), roughness: 0.95, metalness: 0.02 });
  // curved, tapered trunk
  const segs = 6;
  for (let i = 0; i < segs; i++) {
    const t = cyl(g, 0.16 - i * 0.013, 0.21 - i * 0.013, 1.08, trunkM, Math.sin(i * 0.42) * 0.10 * i, 0.52 + i * 1.0, 0, 9);
    t.rotation.z = -0.045 * i;
  }
  const topY = segs * 1.0 + 0.3, topX = Math.sin((segs - 1) * 0.42) * 0.10 * (segs - 1);
  // fronds: alpha-cutout planes that rise then droop — real palm silhouette
  const frondM = new THREE.MeshStandardMaterial({ map: frondTex(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.88, metalness: 0 });
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.22;
    const geo = new THREE.PlaneGeometry(3.1, 1.15, 6, 1);
    geo.translate(1.55, 0, 0);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let v = 0; v < pos.count; v++) {
      const t = Math.min(1, Math.max(0, pos.getX(v) / 3.1));
      pos.setY(v, pos.getY(v) + 0.5 * t - 1.25 * t * t);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    const f = new THREE.Mesh(geo, frondM);
    f.position.set(topX, topY - 0.05, 0);
    f.rotation.y = a - Math.PI / 2;
    f.castShadow = true;
    g.add(f);
  }
  // crown tuft + coconuts
  const tuft = new THREE.Mesh(new THREE.SphereGeometry(0.34, 9, 7), mat('#2c6b3c', 0.92));
  tuft.position.set(topX, topY + 0.12, 0); tuft.castShadow = true; g.add(tuft);
  const nutM = mat('#5c3d1f', 0.9);
  for (let i = 0; i < 3; i++) {
    const n = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), nutM);
    n.position.set(topX + Math.sin(i * 2.1) * 0.2, topY - 0.22, Math.cos(i * 2.1) * 0.2);
    g.add(n);
  }
  parent.add(g);
  colliders?.push({ minX: x - 0.3, maxX: x + 0.3, minZ: z - 0.3, maxZ: z + 0.3, h: 1 });
  return g;
}

export function tree(parent: THREE.Object3D, x: number, z: number, scale = 1, colliders?: AABB[]) {
  const g = new THREE.Group();
  g.position.set(x, 0, z); g.scale.setScalar(scale);
  const trunkM = new THREE.MeshStandardMaterial({ map: barkTex('#5e4632'), roughness: 0.95, metalness: 0.02 });
  cyl(g, 0.36, 0.52, 0.4, trunkM, 0, 0.18, 0, 9);       // root flare
  cyl(g, 0.18, 0.3, 2.7, trunkM, 0, 1.45, 0, 9);        // trunk
  const branch = cyl(g, 0.09, 0.13, 1.15, trunkM, 0.42, 2.9, 0.12, 7);
  branch.rotation.z = -0.85;
  // dark inner mass so the crown has volume from every angle
  const coreM = mat('#22542e', 0.95);
  for (const [cx, cy, cz, r] of [[0, 3.55, 0, 1.3], [0.78, 3.85, 0.32, 0.95], [-0.72, 3.7, -0.36, 0.92], [0.12, 4.35, -0.12, 0.88]] as const) {
    const c = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), coreM);
    c.position.set(cx, cy, cz); c.castShadow = true; g.add(c);
  }
  // crossed leafy billboards — organic silhouette, cheap to draw
  const leafM = new THREE.MeshStandardMaterial({ map: leafTex(), alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.92, metalness: 0 });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI;
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(4.1, 3.8), leafM);
    pl.position.set(Math.sin(a + Math.PI / 2) * 0.18, 3.8, Math.cos(a + Math.PI / 2) * 0.18);
    pl.rotation.y = a;
    pl.castShadow = true;
    g.add(pl);
  }
  parent.add(g);
  colliders?.push({ minX: x - 0.35, maxX: x + 0.35, minZ: z - 0.35, maxZ: z + 0.35, h: 1 });
  return g;
}

/** Low garden shrub — crossed leaf billboards over a dark core. */
export function bush(parent: THREE.Object3D, x: number, z: number, scale = 1, hue = 0) {
  const g = new THREE.Group();
  g.position.set(x, 0, z); g.scale.setScalar(scale);
  const coreM = mat(hue ? '#2a5c2f' : '#24542e', 0.95);
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 1), coreM);
  core.position.y = 0.5; core.scale.set(1, 0.8, 1); core.castShadow = true; g.add(core);
  const leafM = new THREE.MeshStandardMaterial({ map: leafTex(), alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.92, metalness: 0 });
  for (let i = 0; i < 3; i++) {
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.5), leafM);
    pl.position.y = 0.62;
    pl.rotation.y = (i / 3) * Math.PI;
    pl.castShadow = true;
    g.add(pl);
  }
  parent.add(g);
  return g;
}

/* ------------------------------------------------------------- street stuff */

/** Shared street-light material: the day/night cycle raises its emissive intensity after dusk. */
export const LAMP_MAT = new THREE.MeshStandardMaterial({ color: '#fff4cf', emissive: '#ffe9a8', emissiveIntensity: 0.9, roughness: 0.4 });
LAMP_MAT.userData.live = true;

export function streetLamp(parent: THREE.Object3D, x: number, z: number, colliders?: AABB[]) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const m = mat('#3a3f3d', 0.6, 0.4);
  cyl(g, 0.06, 0.09, 5, m, 0, 2.5, 0, 8);
  box(g, 0.08, 0.08, 1.2, m, 0, 5, 0.55);
  box(g, 0.3, 0.12, 0.5, LAMP_MAT, 0, 4.95, 1.1);
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
  const paint = mat(color, 0.28, 0.62), dark = mat('#15181c', 0.5, 0.4), glass = mat('#141f28', 0.08, 0.75),
    tyre = mat('#0d0e10', 0.85), rim = mat('#cdd2d6', 0.22, 0.9),
    trim = mat('#0a0c0e', 0.55, 0.3);
  const lightF = new THREE.MeshStandardMaterial({ color: '#eef2ff', emissive: '#cfe0ff', emissiveIntensity: 0.85, roughness: 0.25 });
  const lightR = new THREE.MeshStandardMaterial({ color: '#ff2d3e', emissive: '#ff2233', emissiveIntensity: 0.9, roughness: 0.3 });

  // lower body — long, low, slightly tapered
  box(g, 1.86, 0.52, 4.45, paint, 0, 0.52, 0);
  // hood + trunk slopes (thin wedges)
  const hood = box(g, 1.78, 0.2, 1.25, paint, 0, 0.83, 1.55); hood.rotation.x = -0.1;
  const trunk = box(g, 1.78, 0.2, 1.05, paint, 0, 0.84, -1.7); trunk.rotation.x = 0.12;
  // cabin glasshouse — raked windscreen, blacked pillars
  const cab = box(g, 1.62, 0.56, 2.35, glass, 0, 1.12, -0.18); cab.rotation.x = 0.02;
  const roof = box(g, 1.5, 0.1, 1.7, paint, 0, 1.42, -0.35);
  const wind = box(g, 1.55, 0.06, 0.95, glass, 0, 1.1, 1.05); wind.rotation.x = -0.62;
  const rear = box(g, 1.55, 0.06, 0.8, glass, 0, 1.12, -1.42); rear.rotation.x = 0.55;
  // rocker + bumper trims
  box(g, 1.9, 0.14, 3.1, trim, 0, 0.3, 0);
  box(g, 1.86, 0.22, 0.5, trim, 0, 0.48, 2.18);
  box(g, 1.86, 0.22, 0.5, trim, 0, 0.48, -2.18);
  // wheel arches
  for (const [wx, wz] of [[-0.93, 1.32], [0.93, 1.32], [-0.93, -1.32], [0.93, -1.32]]) {
    box(g, 0.12, 0.42, 1.05, trim, wx, 0.42, wz);
    const t = cyl(g, 0.335, 0.335, 0.26, tyre, wx * 0.98, 0.335, wz, 14); t.rotation.z = Math.PI / 2;
    const r = cyl(g, 0.2, 0.2, 0.28, rim, wx * 0.98, 0.335, wz, 10); r.rotation.z = Math.PI / 2;
    const hub = cyl(g, 0.07, 0.07, 0.3, dark, wx * 0.98, 0.335, wz, 8); hub.rotation.z = Math.PI / 2;
  }
  // lights — slim modern bars
  for (const lx of [-0.58, 0.58]) {
    box(g, 0.52, 0.11, 0.06, lightF, lx, 0.72, 2.235);
    box(g, 0.55, 0.1, 0.06, lightR, lx, 0.74, -2.235);
  }
  // grille + mirrors + door seam
  box(g, 1.2, 0.16, 0.05, trim, 0, 0.55, 2.24);
  for (const mx of [-1.02, 1.02]) box(g, 0.22, 0.1, 0.14, trim, mx, 1.05, 0.72);
  box(g, 0.03, 0.5, 1.7, trim, 0, 0.72, -0.25);
  parent.add(g);
  const cs = Math.abs(Math.cos(rotY)), sn = Math.abs(Math.sin(rotY));
  const hw = 0.9 * cs + 2.1 * sn, hd = 0.9 * sn + 2.1 * cs;
  colliders?.push({ minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd, h: 1.4 });
  return g;
}

/** The yellow Lagos danfo. */
export function danfo(parent: THREE.Object3D, x: number, z: number, rotY: number, colliders?: AABB[]) {
  const g = new THREE.Group();
  g.position.set(x, 0, z); g.rotation.y = rotY;
  const yellow = mat('#f2c01d', 0.38, 0.45), black = mat('#141414', 0.55, 0.3), glass = mat('#152229', 0.1, 0.7), tyre = mat('#0d0e10', 0.85);
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
  return g;
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
  return g;
}

/** Low compound wall with a gate, around a lot. */
export function compoundWall(parent: THREE.Object3D, cx: number, cz: number, w: number, d: number, gateSide: 'n' | 's' | 'e' | 'w', colliders?: AABB[], color = '#cfc6b4') {
  const m = wallMaterial(color), capM = mat('#8d8a7f', 0.9), gateM = mat('#2f3f4a', 0.5, 0.5);
  const bandM = wallMaterial('#b3a68f');
  const h = 1.9, t = 0.22, gate = 3.2;
  const seg = (x: number, z: number, len: number, alongX: boolean) => {
    box(parent, alongX ? len : t, h, alongX ? t : len, m, x, h / 2, z);
    box(parent, alongX ? len : t + 0.06, 0.55, alongX ? t + 0.06 : len, bandM, x, 0.28, z); // painted base band
    box(parent, alongX ? len : t + 0.08, 0.1, alongX ? t + 0.08 : len, capM, x, h + 0.05, z);
    // piers every ~3.5 m so the run never reads as one blank slab
    const n = Math.max(1, Math.round(len / 3.5));
    for (let i = 0; i <= n; i++) {
      const off = -len / 2 + (i / n) * len;
      const px = alongX ? x + off : x, pz = alongX ? z : z + off;
      box(parent, 0.38, h + 0.32, 0.38, m, px, (h + 0.32) / 2, pz);
      box(parent, 0.5, 0.12, 0.5, capM, px, h + 0.36, pz);
    }
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
