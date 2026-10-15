/**
 * Public interiors: Unity College, the Government Secretariat, GistCity
 * General Hospital, Grace Chapel and the Odogwu Motors showroom. Each is a
 * small scene the player teleports into (like the flat), built from a short
 * spec so new buildings are cheap to add. Every zone here maps to a real
 * server-backed action in game.ts — nothing is decoration-only.
 */
import * as THREE from 'three';
import { mat } from './avatar';
import { AABB, box, cyl, textTexture, car, keke } from './props';
import type { Interior } from './interior';
import type { Seat, Zone } from './world';
import { makeCharacter, type Character } from './character';
import { randomAppearance } from './appearance';
import { bakeStatic } from './bake';

export type Area = 'home' | 'school' | 'gov' | 'hospital' | 'church' | 'dealer';

const texCache = new Map<string, THREE.Texture>();
function tileTex(a: string, b: string, n = 4) {
  const key = `tile|${a}|${b}|${n}`; const hit = texCache.get(key); if (hit) return hit;
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d')!;
  g.fillStyle = a; g.fillRect(0, 0, 256, 256);
  const s = 256 / n;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if ((x + y) % 2) { g.fillStyle = b; g.fillRect(x * s, y * s, s, s); }
  g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 2;
  for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, 256); g.stroke(); g.beginPath(); g.moveTo(0, i * s); g.lineTo(256, i * s); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; texCache.set(key, t); return t;
}

interface RoomOpts { W: number; D: number; H?: number; floor: [string, string]; wall: string; accent: string; title: string; sub?: string }

