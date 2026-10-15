/**
 * The civic ring: the public institutions that sit on the outer ring road.
 * Secretariat and hospital to the north, Unity College and the gym to the
 * west, Grace Chapel and Unity Park to the south, Odogwu Motors, the bank
 * (opening soon) and business plots to the east. Each building with an
 * interior exposes a `door-*` zone that game.ts turns into "Enter …".
 */
import * as THREE from 'three';
import { mat } from './avatar';
import { AABB, box, cyl, signboard, textTexture, car, bench, tree, palm, streetLamp, compoundWall } from './props';
import { benchSeats, building, type Landmark, type Zone } from './world';

export interface CivicOut { zones: Zone[]; deliverySpots: { name: string; x: number; z: number }[]; paths: THREE.Vector3[][]; exclude: { minX: number; maxX: number; minZ: number; maxZ: number }[] }

/** Footprints the random filler loop must leave empty (civic lots + the avenues). */
export const CIVIC_EXCLUDE = [
  { minX: -47, maxX: -13, minZ: -78, maxZ: -56 }, // secretariat
  { minX: 13, maxX: 47, minZ: -78, maxZ: -56 },   // hospital
  { minX: -78, maxX: -56, minZ: -46, maxZ: -10 }, // college
  { minX: -78, maxX: -56, minZ: 14, maxZ: 34 },   // gym
  { minX: -43, maxX: -17, minZ: 56, maxZ: 78 },   // chapel
  { minX: 12, maxX: 48, minZ: 56, maxZ: 78 },     // park
  { minX: 56, maxX: 78, minZ: -44, maxZ: -10 },   // dealership
  { minX: 56, maxX: 78, minZ: 9, maxZ: 27 },      // bank
  { minX: 56, maxX: 78, minZ: 31, maxZ: 49 },     // plots
  { minX: -8, maxX: 8, minZ: -90, maxZ: 90 },     // north/south avenue
  { minX: -90, maxX: 90, minZ: -8, maxZ: 8 },     // east/west avenue
];

const V = (x: number, z: number) => new THREE.Vector3(x, 0, z);

