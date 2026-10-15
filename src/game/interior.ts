/**
 * Your flat at Gist Heights — a separate little scene the player teleports
 * into. Owned furniture is placed here; a wardrobe opens the Style Studio.
 */
import * as THREE from 'three';
import { mat } from './avatar';
import { AABB, box, cyl, textTexture } from './props';
import type { Zone } from './world';

/** Where the bed / mattress stands (also used to lay the character down). */
export const BED_SPOT = { x: -2.0, z: -3.3 };

export interface Interior {
  group: THREE.Group;
  colliders: AABB[];
  zones: Zone[];
  spawn: THREE.Vector3;
  spawnYaw: number;
  setFurniture(placed: string[]): void;
  light: THREE.PointLight;
}

function tileTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d9d2c3'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#b9b2a3'; g.lineWidth = 3;
  for (let i = 0; i <= 256; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(5, 4); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function ankaraTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 192;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1f3a93'; g.fillRect(0, 0, 256, 192);
  const cols = ['#f5c242', '#e33e79', '#2ecc71', '#f4f0e7'];
  for (let y = 0; y < 192; y += 32) for (let x = 0; x < 256; x += 32) {
    g.fillStyle = cols[((x + y) / 32) % cols.length];
    g.beginPath(); g.moveTo(x, y + 32); g.lineTo(x + 16, y); g.lineTo(x + 32, y + 32); g.closePath(); g.fill();
    g.fillStyle = '#0b0e0c'; g.beginPath(); g.arc(x + 16, y + 20, 4, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function skylineTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 320;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 320); grad.addColorStop(0, '#ff9a5c'); grad.addColorStop(0.6, '#ffd59e'); grad.addColorStop(1, '#5e3a6b');
  g.fillStyle = grad; g.fillRect(0, 0, 512, 320);
  g.fillStyle = '#ffe9a8'; g.beginPath(); g.arc(380, 120, 40, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#1b1430';
  let x = 0; let s = 7;
  while (x < 512) { s = (s * 16807) % 2147483647; const w = 20 + (s % 40); const h = 60 + (s % 160); g.fillRect(x, 320 - h, w, h); x += w + 6; }
  g.fillRect(0, 300, 512, 20);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function buildInterior(): Interior {
  const group = new THREE.Group();
  group.visible = false;
  const colliders: AABB[] = [];
  const W = 11, D = 9, H = 3.1;
  const BED = BED_SPOT;

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: tileTexture(), roughness: 0.6 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; group.add(floor);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, D), mat('#f3f0ea', 1));
  ceiling.rotation.x = Math.PI / 2; ceiling.position.y = H; group.add(ceiling);

  const wallM = mat('#efe6d6', 0.95), accentM = mat('#2f6f4f', 0.95), skirtM = mat('#6b4a2b', 0.8);
  const wall = (w: number, d: number, x: number, z: number, m = wallM) => {
    box(group, w, H, d, m, x, H / 2, z);
    colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, h: H });
    box(group, w + 0.02, 0.12, d + 0.02, skirtM, x, 0.06, z);
  };
  wall(W + 0.6, 0.3, 0, -D / 2 - 0.15, accentM); // back (window wall, accent colour)
  wall(0.3, D + 0.6, -W / 2 - 0.15, 0);
  wall(0.3, D + 0.6, W / 2 + 0.15, 0);
  // front wall with a door gap
  wall(W / 2 - 1.0, 0.3, -W / 4 - 0.5, D / 2 + 0.15);
  wall(W / 2 - 1.0, 0.3, W / 4 + 0.5, D / 2 + 0.15);
  box(group, 2.0, 0.5, 0.3, wallM, 0, H - 0.25, D / 2 + 0.15); // lintel
  // door frame + open door leaf
  box(group, 0.1, 2.6, 0.34, skirtM, -1.0, 1.3, D / 2 + 0.15); box(group, 0.1, 2.6, 0.34, skirtM, 1.0, 1.3, D / 2 + 0.15);
  const leaf = box(group, 0.95, 2.5, 0.06, mat('#5a3b2a', 0.7), -1.0 + 0.47, 1.25, D / 2 + 0.6); leaf.rotation.y = -1.2; leaf.position.x = -0.6;

  // window on the back wall with a sunset view
  const view = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.0), new THREE.MeshBasicMaterial({ map: skylineTexture() }));
  view.position.set(1.5, 1.7, -D / 2 - 0.02); group.add(view);
  const frameM = mat('#f6f1e4', 0.6);
  box(group, 3.8, 0.1, 0.12, frameM, 1.5, 2.75, -D / 2 + 0.03); box(group, 3.8, 0.1, 0.12, frameM, 1.5, 0.65, -D / 2 + 0.03);
  box(group, 0.1, 2.2, 0.12, frameM, -0.4, 1.7, -D / 2 + 0.03); box(group, 0.1, 2.2, 0.12, frameM, 3.4, 1.7, -D / 2 + 0.03); box(group, 0.06, 2.2, 0.1, frameM, 1.5, 1.7, -D / 2 + 0.03);
  // curtains
  box(group, 0.5, 2.4, 0.08, mat('#c47c6a', 0.9), -0.75, 1.6, -D / 2 + 0.12); box(group, 0.5, 2.4, 0.08, mat('#c47c6a', 0.9), 3.75, 1.6, -D / 2 + 0.12);

  // wardrobe (always there)
  box(group, 1.8, 2.3, 0.7, mat('#8a5a2b', 0.8), -4.5, 1.15, -3.9);
  box(group, 0.04, 2.1, 0.02, mat('#d8b46a', 0.4, 0.8), -4.5, 1.15, -3.52);
  for (const hx of [-4.75, -4.25]) cyl(group, 0.03, 0.03, 0.2, mat('#d8b46a', 0.4, 0.8), hx, 1.1, -3.5, 6);
  colliders.push({ minX: -5.4, maxX: -3.6, minZ: -4.25, maxZ: -3.55, h: 2.3 });
  // kitchenette counter (always there)
  box(group, 0.7, 0.9, 3.0, mat('#3b3a36', 0.6), -5.0, 0.45, 2.3);
  box(group, 0.75, 0.06, 3.05, mat('#cfcac0', 0.4), -5.0, 0.93, 2.3);
  cyl(group, 0.18, 0.18, 0.25, mat('#2a2a2a', 0.5), -5.0, 1.08, 1.6, 12);
  colliders.push({ minX: -5.4, maxX: -4.6, minZ: 0.8, maxZ: 3.8, h: 1 });

  const light = new THREE.PointLight('#ffe7c2', 0, 18, 1.6);
  light.position.set(0, H - 0.3, 0);
  group.add(light);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshStandardMaterial({ color: '#fff6dd', emissive: '#fff1c8', emissiveIntensity: 1.2 }));
  bulb.position.set(0, H - 0.2, 0); group.add(bulb);

  // ---- furniture ----------------------------------------------------------
  const furniture = new THREE.Group();
  group.add(furniture);
  const furnitureColliders: AABB[] = [];
  const build: Record<string, (g: THREE.Group, c: AABB[]) => void> = {
    bed: (g, c) => {
      box(g, 2.0, 0.35, 1.9, mat('#6b4a2b', 0.9), BED.x, 0.18, BED.z);
      box(g, 1.9, 0.3, 1.8, mat('#f4f0e7', 0.9), BED.x, 0.5, BED.z);
      box(g, 1.9, 0.12, 1.1, mat('#2f6f4f', 0.9), BED.x, 0.7, BED.z + 0.3);
      box(g, 0.7, 0.14, 0.45, mat('#ffffff', 0.9), BED.x - 0.45, 0.72, BED.z - 0.65); box(g, 0.7, 0.14, 0.45, mat('#ffffff', 0.9), BED.x + 0.45, 0.72, BED.z - 0.65);
      box(g, 2.0, 1.1, 0.12, mat('#6b4a2b', 0.9), BED.x, 0.6, BED.z - 1.0);
      c.push({ minX: BED.x - 1.0, maxX: BED.x + 1.0, minZ: BED.z - 1.0, maxZ: BED.z + 0.95, h: 0.8 });
    },
    sofa: (g, c) => {
      const m = mat('#7a2d5b', 0.95);
      box(g, 0.9, 0.45, 2.2, m, 2.0, 0.25, 0.5);
      box(g, 0.3, 0.9, 2.2, m, 1.65, 0.5, 0.5);
      box(g, 0.9, 0.6, 0.25, m, 2.0, 0.35, -0.6); box(g, 0.9, 0.6, 0.25, m, 2.0, 0.35, 1.6);
      box(g, 0.5, 0.1, 0.5, mat('#f5c242', 0.9), 2.1, 0.5, 0.1); box(g, 0.5, 0.1, 0.5, mat('#a5ff38', 0.9), 2.1, 0.5, 0.9);
      c.push({ minX: 1.5, maxX: 2.5, minZ: -0.75, maxZ: 1.75, h: 0.9 });
    },
    tv: (g, c) => {
      box(g, 0.5, 0.6, 1.8, mat('#2b2b2b', 0.6), 5.0, 0.3, 0.5);
      box(g, 0.08, 1.1, 1.9, mat('#0a0a0a', 0.3, 0.3), 4.85, 1.25, 0.5);
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.0), new THREE.MeshStandardMaterial({ map: textTexture('GIST TV', { bg: '#101c2e', fg: '#a5ff38', sub: 'Big Brother Naija · LIVE', subColor: '#ffffff' }), emissive: '#8fb3ff', emissiveIntensity: 0.35 }));
      screen.rotation.y = -Math.PI / 2; screen.position.set(4.8, 1.25, 0.5); g.add(screen);
      c.push({ minX: 4.7, maxX: 5.3, minZ: -0.45, maxZ: 1.45, h: 1.8 });
    },
    rug: (g) => {
      const r = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 3.2), new THREE.MeshStandardMaterial({ map: ankaraTexture(), roughness: 1 }));
      r.rotation.x = -Math.PI / 2; r.position.set(3.4, 0.02, 0.5); r.receiveShadow = true; g.add(r);
    },
    plant: (g, c) => {
      cyl(g, 0.25, 0.2, 0.45, mat('#b35c3a', 0.9), -4.6, 0.22, 3.9, 10);
      for (let i = 0; i < 6; i++) { const leaf = box(g, 0.35, 0.05, 0.7, mat('#2f8a3e', 0.8), -4.6, 0.8 + i * 0.1, 3.9); leaf.geometry.translate(0, 0, 0.35); leaf.rotation.y = i * 1.05; leaf.rotation.x = -0.5; }
      c.push({ minX: -4.9, maxX: -4.3, minZ: 3.6, maxZ: 4.2, h: 1 });
    },
    fridge: (g, c) => {
      box(g, 0.8, 1.9, 0.8, mat('#cfd3d6', 0.35, 0.6), -4.9, 0.95, -1.2);
      box(g, 0.05, 0.6, 0.04, mat('#555', 0.4), -4.48, 1.3, -1.45); box(g, 0.05, 0.4, 0.04, mat('#555', 0.4), -4.48, 0.5, -1.45);
      c.push({ minX: -5.3, maxX: -4.5, minZ: -1.6, maxZ: -0.8, h: 1.9 });
    },
    ac: (g) => { box(g, 0.95, 0.3, 0.25, mat('#f8f8f8', 0.5), -2.2, 2.55, -4.2); box(g, 0.9, 0.04, 0.02, mat('#6cc', 0.3), -2.2, 2.42, -4.07); },
    art: (g) => {
      box(g, 1.5, 1.0, 0.06, mat('#1a1a1a', 0.5), 4.6, 1.8, -4.2);
      const p = new THREE.Mesh(new THREE.PlaneGeometry(1.36, 0.86), new THREE.MeshStandardMaterial({ map: skylineTexture(), roughness: 0.7 }));
      p.position.set(4.6, 1.8, -4.16); g.add(p);
    },
    lamp: (g, c) => {
      cyl(g, 0.02, 0.02, 1.6, mat('#d8b46a', 0.3, 0.8), 4.6, 0.8, -3.6, 6);
      cyl(g, 0.25, 0.2, 0.05, mat('#2b2b2b', 0.5), 4.6, 0.02, -3.6, 12);
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 0.4, 14, 1, true), new THREE.MeshStandardMaterial({ color: '#fff1d0', emissive: '#ffd9a0', emissiveIntensity: 0.8, side: THREE.DoubleSide }));
      shade.position.set(4.6, 1.7, -3.6); g.add(shade);
      const pl = new THREE.PointLight('#ffd9a0', 6, 7, 1.8); pl.position.set(4.6, 1.7, -3.6); g.add(pl);
      c.push({ minX: 4.35, maxX: 4.85, minZ: -3.85, maxZ: -3.35, h: 1.8 });
    },
    dining: (g, c) => {
      const wood = mat('#8a5a2b', 0.8);
      cyl(g, 0.7, 0.7, 0.06, wood, -1.5, 0.75, 2.6, 20); cyl(g, 0.08, 0.1, 0.72, mat('#3b3a36', 0.6), -1.5, 0.36, 2.6, 8);
      for (const [cx, cz] of [[-2.4, 2.6], [-0.6, 2.6]]) { box(g, 0.45, 0.06, 0.45, wood, cx, 0.45, cz); box(g, 0.06, 0.5, 0.45, wood, cx + (cx < -1.5 ? -0.2 : 0.2), 0.7, cz); for (const [lx, lz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) cyl(g, 0.02, 0.02, 0.45, wood, cx + lx, 0.22, cz + lz, 6); }
      cyl(g, 0.12, 0.1, 0.06, mat('#e74c3c', 0.5), -1.5, 0.81, 2.6, 12); // a bowl of jollof, obviously
      c.push({ minX: -2.7, maxX: -0.3, minZ: 1.9, maxZ: 3.3, h: 0.8 });
    },
  };
  const all = colliders;
  const zones: Zone[] = [
    { id: 'exit', label: 'Front door', icon: '🚪', x: 0, z: 3.4, radius: 1.5, prompt: 'Step outside' },
    { id: 'wardrobe', label: 'Wardrobe', icon: '👗', x: -4.4, z: -1.2, radius: 1.3, prompt: 'Open wardrobe' },
    { id: 'decor', label: 'Decorate', icon: '🛋️', x: 0.5, z: -1.2, radius: 1.4, prompt: 'Decorate your space' },
  ];
  const staticZones = zones.length;
  // Every flat comes with a mattress on the floor; the Queen Bed from the store replaces it.
  build.mattress = (g, c) => {
    box(g, 1.9, 0.22, 1.8, mat('#5d6b86', 0.95), BED.x, 0.11, BED.z);
    box(g, 1.92, 0.03, 1.82, mat('#f4f0e7', 0.9), BED.x, 0.225, BED.z);
    box(g, 1.9, 0.08, 1.0, mat('#2f6f4f', 0.9), BED.x, 0.26, BED.z + 0.3);
    box(g, 0.6, 0.12, 0.4, mat('#ffffff', 0.9), BED.x, 0.28, BED.z - 0.6);
    c.push({ minX: BED.x - 0.95, maxX: BED.x + 0.95, minZ: BED.z - 0.9, maxZ: BED.z + 0.9, h: 0.3 });
  };
  const setFurniture = (placed: string[]) => {
    while (furniture.children.length) furniture.remove(furniture.children[0]);
    furnitureColliders.length = 0;
    if (!placed.includes('bed')) build.mattress(furniture, furnitureColliders);
    for (const id of placed) build[id]?.(furniture, furnitureColliders);
    // interaction zones that depend on furniture
    zones.length = staticZones;
    zones.push({ id: 'bed', label: placed.includes('bed') ? 'Your bed' : 'Mattress', icon: '🛏️', x: BED.x, z: BED.z, radius: 1.9, prompt: 'Sleep', data: { bedTop: placed.includes('bed') ? 0.66 : 0.24 } });
    if (placed.includes('sofa')) zones.push({ id: 'seat', label: 'Velvet sofa', icon: '🛋️', x: 2.0, z: 0.5, radius: 1.7, prompt: 'Sit down', data: { seats: [{ x: 2.1, z: 0.15, yaw: Math.PI / 2, h: 0.5 }, { x: 2.1, z: 0.9, yaw: Math.PI / 2, h: 0.5 }] } });
    if (placed.includes('dining')) zones.push({ id: 'seat', label: 'Dining chair', icon: '🪑', x: -1.5, z: 2.6, radius: 1.5, prompt: 'Sit down', data: { seats: [{ x: -2.4, z: 2.6, yaw: Math.PI / 2, h: 0.48 }, { x: -0.6, z: 2.6, yaw: -Math.PI / 2, h: 0.48 }] } });
    // rebuild the collider list: static walls + current furniture
    all.length = staticCount;
    all.push(...furnitureColliders);
  };
  const staticCount = colliders.length;


  return { group, colliders, zones, spawn: new THREE.Vector3(0, 0, 2.2), spawnYaw: Math.PI, setFurniture, light };
}