class Room {
  group = new THREE.Group();
  colliders: AABB[] = [];
  zones: Zone[] = [];
  animated: ((dt: number, t: number) => void)[] = [];
  light: THREE.PointLight;
  W: number; D: number; H: number;
  constructor(o: RoomOpts) {
    const { W, D } = o; const H = o.H ?? 3.4; this.W = W; this.D = D; this.H = H;
    this.group.visible = false;
    const ft = tileTex(o.floor[0], o.floor[1]).clone(); ft.needsUpdate = true; ft.repeat.set(W / 2, D / 2);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: ft, roughness: 0.55 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; this.group.add(floor);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), mat('#f4f2ec', 1)); ceil.rotation.x = Math.PI / 2; ceil.position.y = H; this.group.add(ceil);
    const wallM = mat(o.wall, 0.95), accentM = mat(o.accent, 0.9), skirt = mat('#4b4036', 0.8);
    const wall = (w: number, d: number, x: number, z: number, m = wallM) => { box(this.group, w, H, d, m, x, H / 2, z); this.colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, h: H }); box(this.group, w + 0.02, 0.14, d + 0.02, skirt, x, 0.07, z); };
    wall(W + 0.6, 0.3, 0, -D / 2 - 0.15, accentM);
    wall(0.3, D + 0.6, -W / 2 - 0.15, 0); wall(0.3, D + 0.6, W / 2 + 0.15, 0);
    wall(W / 2 - 1.1, 0.3, -W / 4 - 0.55, D / 2 + 0.15); wall(W / 2 - 1.1, 0.3, W / 4 + 0.55, D / 2 + 0.15);
    box(this.group, 2.2, H - 2.6, 0.3, wallM, 0, H - (H - 2.6) / 2, D / 2 + 0.15);
    for (const dx of [-1.1, 1.1]) box(this.group, 0.1, 2.6, 0.36, skirt, dx, 1.3, D / 2 + 0.15);
    // title board above the door, inside
    const face = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.7), new THREE.MeshStandardMaterial({ map: textTexture(o.title, { bg: o.accent, fg: '#ffffff', sub: o.sub, subColor: '#f3f3f3', w: 1024, h: 200 }), roughness: 0.6 }));
    face.position.set(0, H - 0.5, D / 2 - 0.02); face.rotation.y = Math.PI; this.group.add(face);
    // ceiling lights
    this.light = new THREE.PointLight('#fff3dc', 0, 26, 1.5); this.light.position.set(0, H - 0.3, 0); this.group.add(this.light);
    const tubeM = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff6e0', emissiveIntensity: 1.1 });
    for (let x = -W / 2 + W / 4; x < W / 2; x += W / 2) for (let z = -D / 2 + D / 4; z < D / 2; z += D / 2) box(this.group, 1.2, 0.06, 0.25, tubeM, x, H - 0.05, z, false);
    // windows on the side walls (frosted)
    const win = new THREE.MeshStandardMaterial({ color: '#dfeefc', emissive: '#bcd8f0', emissiveIntensity: 0.35, roughness: 0.3 });
    for (let z = -D / 2 + 2; z < D / 2 - 1; z += 3.2) { box(this.group, 0.06, 1.3, 1.6, win, -W / 2 + 0.02, 1.9, z, false); box(this.group, 0.06, 1.3, 1.6, win, W / 2 - 0.02, 1.9, z, false); }
    this.zones.push({ id: 'exit', label: 'Exit', icon: '🚪', x: 0, z: D / 2 - 0.6, radius: 1.5, prompt: 'Step outside' });
  }
  get spawn() { return new THREE.Vector3(0, 0, this.D / 2 - 2.0); }
  collide(x: number, z: number, w: number, d: number, h = 1) { this.colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, h }); }

  /** Reception / service counter with a sign. The interaction spot is in front of it. */
  counter(x: number, z: number, w: number, label: string, sub: string | undefined, color: string, rotY = 0) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rotY; this.group.add(g);
    box(g, w, 1.05, 0.7, mat(color, 0.8), 0, 0.525, 0);
    box(g, w + 0.1, 0.06, 0.8, mat('#e9e4d8', 0.4), 0, 1.08, 0);
    box(g, 0.5, 0.35, 0.02, mat('#111', 0.4), -w / 4, 1.3, -0.1); // monitor
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(w, 3.2), 0.6), new THREE.MeshStandardMaterial({ map: textTexture(label, { bg: '#1b1b1b', fg: '#f5c242', sub, subColor: '#ffffff', w: 1024, h: 192 }), roughness: 0.6 }));
    sign.position.set(0, 2.3, -0.9); g.add(sign);
    const c = Math.cos(rotY), s = Math.sin(rotY);
    this.colliders.push({ minX: x - (w / 2) * Math.abs(c) - 0.4 * Math.abs(s), maxX: x + (w / 2) * Math.abs(c) + 0.4 * Math.abs(s), minZ: z - 0.4 * Math.abs(c) - (w / 2) * Math.abs(s), maxZ: z + 0.4 * Math.abs(c) + (w / 2) * Math.abs(s), h: 1.1 });
    return { x: x + s * 1.1, z: z + c * 1.1 }; // spot in front (local +z)
  }
  /** A plastic chair; returns its seat. */
  chair(x: number, z: number, rotY: number, color = '#2f6f4f'): Seat {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rotY; this.group.add(g);
    const m = mat(color, 0.7);
    box(g, 0.48, 0.05, 0.48, m, 0, 0.46, 0); box(g, 0.48, 0.5, 0.05, m, 0, 0.72, -0.22);
    for (const [lx, lz] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) cyl(g, 0.02, 0.02, 0.45, mat('#777', 0.5, 0.5), lx, 0.22, lz, 6);
    this.colliders.push({ minX: x - 0.3, maxX: x + 0.3, minZ: z - 0.3, maxZ: z + 0.3, h: 0.9 });
    return { x: x + Math.sin(rotY) * -0.08, z: z + Math.cos(rotY) * -0.08, yaw: rotY, h: 0.47 };
  }
  /** Church pew: three seats, backrest at local -z. */
  pew(x: number, z: number, rotY: number): Seat[] {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rotY; this.group.add(g);
    const wood = mat('#6b4a2b', 0.85);
    box(g, 2.4, 0.06, 0.5, wood, 0, 0.45, 0); box(g, 2.4, 0.55, 0.06, wood, 0, 0.75, -0.26); box(g, 2.4, 0.08, 0.1, wood, 0, 1.02, -0.26);
    for (const lx of [-1.1, 1.1]) box(g, 0.08, 0.45, 0.5, wood, lx, 0.22, 0);
    const c = Math.cos(rotY), s = Math.sin(rotY);
    this.colliders.push({ minX: x - 1.25 * Math.abs(c) - 0.35 * Math.abs(s), maxX: x + 1.25 * Math.abs(c) + 0.35 * Math.abs(s), minZ: z - 0.35 * Math.abs(c) - 1.25 * Math.abs(s), maxZ: z + 0.35 * Math.abs(c) + 1.25 * Math.abs(s), h: 1 });
    return [-0.8, 0, 0.8].map((lx) => ({ x: x + lx * c - 0.08 * s, z: z - lx * s - 0.08 * c, yaw: rotY, h: 0.48 }));
  }
  bed(x: number, z: number, rotY: number, sheet = '#dfe9f3') {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rotY; this.group.add(g);
    box(g, 1.0, 0.3, 2.1, mat('#cfd3d6', 0.5, 0.4), 0, 0.3, 0); box(g, 0.95, 0.18, 2.0, mat(sheet, 0.9), 0, 0.54, 0);
    box(g, 0.6, 0.12, 0.4, mat('#ffffff', 0.9), 0, 0.68, -0.75); box(g, 1.0, 0.6, 0.08, mat('#cfd3d6', 0.5, 0.4), 0, 0.6, -1.08);
    for (const [lx, lz] of [[-0.4, -0.9], [0.4, -0.9], [-0.4, 0.9], [0.4, 0.9]]) cyl(g, 0.04, 0.04, 0.3, mat('#555', 0.5), lx, 0.15, lz, 6);
    const c = Math.abs(Math.cos(rotY)), s = Math.abs(Math.sin(rotY));
    this.colliders.push({ minX: x - 0.55 * c - 1.1 * s, maxX: x + 0.55 * c + 1.1 * s, minZ: z - 1.1 * c - 0.55 * s, maxZ: z + 1.1 * c + 0.55 * s, h: 0.8 });
    return { bedTop: 0.63, yaw: rotY };
  }
  board(x: number, z: number, rotY: number, text: string, sub: string, w = 3.2, h = 1.4, bg = '#1b2a1f', fg = '#a5ff38') {
    const g = new THREE.Group(); g.position.set(x, 1.8, z); g.rotation.y = rotY; this.group.add(g);
    box(g, w + 0.12, h + 0.12, 0.08, mat('#3b2f26', 0.8), 0, 0, 0);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: textTexture(text, { bg, fg, sub, subColor: '#ffffff', w: 1024, h: Math.round(1024 * h / w) }), roughness: 0.65 }));
    face.position.z = 0.045; g.add(face);
  }
  plant(x: number, z: number) {
    cyl(this.group, 0.26, 0.2, 0.5, mat('#b35c3a', 0.9), x, 0.25, z, 10);
    for (let i = 0; i < 7; i++) { const leaf = box(this.group, 0.35, 0.05, 0.8, mat('#2f8a3e', 0.8), x, 0.9 + i * 0.08, z); leaf.geometry = leaf.geometry.clone(); leaf.geometry.translate(0, 0, 0.4); leaf.rotation.y = i * 0.9; leaf.rotation.x = -0.45; }
    this.collide(x, z, 0.6, 0.6);
  }
  /** Staff NPC standing behind a desk (idle animation only). */
  staff(x: number, z: number, yaw: number, seed: number, name: string): Character {
    const c = makeCharacter(randomAppearance(seed), 'lo');
    c.root.position.set(x, 0, z); c.root.rotation.y = yaw; c.root.userData.dynamic = true; this.group.add(c.root);
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTexture(name, { bg: '#1b1b1bcc', fg: '#ffffff', w: 512, h: 128 }), transparent: true, depthWrite: false }));
    tag.scale.set(1.4, 0.35, 1); tag.position.y = 2.05; c.root.add(tag);
    this.animated.push((dt) => c.animate(dt, 0));
    return c;
  }
  done(spawnYaw = Math.PI): Interior {
    bakeStatic(this.group);
    return { group: this.group, colliders: this.colliders, zones: this.zones, spawn: this.spawn, spawnYaw, setFurniture: () => {}, light: this.light, animated: this.animated } as Interior;
  }
}

