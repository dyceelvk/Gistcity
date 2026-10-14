/** Circle-vs-AABB collision with sliding, plus a camera occlusion helper. */
import type { AABB } from './props';

/** Push `pos` (x,z) out of every collider it overlaps. Mutates and returns pos. */
export function resolveCircle(pos: { x: number; z: number }, r: number, colliders: AABB[], iterations = 3) {
  for (let it = 0; it < iterations; it++) {
    let hit = false;
    for (const c of colliders) {
      // quick reject
      if (pos.x + r < c.minX || pos.x - r > c.maxX || pos.z + r < c.minZ || pos.z - r > c.maxZ) continue;
      const cx = Math.max(c.minX, Math.min(pos.x, c.maxX));
      const cz = Math.max(c.minZ, Math.min(pos.z, c.maxZ));
      let dx = pos.x - cx, dz = pos.z - cz;
      let d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      hit = true;
      if (d2 < 1e-8) {
        // centre is inside the box: push out through the nearest face
        const l = pos.x - c.minX, rr = c.maxX - pos.x, t = pos.z - c.minZ, b = c.maxZ - pos.z;
        const m = Math.min(l, rr, t, b);
        if (m === l) pos.x = c.minX - r; else if (m === rr) pos.x = c.maxX + r; else if (m === t) pos.z = c.minZ - r; else pos.z = c.maxZ + r;
        continue;
      }
      const d = Math.sqrt(d2);
      const push = r - d;
      pos.x += (dx / d) * push;
      pos.z += (dz / d) * push;
    }
    if (!hit) break;
  }
  return pos;
}

export function pointInside(x: number, y: number, z: number, colliders: AABB[]) {
  for (const c of colliders) if (x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && y < c.h) return true;
  return false;
}