export function buildCivic(group: THREE.Group, colliders: AABB[], landmarks: Landmark[], animated: ((dt: number, t: number) => void)[]): CivicOut {
  const zones: Zone[] = [];
  const paths: THREE.Vector3[][] = [];
  const spots: CivicOut['deliverySpots'] = [];
  const lot = (x: number, z: number, w: number, d: number, color: string, y = 0.17) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(color, 1)); m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); m.receiveShadow = true; group.add(m);
  };
  // outer sidewalks all the way round the ring road
  const walkM = mat('#bcb7a6', 0.95);
  for (const s of [-1, 1]) {
    const a = new THREE.Mesh(new THREE.BoxGeometry(3, 0.16, 124), walkM); a.position.set(s * 58, 0.08, 0); a.receiveShadow = true; group.add(a);
    const b = new THREE.Mesh(new THREE.BoxGeometry(124, 0.16, 3), walkM); b.position.set(0, 0.08, s * 58); b.receiveShadow = true; group.add(b);
  }
  const door = (id: string, label: string, icon: string, x: number, z: number, prompt: string) => zones.push({ id, label, icon, x, z, radius: 2.6, prompt });

  /* ---------------------------------------------------------- north: government */
  {
    const g = building(group, colliders, landmarks, -30, -68, 30, 16, 3, { color: '#efe9dc', facing: 's', sign: 'GOVERNMENT SECRETARIAT', signColors: ['#1d6b3a', '#ffffff'] });
    // portico: six columns + slab
    const col = mat('#f6f1e4', 0.8);
    for (const dx of [-7.5, -4.5, -1.5, 1.5, 4.5, 7.5]) cyl(g, 0.32, 0.36, 8.6, col, dx, 4.3, 10.2, 12);
    box(g, 18, 0.6, 3.6, mat('#e4dccb', 0.85), 0, 8.9, 9.2);
    box(g, 18, 1.2, 0.3, mat('#e4dccb', 0.85), 0, 9.8, 10.8);
    box(g, 12, 0.5, 2.4, mat('#9a9389', 0.9), 0, 0.25, 9.2); box(g, 10, 0.5, 1.2, mat('#9a9389', 0.9), 0, 0.75, 8.6);
    lot(-30, -58.2, 34, 3.6, '#cfc8b8');
    // flag pole on the forecourt
    cyl(group, 0.05, 0.07, 9, mat('#c9c9c9', 0.4, 0.6), -44, 4.5, -58.6, 8);
    box(group, 0.6, 0.9, 0.03, mat('#1d8f4a', 0.8), -43.7, 8.4, -58.6); box(group, 0.6, 0.9, 0.03, mat('#ffffff', 0.8), -43.1, 8.4, -58.6); box(group, 0.6, 0.9, 0.03, mat('#1d8f4a', 0.8), -42.5, 8.4, -58.6);
    colliders.push({ minX: -44.2, maxX: -43.8, minZ: -58.8, maxZ: -58.4, h: 2 });
    door('door-gov', 'Government Secretariat', '🏛️', -30, -58.4, 'Enter the Secretariat');
    spots.push({ name: 'the Government Secretariat', x: -30, z: -58.4 });
    landmarks[landmarks.length - 1].label = 'SECRETARIAT';
  }
  /* ---------------------------------------------------------- north: hospital */
  {
    const g = building(group, colliders, landmarks, 30, -68, 30, 16, 4, { color: '#f7f9f8', facing: 's', sign: 'GISTCITY GENERAL HOSPITAL', signColors: ['#ffffff', '#c0392b'] });
    const red = new THREE.MeshStandardMaterial({ color: '#e74c3c', emissive: '#e74c3c', emissiveIntensity: 0.6, roughness: 0.5 });
    box(g, 0.8, 2.6, 0.2, red, -11, 11.2, 8.2); box(g, 2.6, 0.8, 0.2, red, -11, 11.2, 8.2);
    box(g, 10, 0.4, 5, mat('#dfe3e1', 0.8), 0, 3.3, 10.4); // entrance canopy
    for (const dx of [-4.6, 4.6]) cyl(g, 0.12, 0.12, 3.2, mat('#b8bdbb', 0.5, 0.5), dx, 1.6, 12.6, 8);
    lot(30, -58.2, 34, 3.6, '#d8dcd9');
    // ambulance bay
    const amb = car(group, 44.5, -58.4, Math.PI / 2, '#ffffff', colliders);
    box(amb, 0.8, 0.25, 0.25, red, 0, 1.55, 0.4);
    signboard(group, 'EMERGENCY  →', 3.2, 0.6, 41, 2.2, -59.6, 0, '#c0392b', '#ffffff');
    door('door-hospital', 'GistCity General Hospital', '🏥', 30, -58.4, 'Enter the hospital');
    spots.push({ name: 'the General Hospital', x: 30, z: -58.4 });
    landmarks[landmarks.length - 1].label = 'HOSPITAL';
  }
  /* ---------------------------------------------------------- west: Unity College */
  {
    building(group, colliders, landmarks, -68, -28, 16, 32, 2, { color: '#f3ead3', facing: 'e', sign: 'UNITY COLLEGE', signColors: ['#1f5f8b', '#ffffff'], tank: true });
    lot(-58.2, -28, 3.6, 34, '#cfc8b8');
    // school gate on the pavement
    for (const dz of [-4, 4]) { box(group, 0.7, 3.4, 0.7, mat('#1f5f8b', 0.8), -58.6, 1.7, -28 + dz); colliders.push({ minX: -58.95, maxX: -58.25, minZ: -28 + dz - 0.35, maxZ: -28 + dz + 0.35, h: 3.4 }); }
    signboard(group, 'UNITY COLLEGE', 8.6, 0.9, -58.6, 3.8, -28, -Math.PI / 2, '#1f5f8b', '#ffffff', 'knowledge · character · service');
    door('door-school', 'Unity College', '🎓', -58.4, -28, 'Enter Unity College');
    spots.push({ name: 'Unity College gate', x: -58.4, z: -28 });
    landmarks[landmarks.length - 1].label = 'UNITY COLLEGE';
  }
  /* ---------------------------------------------------------- west: gym */
  {
    building(group, colliders, landmarks, -68, 24, 14, 16, 2, { style: 'shop', color: '#2c3e50', facing: 'e', sign: 'IRON TEMPLE GYM', signColors: ['#2c3e50', '#f5c242'] });
    lot(-58.2, 24, 3.6, 18, '#cfc8b8');
    // a barbell by the door
    const bar = new THREE.Group(); bar.position.set(-58.6, 0, 30); bar.rotation.y = Math.PI / 2; group.add(bar);
    cyl(bar, 0.03, 0.03, 1.6, mat('#999', 0.4, 0.7), 0, 0.3, 0, 8).rotation.z = Math.PI / 2;
    for (const dx of [-0.6, 0.6]) cyl(bar, 0.3, 0.3, 0.08, mat('#222', 0.6), dx, 0.3, 0, 16).rotation.z = Math.PI / 2;
    colliders.push({ minX: -59, maxX: -58.2, minZ: 29.2, maxZ: 30.8, h: 0.6 });
    zones.push({ id: 'gym', label: 'Iron Temple Gym', icon: '🏋️', x: -58.4, z: 24, radius: 2.4, prompt: 'Train' });
    landmarks[landmarks.length - 1].label = 'GYM';
  }
  /* ---------------------------------------------------------- south: Grace Chapel */
  {
    const g = new THREE.Group(); g.position.set(-30, 0, 68); group.add(g); // front faces -z (toward the centre)
    const wallM = mat('#f7f1e3', 0.9), trimM = mat('#5b2a86', 0.8), roofM = mat('#6d4b3a', 0.85);
    box(g, 14, 7, 16, wallM, 0, 3.5, 0);
    const slope = 0.62;
    for (const s of [-1, 1]) { const r = box(g, 8.2, 0.25, 16.6, roofM, s * 3.6, 7 + 2.25, 0); r.rotation.z = s * slope; }
    box(g, 0.6, 4.2, 16.6, roofM, 0, 7 + 2.3, 0); // ridge filler
    // gable triangle front
    const gable = new THREE.Mesh(new THREE.CylinderGeometry(0, 8.1, 4.6, 3), wallM); gable.scale.set(1, 1, 0.04); gable.position.set(0, 9.3, -7.9); g.add(gable);
    const gableB = gable.clone(); gableB.position.z = 7.9; g.add(gableB);
    // tower
    box(g, 4, 14, 4, wallM, -7, 7, -5); box(g, 4.4, 0.3, 4.4, trimM, -7, 14.1, -5);
    const spire = new THREE.Mesh(new THREE.ConeGeometry(2.8, 3.6, 4), trimM); spire.rotation.y = Math.PI / 4; spire.position.set(-7, 16, -5); spire.castShadow = true; g.add(spire);
    box(g, 0.16, 2.0, 0.16, mat('#d8b46a', 0.4, 0.7), -7, 18.8, -5); box(g, 1.0, 0.16, 0.16, mat('#d8b46a', 0.4, 0.7), -7, 19.3, -5);
    // tower windows + door + rose window
    const win = mat('#2f4a55', 0.25, 0.4);
    for (const y of [4, 8, 12]) box(g, 0.9, 1.4, 0.1, win, -7, y, -7.05);
    box(g, 2.2, 3.0, 0.14, mat('#5a3b2a', 0.7), 0, 1.5, -8.08);
    const arch = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.14, 24, 1, false, -Math.PI / 2, Math.PI), mat('#5a3b2a', 0.7)); arch.rotation.x = -Math.PI / 2; arch.position.set(0, 3.0, -8.08); g.add(arch);
    const rose = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.12, 24), new THREE.MeshStandardMaterial({ color: '#9b59b6', emissive: '#7d3c98', emissiveIntensity: 0.4, roughness: 0.4 })); rose.rotation.x = Math.PI / 2; rose.position.set(0, 6.6, -8.08); g.add(rose);
    for (let i = 0; i < 4; i++) for (const s of [-1, 1]) box(g, 0.1, 2.4, 0.9, win, s * 7.05, 3.8, -5 + i * 3.4);
    signboard(g, 'GRACE CHAPEL GISTCITY', 8, 0.9, 0, 4.95, -8.1, Math.PI, '#5b2a86', '#f5c242', 'Sunday 9:00 · Wednesday 18:00 · all welcome');
    box(g, 6, 0.3, 2.4, mat('#9a9389', 0.9), 0, 0.15, -9.1);
    colliders.push({ minX: -37.2, maxX: -22.8, minZ: 59.9, maxZ: 76.2, h: 7 }, { minX: -39.1, maxX: -34.9, minZ: 60.9, maxZ: 65.1, h: 14 });
    landmarks.push({ x: -30, z: 68, w: 18, d: 16, color: '#f7f1e3', label: 'GRACE CHAPEL' });
    lot(-30, 58.2, 26, 3.6, '#cfc8b8');
    door('door-church', 'Grace Chapel', '⛪', -30, 58.4, 'Enter Grace Chapel');
    spots.push({ name: 'Grace Chapel', x: -30, z: 58.4 });
  }
  /* ---------------------------------------------------------- south: Unity Park */
  {
    lot(30, 67, 34, 20, '#8fbf6a', 0.012);
    lot(30, 67, 3, 20, '#cfc8b8', 0.02); lot(30, 67, 34, 3, '#cfc8b8', 0.02);
    // fountain
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.2, 0.7, 28), mat('#cfc6b4', 0.8)); basin.position.set(30, 0.35, 67); basin.castShadow = true; group.add(basin);
    const water = new THREE.Mesh(new THREE.CylinderGeometry(2.7, 2.7, 0.2, 28), new THREE.MeshStandardMaterial({ color: '#4fb3d9', roughness: 0.15, metalness: 0.3, transparent: true, opacity: 0.85 })); water.position.set(30, 0.68, 67); group.add(water);
    cyl(group, 0.3, 0.5, 1.8, mat('#cfc6b4', 0.8), 30, 1.3, 67, 12);
    const jet = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.3, 1.6, 10), new THREE.MeshStandardMaterial({ color: '#dff6ff', transparent: true, opacity: 0.7 })); jet.position.set(30, 2.6, 67); jet.userData.dynamic = true; group.add(jet);
    animated.push((_dt, t) => { jet.scale.y = 0.8 + Math.sin(t * 3) * 0.2; jet.position.y = 2.6 + Math.sin(t * 3) * 0.15; });
    colliders.push({ minX: 26.8, maxX: 33.2, minZ: 63.8, maxZ: 70.2, h: 1 });
    for (const [bx, bz, r] of [[24, 62.5, 0], [36, 62.5, 0], [24, 71.5, Math.PI], [36, 71.5, Math.PI]] as [number, number, number][]) {
      bench(group, bx, bz, r, colliders);
      zones.push({ id: 'seat', label: 'Park bench', icon: '🪑', x: bx, z: bz, radius: 1.6, prompt: 'Sit down', data: { seats: benchSeats(bx, bz, r) } });
    }
    tree(group, 17, 62, 1.3, colliders); tree(group, 43, 62, 1.2, colliders); tree(group, 17, 73, 1.1, colliders); tree(group, 43, 73, 1.4, colliders);
    palm(group, 22, 75, 1.2, colliders); palm(group, 38, 75, 1.1, colliders);
    streetLamp(group, 20, 67, colliders); streetLamp(group, 40, 67, colliders);
    signboard(group, 'UNITY PARK', 4, 0.8, 30, 1.6, 58.6, Math.PI, '#1d6b3a', '#ffffff', 'keep GistCity clean');
    landmarks.push({ x: 30, z: 67, w: 34, d: 20, color: '#8fbf6a', label: 'UNITY PARK' });
    spots.push({ name: 'the Unity Park fountain', x: 30, z: 61 });
  }
  /* ---------------------------------------------------------- east: Odogwu Motors */
  {
    const g = building(group, colliders, landmarks, 68, -27, 16, 30, 2, { style: 'shop', color: '#1b1f22', facing: 'w', sign: 'ODOGWU MOTORS', signColors: ['#0b0e0c', '#a5ff38'] });
    // tall glass showroom front replaces the small shop glass
    box(g, 26, 5.6, 0.12, mat('#9fd3e6', 0.1, 0.7), 0, 3.3, 8.1);
    lot(58.2, -27, 3.6, 34, '#9a9a94');
    car(group, 58.3, -40, 0, '#c0392b', colliders); car(group, 58.3, -14, 0, '#2980b9', colliders);
    // bunting across the forecourt
    const flagsM = [mat('#f5c242', 0.8), mat('#e74c3c', 0.8), mat('#2ecc71', 0.8), mat('#3498db', 0.8)];
    for (let i = 0; i < 28; i++) { const f = box(group, 0.28, 0.4, 0.02, flagsM[i % 4], 57, 4.6, -43 + i * 1.15, false); f.rotation.y = Math.PI / 2; }
    cyl(group, 0.03, 0.03, 4.8, mat('#999', 0.4, 0.7), 57, 2.4, -43.2, 6); cyl(group, 0.03, 0.03, 4.8, mat('#999', 0.4, 0.7), 57, 2.4, -11, 6);
    door('door-dealer', 'Odogwu Motors', '🚗', 58.4, -27, 'Enter the showroom');
    spots.push({ name: 'Odogwu Motors', x: 58.4, z: -27 });
    landmarks[landmarks.length - 1].label = 'ODOGWU MOTORS';
  }
  /* ---------------------------------------------------------- east: bank (opening soon) */
  {
    building(group, colliders, landmarks, 68, 18, 16, 14, 2, { color: '#dfe6ee', facing: 'w', sign: 'GISTCITY BANK', signColors: ['#0b3d91', '#ffffff'] });
    signboard(group, 'OPENING SOON', 5, 0.8, 59.6, 1.6, 18, -Math.PI / 2, '#f5c242', '#111');
    landmarks[landmarks.length - 1].label = 'BANK · soon';
  }
  /* ---------------------------------------------------------- east: business plots */
  {
    lot(67, 40, 16, 14, '#b9a98a', 0.012);
    compoundWall(group, 67, 40, 16, 14, 'w', colliders, '#cfc6b4');
    signboard(group, 'PLOT FOR SALE', 5, 1.0, 59.6, 1.8, 40, -Math.PI / 2, '#ffffff', '#c0392b', 'businesses & property · coming soon');
    landmarks.push({ x: 67, z: 40, w: 16, d: 14, color: '#b9a98a', label: 'FOR SALE' });
  }

  // pedestrians along the outer pavement, visiting the civic doors
  paths.push(
    [V(-58, -56), V(-58, -30), V(-58, 0), V(-58, 22), V(-58, 56)],
    [V(-56, -58), V(-30, -58), V(0, -58), V(30, -58), V(56, -58)],
    [V(58, -56), V(58, -27), V(58, 0), V(58, 18), V(58, 56)],
    [V(56, 58), V(30, 60), V(0, 58), V(-30, 58), V(-56, 58)],
    [V(30, 61), V(24, 64), V(20, 67), V(24, 70), V(30, 73), V(36, 70), V(40, 67), V(36, 64)],
  );
  return { zones, deliverySpots: spots, paths, exclude: CIVIC_EXCLUDE };
}