/* ------------------------------------------------------------------ rooms */

export function buildSchool(): Interior {
  const r = new Room({ W: 16, D: 12, floor: ['#e8e2d2', '#d8d0bd'], wall: '#f3efe4', accent: '#1f5f8b', title: 'UNITY COLLEGE', sub: 'knowledge · character · service' });
  const spot = r.counter(-5, 3.5, 3.2, 'ADMISSIONS', 'enrol · exams · certificates', '#1f5f8b', Math.PI);
  r.zones.push({ id: 'school-desk', label: 'Admissions desk', icon: '🎓', x: spot.x, z: spot.z + 0.3, radius: 2.0, prompt: 'Talk to admissions' });
  r.staff(-5, 4.5, Math.PI, 101, 'Mrs Adeyemi · Admissions');
  // classroom: whiteboard on the back wall, 3 rows × 4 chairs facing it
  r.board(2.5, -5.82, 0, 'TODAY: ROAD SIGNS & THE HIGHWAY CODE', 'Unity College · classes every 20 s · sit to attend', 6, 1.6, '#f8f8f6', '#1b1b1b');
  box(r.group, 1.6, 0.8, 0.6, mat('#8a5a2b', 0.8), 6, 0.4, -4.6); r.collide(6, -4.6, 1.6, 0.6);
  r.staff(6, -5.2, 0, 102, 'Mr Okonkwo · Lecturer');
  const seats: Seat[] = [];
  for (let row = 0; row < 3; row++) for (let i = 0; i < 4; i++) {
    const x = 0.5 + i * 1.3, z = -2.6 + row * 1.5;
    box(r.group, 0.8, 0.04, 0.5, mat('#d9c7a5', 0.8), x, 0.72, z - 0.5); for (const lx of [-0.35, 0.35]) cyl(r.group, 0.02, 0.02, 0.7, mat('#777', 0.5, 0.5), x + lx, 0.35, z - 0.5, 6);
    r.collide(x, z - 0.5, 0.85, 0.5);
    seats.push(r.chair(x, z, Math.PI, '#2f6f4f'));
  }
  r.zones.push({ id: 'seat', label: 'Classroom', icon: '📚', x: 2.5, z: -1.4, radius: 3.2, prompt: 'Attend class', data: { seats, kind: 'class' } });
  r.board(-7.9, -1, Math.PI / 2, 'NOTICE BOARD', 'exam results are posted to your profile · certificates have a verifiable serial', 3.2, 1.3);
  r.plant(7.3, 5.2); r.plant(-7.3, 5.2);
  return r.done();
}

