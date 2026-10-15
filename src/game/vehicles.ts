/**
 * Vehicles: parked cars owned by citizens, the one you are driving, cars
 * other players are driving (from presence), and the NPC traffic that keeps
 * the roads alive. Arcade handling tuned for a joystick: forward = throttle,
 * sideways = steering, scaled by speed so you cannot spin on the spot.
 */
import * as THREE from 'three';
import { AABB, car, danfo, keke, makeSprite } from './props';
import type { VehicleView } from '../net/society';

export interface Handling { top: number; accel: number; brake: number; turn: number; radius: number; scale: number }
const HANDLING: Record<string, Handling> = {
  'keke-napep': { top: 9, accel: 4.5, brake: 9, turn: 2.6, radius: 1.3, scale: 1 },
  'toks-corolla': { top: 15, accel: 6.5, brake: 12, turn: 2.2, radius: 1.5, scale: 1 },
  'venza-x': { top: 17, accel: 7.5, brake: 13, turn: 2.1, radius: 1.55, scale: 1.06 },
  'odogwu-g630': { top: 20, accel: 9, brake: 14, turn: 2.0, radius: 1.6, scale: 1.12 },
  'danfo-14': { top: 12, accel: 4.5, brake: 10, turn: 1.8, radius: 1.9, scale: 1 },
};
export const handlingOf = (model: string): Handling => HANDLING[model] ?? HANDLING['toks-corolla'];

export function vehicleMesh(model: string, color: string): THREE.Group {
  const holder = new THREE.Group();
  const kind = model.startsWith('keke') ? 'keke' : model.startsWith('danfo') ? 'bus' : 'car';
  const g = kind === 'keke' ? keke(holder, 0, 0, 0) : kind === 'bus' ? danfo(holder, 0, 0, 0) : car(holder, 0, 0, 0, color);
  const s = handlingOf(model).scale; g.scale.set(s, s, s);
  return g;
}

/** Collision circle pair (front/back) for a vehicle of a given model. */
function circles(model: string, x: number, z: number, yaw: number): { x: number; z: number; r: number }[] {
  const h = handlingOf(model); const kind = model.startsWith('keke') ? 'keke' : model.startsWith('danfo') ? 'bus' : 'car';
  const len = kind === 'keke' ? 0.6 : kind === 'bus' ? 1.5 : 1.2;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const r = kind === 'keke' ? 0.9 : kind === 'bus' ? 1.3 : h.radius * 0.75;
  return [{ x: x + fx * len, z: z + fz * len, r }, { x: x - fx * len, z: z - fz * len, r }];
}
function circleHitsAABB(cx: number, cz: number, r: number, b: AABB) {
  const nx = Math.max(b.minX, Math.min(cx, b.maxX)), nz = Math.max(b.minZ, Math.min(cz, b.maxZ));
  return (cx - nx) ** 2 + (cz - nz) ** 2 < r * r;
}

export interface Parked { view: VehicleView; mesh: THREE.Group; tag: THREE.Sprite | null }
export interface Driving { view: VehicleView; mesh: THREE.Group; speed: number; yaw: number; x: number; z: number; steer: number; bumpT: number }

export class VehicleManager {
  group = new THREE.Group();
  parked = new Map<string, Parked>();
  driving: Driving | null = null;
  private remote = new Map<string, { mesh: THREE.Group; model: string; color: string }>();
  private cache: AABB[] = [];
  private cacheDirty = true;

