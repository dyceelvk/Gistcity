/** Hustles: dispatch runs, market runs and the POS stand. */
import * as THREE from 'three';
import { makeSprite } from './props';
import type { World } from './world';

export type JobId = 'dispatch' | 'market' | 'pos';
export interface JobDef { id: JobId; title: string; desc: string; pay: string; icon: string }
export const JOBS: JobDef[] = [
  { id: 'dispatch', title: 'Dispatch rider', desc: 'Pick up a package at the Hub and deliver it across town before the timer runs out.', pay: '1,500 G', icon: '📦' },
  { id: 'market', title: 'Market runs', desc: 'Mama Bisi needs five crates gathered from the market before customers arrive.', pay: '2,000 G', icon: '🧺' },
  { id: 'pos', title: 'POS agent', desc: 'Apply at the QuickCash stand, get approved, then serve real customers — they name the amount, you ask withdraw or transfer, keep the fee.', pay: 'Fees per customer (3%)', icon: '💳' },
];

/** Glowing ring + floating icon used for zones and job targets. */
export function makeMarker(icon: string, color = '#a5ff38') {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.07, 8, 32), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.8, roughness: 0.4 }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.12; g.add(ring);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.7, 2.6, 20, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
  beam.position.y = 1.4; g.add(beam);
  const s = makeSprite(icon, { scale: 1.0, bg: 'rgba(0,0,0,0)' });
  s.scale.set(1.1, 1.1, 1); s.position.y = 2.1; g.add(s);
  g.userData.ring = ring; g.userData.sprite = s;
  return g;
}
export function animateMarker(m: THREE.Group, t: number, phase = 0) {
  (m.userData.sprite as THREE.Sprite).position.y = 2.1 + Math.sin(t * 2.2 + phase) * 0.12;
  (m.userData.ring as THREE.Mesh).rotation.z = t * 0.6;
}

export interface JobCallbacks {
  toast(msg: string): void;
  /** Pay for a finished gig. The amount is decided by the server pay table (jobId); xp is client-side. */
  reward(jobId: JobId, xp: number, hustle: number): void;
  objective(title: string, text: string): void;
  clearObjective(): void;
  /** Run the timing minigame. Resolves with the number of successes. */
  timing(rounds: number, title: string, successText: string, failText: string): Promise<number>;
  changed(): void;
}

interface Active {
  id: JobId;
  timeLeft: number;
  target: { x: number; z: number; label: string } | null;
  marker: THREE.Group | null;
  crates: { x: number; z: number; mesh: THREE.Group }[];
  collected: number;
  busy: boolean;
  dest?: { name: string; x: number; z: number };
}

const CRATE_SPOTS = [
  [-28, -24], [-34, -27], [-22, -32], [-30, -36], [-36, -45], [-18, -46], [-25, -28], [-40, -22], [-33, -32], [-19, -34],
];

export class JobSystem {
  active: Active | null = null;
  constructor(private world: World, private layer: THREE.Group, private cb: JobCallbacks) {}