export function buildGovernment(): Interior {
  const r = new Room({ W: 18, D: 13, H: 3.8, floor: ['#dcdcd4', '#c9c9c0'], wall: '#eeeee6', accent: '#1d6b3a', title: 'GOVERNMENT SECRETARIAT', sub: 'Civil Registry · Revenue · Works · Health · Education' });
  // three counters along the back wall
  const emp = r.counter(-5.5, -4.6, 3.6, 'EMPLOYMENT DESK', 'apply · interview · offers · shifts', '#1d6b3a');
  r.zones.push({ id: 'gov-employment', label: 'Employment desk', icon: '🏛️', x: emp.x, z: emp.z + 0.3, radius: 2.0, prompt: 'Employment desk' });
  r.staff(-5.5, -5.5, 0, 201, 'Mr Bello · Employment');
  const reg = r.counter(0, -4.6, 3.6, 'CIVIL REGISTRY', 'marriages · births · records', '#1d6b3a');
  r.zones.push({ id: 'gov-registry', label: 'Civil Registry', icon: '📜', x: reg.x, z: reg.z + 0.3, radius: 1.8, prompt: 'Civil Registry' });
  r.staff(0, -5.5, 0, 202, 'Mrs Lawal · Registry');
  const rev = r.counter(5.5, -4.6, 3.6, 'REVENUE', 'licences · business permits', '#1d6b3a');
  r.zones.push({ id: 'gov-revenue', label: 'Revenue desk', icon: '🧾', x: rev.x, z: rev.z + 0.3, radius: 1.8, prompt: 'Revenue desk' });
  r.staff(5.5, -5.5, 0, 203, 'Mr Eze · Revenue');
  // queue chairs
  const seats: Seat[] = [];
  for (let row = 0; row < 2; row++) for (let i = 0; i < 6; i++) seats.push(r.chair(-4 + i * 1.6, 0.6 + row * 1.4, 0, '#1b3b5a'));
  r.zones.push({ id: 'seat', label: 'Waiting area', icon: '🪑', x: 0, z: 1.3, radius: 4.6, prompt: 'Sit down', data: { seats, kind: 'wait' } });
  // now-serving board + flag
  const flag = new THREE.Group(); flag.position.set(-8.4, 0, -5.2); r.group.add(flag);
  cyl(flag, 0.03, 0.03, 3.2, mat('#c9c9c9', 0.4, 0.6), 0, 1.6, 0, 8);
  box(flag, 0.3, 0.9, 0.02, mat('#1d8f4a', 0.8), 0.15, 2.7, 0); box(flag, 0.3, 0.9, 0.02, mat('#ffffff', 0.8), 0.45, 2.7, 0); box(flag, 0.3, 0.9, 0.02, mat('#1d8f4a', 0.8), 0.75, 2.7, 0);
  r.board(8.9, -1, -Math.PI / 2, 'NOW SERVING', 'applications are processed in queue order · every step is logged', 3.4, 1.4, '#0b0e0c', '#f5c242');
  r.board(-8.9, 2, Math.PI / 2, 'PUBLIC NOTICE', 'salaries are paid from the Government Payroll account · no gifts to officers', 3.4, 1.4, '#ffffff', '#1d6b3a');
  r.plant(8.3, 5.4); r.plant(-8.3, 5.4);
  return r.done();
}