  /** Replace the set of parked vehicles (mine + everyone's in the city). The one being driven is skipped. */
  setVehicles(list: VehicleView[]) {
    const keep = new Set<string>();
    for (const v of list) {
      if (v.area !== 'city' || this.driving?.view.id === v.id) continue;
      keep.add(v.id);
      let p = this.parked.get(v.id);
      if (p && (p.view.color !== v.color || p.view.model_id !== v.model_id)) { this.group.remove(p.mesh); this.parked.delete(v.id); p = undefined; }
      if (!p) {
        const mesh = vehicleMesh(v.model_id, v.color); this.group.add(mesh);
        const tag = v.owner_name ? makeSprite(v.owner_name, { scale: 0.5, bg: 'rgba(8,12,9,0.55)' }) : null;
        if (tag) { tag.position.y = 1.9; mesh.add(tag); }
        p = { view: v, mesh, tag }; this.parked.set(v.id, p);
      }
      p.view = v; p.mesh.position.set(v.x, 0, v.z); p.mesh.rotation.y = v.yaw;
    }
    for (const [id, p] of this.parked) if (!keep.has(id)) { this.group.remove(p.mesh); this.parked.delete(id); }
    this.cacheDirty = true;
  }
  /** AABBs of parked vehicles, for walking collisions. */
  colliders(): AABB[] {
    if (!this.cacheDirty) return this.cache;
    this.cache = [...this.parked.values()].map((p) => { const c = circles(p.view.model_id, p.view.x, p.view.z, p.view.yaw); const xs = c.flatMap((k) => [k.x - k.r, k.x + k.r]), zs = c.flatMap((k) => [k.z - k.r, k.z + k.r]); return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs), h: 1.4 }; });
    this.cacheDirty = false; return this.cache;
  }
  nearest(x: number, z: number, r = 3.6): VehicleView | null {
    let best: VehicleView | null = null, bd = r * r;
    for (const p of this.parked.values()) { const d = (p.view.x - x) ** 2 + (p.view.z - z) ** 2; if (d < bd) { bd = d; best = p.view; } }
    return best;
  }
  enter(id: string): Driving | null {
    const p = this.parked.get(id); if (!p) return null;
    this.parked.delete(id); this.cacheDirty = true;
    if (p.tag) { p.mesh.remove(p.tag); }
    this.driving = { view: p.view, mesh: p.mesh, speed: 0, yaw: p.view.yaw, x: p.view.x, z: p.view.z, steer: 0, bumpT: 0 };
    return this.driving;
  }
  /** Stop driving; the car stays where it is. Returns where the driver steps out. */
  exit(): { x: number; z: number; yaw: number; view: VehicleView } | null {
    const d = this.driving; if (!d) return null;
    this.driving = null;
    d.view = { ...d.view, x: +d.x.toFixed(2), z: +d.z.toFixed(2), yaw: +d.yaw.toFixed(3), area: 'city' };
    const tag = d.view.owner_name ? makeSprite(d.view.owner_name, { scale: 0.5, bg: 'rgba(8,12,9,0.55)' }) : null;
    if (tag) { tag.position.y = 1.9; d.mesh.add(tag); }
    this.parked.set(d.view.id, { view: d.view, mesh: d.mesh, tag }); this.cacheDirty = true;
    const lx = Math.cos(d.yaw), lz = -Math.sin(d.yaw); // driver's side (local -x)
    return { x: d.x - lx * 2.0, z: d.z - lz * 2.0, yaw: d.yaw, view: d.view };
  }
  /** One physics step for the car you are driving. `axis` is the joystick (y forward, x right). */
  drive(dt: number, axis: { x: number; y: number }, statics: AABB[], bounds: number, others: { x: number; z: number; r: number }[]): { bumped: boolean } {
    const d = this.driving; if (!d) return { bumped: false };
    const h = handlingOf(d.view.model_id);
    const throttle = axis.y;
    // accelerate / brake / reverse
    if (throttle > 0.05) d.speed += (d.speed < 0 ? h.brake : h.accel) * throttle * dt;
    else if (throttle < -0.05) d.speed += (d.speed > 0 ? -h.brake : -h.accel * 0.6) * -throttle * dt;
    else d.speed -= Math.sign(d.speed) * Math.min(Math.abs(d.speed), (3 + Math.abs(d.speed) * 0.35) * dt); // rolling drag
    d.speed = THREE.MathUtils.clamp(d.speed, -h.top * 0.35, h.top);
    // steering scaled by speed (no spinning while stationary)
    d.steer = THREE.MathUtils.lerp(d.steer, axis.x, Math.min(1, dt * 8));
    const sf = Math.min(1, Math.abs(d.speed) / 4) * (1 - 0.45 * Math.min(1, Math.abs(d.speed) / h.top));
    d.yaw -= d.steer * h.turn * sf * dt * Math.sign(d.speed || 1);
    const nx = d.x + Math.sin(d.yaw) * d.speed * dt, nz = d.z + Math.cos(d.yaw) * d.speed * dt;
    let bumped = false;
    const test = circles(d.view.model_id, nx, nz, d.yaw);
    const hit = test.some((c) => statics.some((b) => circleHitsAABB(c.x, c.z, c.r, b)) || others.some((o) => (o.x - c.x) ** 2 + (o.z - c.z) ** 2 < (o.r + c.r) ** 2)) || Math.abs(nx) > bounds + 4 || Math.abs(nz) > bounds + 4;
    if (hit) {
      // try sliding along one axis, else stop with a bump
      const tx = circles(d.view.model_id, nx, d.z, d.yaw), tz = circles(d.view.model_id, d.x, nz, d.yaw);
      const okX = !tx.some((c) => statics.some((b) => circleHitsAABB(c.x, c.z, c.r, b)) || others.some((o) => (o.x - c.x) ** 2 + (o.z - c.z) ** 2 < (o.r + c.r) ** 2));
      const okZ = !tz.some((c) => statics.some((b) => circleHitsAABB(c.x, c.z, c.r, b)) || others.some((o) => (o.x - c.x) ** 2 + (o.z - c.z) ** 2 < (o.r + c.r) ** 2));
      if (okX && Math.abs(nx) <= bounds + 4) { d.x = nx; d.speed *= 0.6; }
      else if (okZ && Math.abs(nz) <= bounds + 4) { d.z = nz; d.speed *= 0.6; }
      else { if (Math.abs(d.speed) > 3) bumped = true; d.speed *= -0.25; }
    } else { d.x = nx; d.z = nz; }
    d.mesh.position.set(d.x, 0, d.z); d.mesh.rotation.y = d.yaw;
    // tiny suspension bob
    d.mesh.position.y = Math.abs(d.speed) > 1 ? Math.sin(performance.now() / 90) * 0.012 : 0;
    if (bumped) d.bumpT = 0.4;
    return { bumped };
  }
  /** Mirror other players' cars. `list` is already position-smoothed by the caller. */
  syncRemote(list: { id: string; model: string; color: string; x: number; z: number; yaw: number }[]) {
    const seen = new Set<string>();
    for (const r of list) {
      seen.add(r.id);
      let m = this.remote.get(r.id);
      if (m && (m.model !== r.model || m.color !== r.color)) { this.group.remove(m.mesh); this.remote.delete(r.id); m = undefined; }
      if (!m) { m = { mesh: vehicleMesh(r.model, r.color), model: r.model, color: r.color }; this.group.add(m.mesh); this.remote.set(r.id, m); }
      m.mesh.position.set(r.x, 0, r.z); m.mesh.rotation.y = r.yaw;
    }
    for (const [id, m] of this.remote) if (!seen.has(id)) { this.group.remove(m.mesh); this.remote.delete(id); }
  }
  remoteCircles(): { x: number; z: number; r: number }[] {
    return [...this.remote.values()].map((m) => ({ x: m.mesh.position.x, z: m.mesh.position.z, r: 1.6 }));
  }
}