/* ------------------------------------------------------------------ traffic lanes */

/** Right-hand-traffic loops for NPC vehicles. Waypoints in world space. */
export function trafficLoops(): THREE.Vector3[][] {
  const r = 8.8; // roundabout circulation radius
  const arc = (from: number, to: number, n = 7) => { const out: THREE.Vector3[] = []; for (let i = 0; i <= n; i++) { const a = from + (to - from) * (i / n); out.push(V(r * Math.sin(a), r * Math.cos(a))); } return out; };
  const ns = [V(3, 76), V(3, 12), ...arc(0.34, Math.PI - 0.34), V(3, -12), V(3, -76), V(-3, -76), V(-3, -12), ...arc(Math.PI + 0.34, 2 * Math.PI - 0.34), V(-3, 12), V(-3, 76)];
  const ew = [V(-76, 3), V(-12, 3), ...arc(1.5 * Math.PI + 0.34, 2.5 * Math.PI - 0.34), V(12, 3), V(76, 3), V(76, -3), V(12, -3), ...arc(0.5 * Math.PI + 0.34, 1.5 * Math.PI - 0.34), V(-12, -3), V(-76, -3)];
  const i = 49.8, o = 54.2;
  const inner = [V(-i, -i), V(i, -i), V(i, i), V(-i, i)];
  const outer = [V(-o, -o), V(-o, o), V(o, o), V(o, -o)];
  return [ns, ew, inner, outer];
}