export function buildHospital(): Interior {
  const r = new Room({ W: 18, D: 13, floor: ['#eef3f4', '#dfe8ea'], wall: '#f6f9f9', accent: '#c0392b', title: 'GISTCITY GENERAL HOSPITAL', sub: 'emergency · consultation · pharmacy' });
  const rec = r.counter(-4, -4.6, 4, 'RECEPTION', 'check-up · doctor · pharmacy', '#2e86de');
  r.zones.push({ id: 'hospital-desk', label: 'Reception', icon: '🏥', x: rec.x, z: rec.z + 0.3, radius: 2.0, prompt: 'Reception' });
  r.staff(-4, -5.5, 0, 301, 'Nurse Chidinma');
  r.staff(-6.5, -5.5, 0.3, 302, 'Dr Musa · Physician');
  const ph = r.counter(4.5, -4.6, 3.4, 'PHARMACY', 'paracetamol · vitamins', '#2e86de');
  r.zones.push({ id: 'pharmacy', label: 'Pharmacy', icon: '💊', x: ph.x, z: ph.z + 0.3, radius: 1.8, prompt: 'Pharmacy' });
  r.staff(4.5, -5.5, 0, 303, 'Pharm. Yusuf');
  const seats: Seat[] = [];
  for (let i = 0; i < 5; i++) seats.push(r.chair(-6 + i * 1.5, 1.6, 0, '#2e86de'));
  r.zones.push({ id: 'seat', label: 'Waiting area', icon: '🪑', x: -3, z: 1.6, radius: 3.6, prompt: 'Sit down', data: { seats, kind: 'wait' } });
  // ward: three beds (public — anyone can rest)
  for (let i = 0; i < 3; i++) {
    const x = 6.8, z = 3.5 - i * 2.6;
    const b = r.bed(x, z, -Math.PI / 2);
    r.zones.push({ id: 'bed', label: `Ward bed ${i + 1}`, icon: '🛏️', x: x - 1.2, z, radius: 1.3, prompt: 'Rest', data: { bedTop: b.bedTop, bedYaw: b.yaw, bedX: x, bedZ: z, public: true } });
    cyl(r.group, 0.02, 0.02, 1.6, mat('#9aa', 0.5, 0.5), x + 0.7, 0.8, z - 0.8, 6); box(r.group, 0.3, 0.3, 0.1, mat('#e74c3c', 0.6), x + 0.7, 1.7, z - 0.8);
  }
  r.board(-8.9, -1, Math.PI / 2, 'HEALTH TIPS', 'eat · drink water · sleep · low health only slows you down — nothing here can kill you', 3.4, 1.4, '#ffffff', '#c0392b');
  r.plant(-8.3, 5.4);
  return r.done();
}