/* ------------------------------------------------------------------ traffic */

interface TrafficCar { mesh: THREE.Group; loop: THREE.Vector3[]; idx: number; speed: number; top: number; yaw: number; model: string }

export class TrafficManager {
  group = new THREE.Group();
  cars: TrafficCar[] = [];
  constructor(loops: THREE.Vector3[][], count = 6) {
    const palette = ['#ecf0f1', '#2c3e50', '#c0392b', '#7f8c8d', '#2980b9', '#f1c40f', '#1a1a1a'];
    for (let i = 0; i < count; i++) {
      const loop = loops[i % loops.length];
      const model = i % 5 === 4 ? 'danfo-14' : i % 5 === 2 ? 'keke-napep' : 'toks-corolla';
      const mesh = vehicleMesh(model, palette[i % palette.length]);
      const idx = Math.floor((i / count) * loop.length) % loop.length;
      const a = loop[idx], b = loop[(idx + 1) % loop.length];
      mesh.position.copy(a).lerp(b, 0.5);
      this.group.add(mesh);
      this.cars.push({ mesh, loop, idx: (idx + 1) % loop.length, speed: 0, top: model === 'keke-napep' ? 6 : model === 'danfo-14' ? 7.5 : 9.5, yaw: 0, model });
    }
  }
  /** Returns collision circles for the player's car. `blockers` are things cars must not drive into (player, player car, other players). */
  update(dt: number, blockers: { x: number; z: number; r: number }[]) {
    for (const c of this.cars) {
      const pos = c.mesh.position;
      const target = c.loop[c.idx];
      const dx = target.x - pos.x, dz = target.z - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 1.2) { c.idx = (c.idx + 1) % c.loop.length; continue; }
      const wantYaw = Math.atan2(dx, dz);
      // yield: anything in a 9 m cone ahead → brake
      const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
      let desired = c.top;
      const ahead = (bx: number, bz: number, br: number) => { const ox = bx - pos.x, oz = bz - pos.z; const along = ox * fx + oz * fz; const side = Math.abs(ox * fz - oz * fx); return along > 0 && along < 9 + br && side < 2.2 + br; };
      for (const b of blockers) if (ahead(b.x, b.z, b.r)) { desired = 0; break; }
      if (desired > 0) for (const o of this.cars) if (o !== c && ahead(o.mesh.position.x, o.mesh.position.z, 1.4)) { desired = Math.min(desired, o.speed * 0.9); break; }
      c.speed += THREE.MathUtils.clamp(desired - c.speed, -12 * dt, 4 * dt);
      if (c.speed < 0.02) c.speed = 0;
      let dy = wantYaw - c.yaw; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
      c.yaw += THREE.MathUtils.clamp(dy, -2.2 * dt, 2.2 * dt);
      pos.x += Math.sin(c.yaw) * c.speed * dt; pos.z += Math.cos(c.yaw) * c.speed * dt;
      c.mesh.rotation.y = c.yaw;
    }
  }
  circles(): { x: number; z: number; r: number }[] { return this.cars.map((c) => ({ x: c.mesh.position.x, z: c.mesh.position.z, r: c.model === 'danfo-14' ? 1.9 : 1.5 })); }
  /** Pedestrian-side collision boxes (so NPC cars push you rather than pass through). */
  colliders(): AABB[] { return this.cars.map((c) => ({ minX: c.mesh.position.x - 1.3, maxX: c.mesh.position.x + 1.3, minZ: c.mesh.position.z - 1.3, maxZ: c.mesh.position.z + 1.3, h: 1.4 })); }
}
