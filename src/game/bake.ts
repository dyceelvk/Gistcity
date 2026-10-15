/**
 * Static batching: merges every non-animated mesh under a group into one mesh
 * per material. The city is built from hundreds of small boxes; after baking
 * it renders in a few dozen draw calls, which is what keeps phones at 60 fps.
 * Shared materials (windows, street lamps) stay shared, so the day/night
 * cycle can still switch their emissive glow.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function bakeStatic(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[]; shadow: boolean }>();
  // Materials with identical looks share a bucket (the first one seen is kept, so shared
  // day/night materials created first — windows, lamps — remain the live instance).
  const keyOf = (m: THREE.Material): string => {
    if (m.userData.live) return 'live:' + m.uuid; // animated at runtime (day/night) — never alias
    const s = m as THREE.MeshStandardMaterial;
    const col = s.color ? s.color.getHex() : 0, em = s.emissive ? s.emissive.getHex() : 0;
    return [m.type, col, (s.roughness ?? 0).toFixed(1), (s.metalness ?? 0).toFixed(1), em, s.emissiveIntensity ?? 0, m.transparent ? s.opacity : 1, m.side, m.depthWrite].join('|');
  };
  const remove: THREE.Mesh[] = [];
  const walk = (o: THREE.Object3D) => {
    if (o.userData.dynamic) return;
    const m = o as THREE.Mesh;
    if (m.isMesh && !(m as any).isSkinnedMesh && !Array.isArray(m.material)) {
      const mat = m.material as THREE.Material & { map?: THREE.Texture | null };
      const geo = m.geometry;
      const ok = geo.index && geo.attributes.position && geo.attributes.normal && geo.attributes.uv && !geo.morphAttributes?.position;
      if (ok && !mat.map && !m.userData.keep) {
        const g = geo.clone(); g.applyMatrix4(m.matrixWorld);
        for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
        const key = keyOf(mat);
        const b = buckets.get(key) ?? { mat, geos: [], shadow: false };
        b.geos.push(g); b.shadow ||= m.castShadow; buckets.set(key, b);
        remove.push(m);
        return;
      }
    }
    for (const c of [...o.children]) walk(c);
  };
  for (const c of [...root.children]) walk(c);
  for (const m of remove) m.parent?.remove(m);
  let merged = 0;
  for (const b of buckets.values()) {
    const mat = b.mat;
    const g = mergeGeometries(b.geos, false);
    for (const x of b.geos) x.dispose();
    if (!g) continue;
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = b.shadow; mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    root.add(mesh); merged++;
  }
  // prune emptied groups
  const prune = (o: THREE.Object3D) => { for (const c of [...o.children]) { prune(c); if (c.type === 'Group' && c.children.length === 0 && !c.userData.dynamic) o.remove(c); } };
  prune(root);
  return { removed: remove.length, meshes: merged };
}