export function buildChurch(): Interior {
  const r = new Room({ W: 16, D: 18, H: 5.2, floor: ['#d9c6a5', '#c9b48e'], wall: '#f7f1e3', accent: '#5b2a86', title: 'GRACE CHAPEL GISTCITY', sub: 'everyone is welcome' });
  // altar & pulpit at the back
  const alt = new THREE.Group(); alt.position.set(0, 0, -7); r.group.add(alt);
  box(alt, 7, 0.3, 3.4, mat('#8a6a3d', 0.8), 0, 0.15, 0.2);
  box(alt, 1.4, 1.1, 0.7, mat('#5b2a86', 0.8), 2.2, 0.85, 0.6); // pulpit
  box(alt, 2.4, 0.9, 0.9, mat('#f3e9d5', 0.8), -1.5, 0.75, 0.2); // altar table
  box(alt, 0.16, 2.2, 0.16, mat('#d8b46a', 0.4, 0.7), 0, 2.9, -1.2); box(alt, 1.1, 0.16, 0.16, mat('#d8b46a', 0.4, 0.7), 0, 3.4, -1.2); // cross
  r.collide(0, -6.8, 7, 3.4, 0.3);
  r.staff(2.2, -6.0, 0, 401, 'Pastor Emmanuel');
  // stained-glass panel behind the altar
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.6), new THREE.MeshStandardMaterial({ map: textTexture('✝', { bg: '#5b2a86', fg: '#f5c242', w: 256, h: 288 }), emissive: '#9b59b6', emissiveIntensity: 0.45, roughness: 0.4 }));
  glass.position.set(0, 2.6, -8.82); r.group.add(glass);
  // offering basket on a stand
  cyl(r.group, 0.03, 0.03, 0.9, mat('#d8b46a', 0.4, 0.7), -3.6, 0.45, -4.4, 8); cyl(r.group, 0.35, 0.25, 0.25, mat('#b58a4a', 0.9), -3.6, 1.0, -4.4, 12);
  r.collide(-3.6, -4.4, 0.7, 0.7);
  r.zones.push({ id: 'church-basket', label: 'Offering basket', icon: '🧺', x: -3.6, z: -3.4, radius: 1.4, prompt: 'Give an offering' });
  // pews: 2 blocks × 5 rows × 3 seats = 30 seats, aisle in the middle
  const pews: Seat[] = [];
  for (let row = 0; row < 5; row++) for (const side of [-1, 1]) pews.push(...r.pew(side * 3.2, -2.2 + row * 1.8, Math.PI));
  r.zones.push({ id: 'seat', label: 'Pews', icon: '🙏', x: 0, z: 1.5, radius: 6.2, prompt: 'Take a seat', data: { seats: pews, kind: 'pew' } });
  // notice board + greeter by the door
  r.board(-7.9, 6.2, Math.PI / 2, 'CHURCH NOTICE BOARD', 'services · members · seats · offering account · events', 3.2, 1.3, '#5b2a86', '#f5c242');
  r.zones.push({ id: 'church-board', label: 'Church notice board', icon: '⛪', x: -6.8, z: 6.2, radius: 1.6, prompt: 'Read the notice board' });
  r.staff(5.5, 7.0, -Math.PI / 2, 402, 'Sister Grace · Usher');
  r.zones.push({ id: 'church-greeter', label: 'Sister Grace (usher)', icon: '🤝', x: 4.6, z: 7.0, radius: 1.6, prompt: 'Talk to the usher' });
  r.plant(7.3, 7.8); r.plant(-7.3, 7.8);
  return r.done();
}