  start(id: JobId, playerPos: THREE.Vector3) {
    if (id === 'pos') { this.cb.toast('POS is not a tap game any more — apply at the QuickCash stand, then wait for customers.'); return; }
    if (this.active) this.cancel(true);
    const a: Active = { id, timeLeft: 0, target: null, marker: null, crates: [], collected: 0, busy: false };
    if (id === 'dispatch') {
      const far = this.world.deliverySpots.filter((s) => Math.hypot(s.x - playerPos.x, s.z - playerPos.z) > 30);
      const dest = far[Math.floor(Math.random() * far.length)] ?? this.world.deliverySpots[0];
      a.dest = dest; a.timeLeft = 110;
      a.target = { x: dest.x, z: dest.z, label: dest.name };
      a.marker = makeMarker('📦', '#f5c242'); a.marker.position.set(dest.x, 0, dest.z); this.layer.add(a.marker);
      this.cb.objective('Dispatch run', `Deliver the package to ${dest.name}. Follow the yellow marker.`);
      this.cb.toast(`Package collected. Deliver to ${dest.name}!`);
    } else if (id === 'market') {
      a.timeLeft = 120;
      const spots = [...CRATE_SPOTS].sort(() => Math.random() - 0.5).slice(0, 5);
      for (const [x, z] of spots) {
        const g = new THREE.Group();
        const crate = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 0.7), new THREE.MeshStandardMaterial({ color: '#c58f3a', roughness: 0.8 }));
        crate.position.y = 0.3; crate.castShadow = true; g.add(crate);
        const glow = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.05, 8, 24), new THREE.MeshStandardMaterial({ color: '#a5ff38', emissive: '#a5ff38', emissiveIntensity: 0.9 }));
        glow.rotation.x = Math.PI / 2; glow.position.y = 0.08; g.add(glow);
        g.position.set(x, 0, z); this.layer.add(g);
        a.crates.push({ x, z, mesh: g });
      }
      this.cb.objective('Market runs', 'Collect 5 crates in the market (NW block). 0 / 5');
      this.cb.toast('Five crates are glowing in the market. Go!');
    } else {
      a.timeLeft = 0;
      a.target = { x: -20, z: -8.3, label: 'QuickCash POS' };
      a.marker = makeMarker('💳', '#f5c242'); a.marker.position.set(-20, 0, -8.3); this.layer.add(a.marker);
      this.cb.objective('POS agent', 'Walk to the QuickCash stand (NW corner of the junction) to start your shift.');
      this.cb.toast('Shift accepted. Head to the QuickCash POS stand.');
    }
    this.active = a;
    this.cb.changed();
  }

  cancel(silent = false) {
    const a = this.active; if (!a) return;
    if (a.marker) this.layer.remove(a.marker);
    for (const c of a.crates) this.layer.remove(c.mesh);
    this.active = null;
    this.cb.clearObjective();
    if (!silent) this.cb.toast('Hustle cancelled. No vex.');
    this.cb.changed();
  }

  /** Current nav target for the minimap / marker. */
  target() { const a = this.active; if (!a) return null; if (a.target) return a.target; const c = a.crates[0]; return c ? { x: c.x, z: c.z, label: 'crate' } : null; }

  async update(dt: number, playerPos: THREE.Vector3, t: number) {
    const a = this.active; if (!a || a.busy) return;
    if (a.marker) animateMarker(a.marker, t);
    for (const c of a.crates) { c.mesh.rotation.y += dt; c.mesh.position.y = Math.sin(t * 3 + c.x) * 0.05; }
    if (a.timeLeft > 0) {
      a.timeLeft -= dt;
      if (a.timeLeft <= 0) { this.cb.toast('Time don finish. Hustle failed — try again.'); this.cancel(true); return; }
    }
    if (a.id === 'dispatch' && a.dest) {
      if (Math.hypot(playerPos.x - a.dest.x, playerPos.z - a.dest.z) < 2.6) {
        const bonus = Math.round(Math.max(0, a.timeLeft) * 7);
        this.cb.reward('dispatch', 45 + Math.round(bonus / 50), 1);
        this.cb.toast(`Delivered on time! +${Math.round(bonus / 50)} bonus XP 💚`);
        this.cancel(true);
      }
    } else if (a.id === 'market') {
      for (let i = a.crates.length - 1; i >= 0; i--) {
        const c = a.crates[i];
        if (Math.hypot(playerPos.x - c.x, playerPos.z - c.z) < 1.4) {
          this.layer.remove(c.mesh); a.crates.splice(i, 1); a.collected++;
          this.cb.objective('Market runs', `Collect 5 crates in the market. ${a.collected} / 5`);
          this.cb.toast(`Crate ${a.collected}/5 collected`);
        }
      }
      if (a.collected >= 5) {
        const bonus = Math.round(Math.max(0, a.timeLeft) * 8);
        this.cb.reward('market', 55 + Math.round(bonus / 50), 1);
        this.cb.toast(`Mama Bisi is happy! +${Math.round(bonus / 50)} bonus XP 💚`);
        this.cancel(true);
      }
    } else if (a.id === 'pos' && a.target) {
      if (Math.hypot(playerPos.x - a.target.x, playerPos.z - a.target.z) < 2.6) {
        a.busy = true;
        if (a.marker) { this.layer.remove(a.marker); a.marker = null; }
        this.cb.objective('POS agent', 'Serving customers… tap when the marker is in the green zone.');
        const ok = await this.cb.timing(5, 'QuickCash POS · serve the customer', 'Transaction approved ✅', 'Network error ❌ — customer vexed');
        if (ok >= 3) this.cb.reward('pos', ok * 12, 1); else this.cb.toast(`Only ${ok}/5 customers served — no pay this shift. Try again.`);
        this.cb.toast(ok === 5 ? 'Perfect shift! 💚' : `Shift over: ${ok}/5 customers served.`);
        this.cancel(true);
      }
    }
  }
}
