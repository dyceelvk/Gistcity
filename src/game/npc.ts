/** Pedestrians that keep the streets alive — and gist with you if you say hi. */
import * as THREE from 'three';
import { makeCharacter, type Character } from './character';
import { randomAppearance } from './appearance';
import { makeSprite } from './props';

export const NAMES = ['Tunde', 'Chioma', 'Emeka', 'Aisha', 'Seun', 'Ngozi', 'Ibrahim', 'Blessing', 'Kelechi', 'Funke', 'Musa', 'Adaeze', 'Tobi', 'Zainab', 'Ebuka', 'Yemi', 'Amara', 'Dayo'];
export const GIST_LINES = [
  'How far?', 'Omo, this sun no be here o.', 'You don chop?', 'Wetin dey sup?', 'No wahala.', 'Area!', 'E choke!',
  'Where you dey go sharp sharp?', 'Abeg, you get change for 1k?', 'Na you dey this area?', 'God when? 😩',
  'Suya spot dey burst today.', 'Light don come? Make I rush go iron.', 'This your fit sweet die!', 'Make we link up later.',
  'Danfo conductor nearly carry me go Oshodi.', 'Who get this weekend? Owambe loading.', 'My guy, long time!',
];

interface Npc {
  avatar: Character;
  name: string;
  path: THREE.Vector3[];
  idx: number;
  speed: number;
  yaw: number;
  bubble: THREE.Sprite | null;
  bubbleT: number;
  pauseT: number;
}

export class NpcManager {
  npcs: Npc[] = [];
  group = new THREE.Group();

  constructor(paths: THREE.Vector3[][], count = 14) {
    let seed = 17;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < count; i++) {
      const path = paths[i % paths.length];
      const avatar = makeCharacter(randomAppearance(i * 31 + 7), 'lo');
      const idx = Math.floor(rnd() * path.length);
      const start = path[idx].clone();
      const next = path[(idx + 1) % path.length];
      start.lerp(next, rnd());
      avatar.root.position.copy(start);
      const name = NAMES[i % NAMES.length];
      const tag = makeSprite(name, { scale: 0.55, bg: 'rgba(8,12,9,0.55)' });
      tag.position.y = 2.1;
      avatar.root.add(tag);
      this.group.add(avatar.root);
      this.npcs.push({ avatar, name, path, idx: (idx + 1) % path.length, speed: 1.0 + rnd() * 0.5, yaw: 0, bubble: null, bubbleT: 0, pauseT: 0 });
    }
  }

  update(dt: number, playerPos: THREE.Vector3) {
    for (const n of this.npcs) {
      const pos = n.avatar.root.position;
      if (n.pauseT > 0) { n.pauseT -= dt; n.avatar.animate(dt, 0); }
      else {
        const target = n.path[n.idx];
        const dx = target.x - pos.x, dz = target.z - pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.35) { n.idx = (n.idx + 1) % n.path.length; if (Math.random() < 0.15) n.pauseT = 1 + Math.random() * 3; }
        else {
          // keep a little personal space from the player
          const pdx = pos.x - playerPos.x, pdz = pos.z - playerPos.z, pd = Math.hypot(pdx, pdz);
          let vx = dx / dist, vz = dz / dist;
          if (pd < 1.2 && pd > 0.01) { vx += (pdx / pd) * 0.8; vz += (pdz / pd) * 0.8; }
          pos.x += vx * n.speed * dt; pos.z += vz * n.speed * dt;
          const yaw = Math.atan2(vx, vz);
          let diff = yaw - n.yaw; while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
          n.yaw += diff * Math.min(1, dt * 8);
          n.avatar.root.rotation.y = n.yaw;
          n.avatar.animate(dt, 1, n.speed);
        }
      }
      if (n.bubble) { n.bubbleT -= dt; if (n.bubbleT <= 0) { n.avatar.root.remove(n.bubble); n.bubble = null; } }
    }
  }

  nearest(pos: THREE.Vector3, radius: number): Npc | null {
    let best: Npc | null = null, bd = radius;
    for (const n of this.npcs) { const d = n.avatar.root.position.distanceTo(pos); if (d < bd) { bd = d; best = n; } }
    return best;
  }

  say(n: Npc, text: string, seconds = 3.2) {
    if (n.bubble) n.avatar.root.remove(n.bubble);
    const b = makeSprite(text, { scale: 0.9, bg: 'rgba(246,248,244,0.95)', fg: '#0b0e0c' });
    b.position.y = 2.55;
    n.avatar.root.add(b);
    n.bubble = b; n.bubbleT = seconds;
    n.pauseT = Math.max(n.pauseT, seconds * 0.8);
    // face the speaker's conversation partner later via caller
  }

  faceTowards(n: Npc, p: THREE.Vector3) {
    const d = p.clone().sub(n.avatar.root.position);
    n.yaw = Math.atan2(d.x, d.z);
    n.avatar.root.rotation.y = n.yaw;
  }
}
export type { Npc };