export function buildDealer(): Interior {
  const r = new Room({ W: 20, D: 14, H: 4.2, floor: ['#f2f2f0', '#e3e3df'], wall: '#f7f7f5', accent: '#0b0e0c', title: 'ODOGWU MOTORS', sub: 'tokunbo & brand new · licensed buyers only' });
  const desk = r.counter(-7, 4.5, 3.2, 'SALES DESK', 'your vehicles · keys · plates', '#0b0e0c', Math.PI);
  r.zones.push({ id: 'dealer-desk', label: 'Sales desk', icon: '🔑', x: desk.x, z: desk.z + 0.3, radius: 1.8, prompt: 'Sales desk' });
  r.staff(-7, 5.5, Math.PI, 501, 'Chief Odogwu · Sales');
  const show = [
    { model: 'keke-napep', color: '#f1c40f', x: -5.5, z: -2.5 },
    { model: 'toks-corolla', color: '#bdc3c7', x: 0, z: -2.5 },
    { model: 'venza-x', color: '#1a1a1a', x: 5.5, z: -2.5 },
    { model: 'odogwu-g630', color: '#0b0e0c', x: 0, z: 3.0 },
  ];
  for (const s of show) {
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 0.18, 32), mat('#2b2b2b', 0.5, 0.3)); plinth.position.set(s.x, 0.09, s.z); plinth.receiveShadow = true; r.group.add(plinth);
    const g = new THREE.Group(); g.position.set(s.x, 0.18, s.z); g.userData.dynamic = true; r.group.add(g);
    if (s.model === 'keke-napep') keke(g, 0, 0, 0); else car(g, 0, 0, 0, s.color);
    if (s.model === 'odogwu-g630') g.scale.set(1.15, 1.2, 1.15);
    r.animated.push((dt) => { g.rotation.y += dt * 0.25; });
    r.collide(s.x, s.z, 4.6, 4.6, 1.4);
    r.zones.push({ id: 'dealer-car', label: s.model === 'keke-napep' ? 'Keke NAPEP' : s.model === 'toks-corolla' ? 'Toks Corolla 2012' : s.model === 'venza-x' ? 'Venza X crossover' : 'Odogwu G-630', icon: '🚗', x: s.x, z: s.z + 3.1, radius: 1.5, prompt: 'Inspect', data: { model: s.model } });
  }
  r.board(9.9, -1, -Math.PI / 2, 'PRICE LIST', 'Keke 45,000 G · Corolla 180,000 G · Venza 420,000 G · G-630 1,500,000 G · Danfo 260,000 G', 3.6, 1.5, '#0b0e0c', '#a5ff38');
  r.board(-9.9, -1, Math.PI / 2, 'NO LICENCE, NO SALE', 'get your GistCity driver\'s licence at Unity College (3,000 G)', 3.6, 1.5, '#ffffff', '#c0392b');
  return r.done();
}

export function buildInteriors(): Record<Exclude<Area, 'home'>, Interior> {
  return { school: buildSchool(), gov: buildGovernment(), hospital: buildHospital(), church: buildChurch(), dealer: buildDealer() };
}
