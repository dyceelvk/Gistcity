/**
 * Runtime tailoring for the realistic characters.
 *
 * MakeHuman ships clean "clothing helper" shells (CC0) that follow the body, its
 * morph targets and its skin weights: a full-body tights shell, a long skirt and
 * a scalp cap. tools/mh_export.py bakes them into the character GLBs together
 * with a per-vertex `_loop` id (the quad row each vertex belongs to) and a
 * `_region` id. Garments are then simply *subsets of triangles* of those shells,
 * cut along whole loops so every hem, cuff and neckline is a clean ring, and
 * pushed outwards along the normal in the vertex shader for thickness/looseness.
 *
 * Because every garment shares the shell's skinning and morph data it moves
 * exactly like the body underneath — no simulation, no retargeting.
 */
import * as THREE from 'three';
import type { Appearance, BottomStyle, TopStyle } from './appearance';

export type Part = 'torso' | 'collar' | 'arm' | 'leg' | 'foot';

export interface Bounds { ymin: number; ymax: number; pmin: number; pmax: number }

/** A baked helper shell plus the lookup tables tailoring needs. */
export interface Shell {
  geo: THREE.BufferGeometry;
  region: Uint8Array;
  loop: Float32Array;
  param: Float32Array;              // continuous along-part coordinate: y (m), or arc length for arms
  part: Uint8Array;                 // 0 torso 1 collar 2 arm 3 leg 4 foot
  index: Uint32Array;
  loops: Record<Part, number[]>;    // sorted distinct loop values with >= 6 vertices
}

export interface BodyInfo {
  regions: string[];
  bounds: Record<string, Bounds>;
  crotchY: number;
}

const PART_ID: Record<Part, number> = { torso: 0, collar: 1, arm: 2, leg: 3, foot: 4 };

export function partOfRegion(name: string): Part {
  if (name === 'head') return 'collar';
  if (name.startsWith('torso')) return 'torso';
  if (name.startsWith('foot')) return 'foot';
  if (name.startsWith('uarm') || name.startsWith('farm') || name.startsWith('hand')) return 'arm';
  return 'leg';
}

export function analyzeShell(geo: THREE.BufferGeometry, regions: string[], singlePart = false): Shell {
  const regAttr = geo.getAttribute('_region') as THREE.BufferAttribute;
  const loopAttr = geo.getAttribute('_loop') as THREE.BufferAttribute;
  const uvAttr = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const n = geo.getAttribute('position').count;
  const region = new Uint8Array(n), loop = new Float32Array(n), part = new Uint8Array(n), param = new Float32Array(n);
  const counts: Record<Part, Map<number, number>> = { torso: new Map(), collar: new Map(), arm: new Map(), leg: new Map(), foot: new Map() };
  for (let i = 0; i < n; i++) {
    region[i] = regAttr ? regAttr.getX(i) : 0;
    loop[i] = loopAttr ? Math.round(loopAttr.getX(i) * 1e4) / 1e4 : 0;
    param[i] = uvAttr ? uvAttr.getY(i) : loop[i];
    const p = singlePart ? 'torso' : partOfRegion(regions[region[i]] ?? 'torso');
    part[i] = PART_ID[p];
    counts[p].set(loop[i], (counts[p].get(loop[i]) ?? 0) + 1);
  }
  const loops = {} as Record<Part, number[]>;
  (Object.keys(counts) as Part[]).forEach((p) => {
    loops[p] = [...counts[p].entries()].filter(([, c]) => c >= 6).map(([v]) => v).sort((a, b) => a - b);
  });
  const idx = geo.getIndex()!;
  const index = new Uint32Array(idx.count);
  for (let i = 0; i < idx.count; i++) index[i] = idx.getX(i);
  return { geo, region, loop, param, part, index, loops };
}

/** Largest loop value <= y (falls back to the smallest loop). */
export function loopBelow(list: number[], y: number): number {
  let best = list[0] ?? y;
  for (const v of list) { if (v <= y) best = v; else break; }
  return best;
}
/** Smallest loop value >= y (falls back to the largest loop). */
export function loopAbove(list: number[], y: number): number {
  for (const v of list) if (v >= y) return v;
  return list[list.length - 1] ?? y;
}

/** Per-vertex signed "keep" distance (metres along the part); >= 0 keeps the vertex. */
export type CutField = (part: number, param: number, region: number, loop: number) => number;

const NEAREST = new Set(['skinIndex', 'skinWeight', '_region']);

/**
 * Garment = the shell triangles on the positive side of `field`. Triangles that
 * straddle the zero line are clipped exactly, so hems, cuffs, waists and necklines
 * are straight lines instead of the saw-tooth left by dropping whole triangles.
 * Vertices are compacted into fresh buffers (positions, normals, uvs, skinning,
 * helper ids and morph deltas), so every garment owns its geometry.
 */
export function cutShell(shell: Shell, field: CutField): THREE.BufferGeometry | null {
  const n = shell.loop.length;
  const sd = new Float32Array(n);
  for (let i = 0; i < n; i++) sd[i] = field(shell.part[i], shell.param[i], shell.region[i], shell.loop[i]);
  const src = shell.geo;
  const names = Object.keys(src.attributes);
  const attrs = names.map((name) => src.attributes[name] as THREE.BufferAttribute);
  const morphNames = Object.keys(src.morphAttributes) as (keyof typeof src.morphAttributes)[];
  const morphs = morphNames.map((k) => src.morphAttributes[k] as THREE.BufferAttribute[]);
  const outAttr: number[][] = attrs.map(() => []);
  const outMorph: number[][][] = morphs.map((list) => list.map(() => []));
  const remap = new Int32Array(n).fill(-1);
  const edgeCache = new Map<number, number>();
  const tri: number[] = [];
  let count = 0;

  const pushVertex = (a: number, b: number, t: number): number => {
    // t = 0 -> vertex a, t = 1 -> vertex b
    const near = t < 0.5 ? a : b;
    attrs.forEach((attr, k) => {
      const sz = attr.itemSize, o = outAttr[k];
      if (NEAREST.has(names[k])) { for (let c = 0; c < sz; c++) o.push(attr.getComponent(near, c)); return; }
      if (names[k] === 'normal') {
        let x = 0, y = 0, z = 0;
        x = attr.getX(a) * (1 - t) + attr.getX(b) * t; y = attr.getY(a) * (1 - t) + attr.getY(b) * t; z = attr.getZ(a) * (1 - t) + attr.getZ(b) * t;
        const l = Math.hypot(x, y, z) || 1; o.push(x / l, y / l, z / l); return;
      }
      for (let c = 0; c < sz; c++) o.push(attr.getComponent(a, c) * (1 - t) + attr.getComponent(b, c) * t);
    });
    morphs.forEach((list, m) => list.forEach((attr, j) => {
      const o = outMorph[m][j];
      for (let c = 0; c < attr.itemSize; c++) o.push(attr.getComponent(a, c) * (1 - t) + attr.getComponent(b, c) * t);
    }));
    return count++;
  };
  const vert = (i: number) => (remap[i] >= 0 ? remap[i] : (remap[i] = pushVertex(i, i, 0)));
  const cross = (a: number, b: number) => {
    const key = a < b ? a * n + b : b * n + a;
    let v = edgeCache.get(key);
    if (v === undefined) { const t = sd[a] / (sd[a] - sd[b]); v = pushVertex(a, b, Math.min(1, Math.max(0, t))); edgeCache.set(key, v); }
    return v;
  };

  const idx = shell.index;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ia = sd[a] >= 0, ib = sd[b] >= 0, ic = sd[c] >= 0;
    const inside = (ia ? 1 : 0) + (ib ? 1 : 0) + (ic ? 1 : 0);
    if (inside === 0) continue;
    if (inside === 3) { tri.push(vert(a), vert(b), vert(c)); continue; }
    // rotate so the odd vertex comes first
    let p = a, q = b, r = c;
    if (inside === 1) {
      if (ib) { p = b; q = c; r = a; } else if (ic) { p = c; q = a; r = b; }
      // p inside, q & r outside -> one triangle
      tri.push(vert(p), cross(p, q), cross(r, p));
    } else {
      if (!ib) { p = b; q = c; r = a; } else if (!ic) { p = c; q = a; r = b; }
      // p outside, q & r inside -> quad -> two triangles
      const pq = cross(p, q), rp = cross(r, p), vq = vert(q), vr = vert(r);
      tri.push(pq, vq, vr, pq, vr, rp);
    }
  }
  if (!tri.length) return null;
  const g = new THREE.BufferGeometry();
  attrs.forEach((attr, k) => {
    const name = names[k];
    const arr = name === 'skinIndex' ? new Uint16Array(outAttr[k]) : new Float32Array(outAttr[k]);
    g.setAttribute(name, new THREE.BufferAttribute(arr, attr.itemSize));
  });
  morphNames.forEach((k, m) => { g.morphAttributes[k] = outMorph[m].map((o, j) => new THREE.BufferAttribute(new Float32Array(o), morphs[m][j].itemSize)); });
  g.morphTargetsRelative = src.morphTargetsRelative;
  g.setIndex(new THREE.BufferAttribute(count > 65535 ? new Uint32Array(tri) : new Uint16Array(tri), 1));
  if (!src.boundingSphere) src.computeBoundingSphere();
  g.boundingSphere = src.boundingSphere;
  return g;
}

/* ------------------------------------------------------------------ outfit rules */

export interface Piece {
  name: string;
  geo: THREE.BufferGeometry;
  color: string;
  offset: number;          // metres pushed out along the normal
  fabric: Fabric;
  roughness?: number;
  morphs: 'body' | 'face' | 'none';
  /** Extra looseness that grows along the garment so cloth hangs instead of hugging the body. */
  drape?: { torso?: [fromY: number, toY: number, amount: number]; leg?: [fromY: number, toY: number, amount: number]; arm?: [len: number, amount: number] };
}
export type Fabric = 'plain' | 'knit' | 'twill' | 'ankara' | 'satin';

export interface Outfit { pieces: Piece[]; hide: Set<string> }

const LONG_SLEEVED: TopStyle[] = ['shirt', 'blazer', 'hoodie', 'native'];
const TOP_OFFSET: Record<TopStyle, number> = { tee: 0.010, crop: 0.009, shirt: 0.011, blazer: 0.018, hoodie: 0.020, native: 0.016 };
const TOP_FABRIC: Record<TopStyle, Fabric> = { tee: 'plain', crop: 'plain', shirt: 'twill', blazer: 'twill', hoodie: 'knit', native: 'ankara' };
const BOTTOM_OFFSET: Record<BottomStyle, number> = { trousers: 0.005, shorts: 0.005, joggers: 0.008, skirt: 0.004 };
const BOTTOM_FABRIC: Record<BottomStyle, Fabric> = { trousers: 'twill', shorts: 'twill', joggers: 'knit', skirt: 'plain' };

/**
 * Cut a full outfit for `a` out of the shells. Hems are chosen so that every body
 * region we hide underneath is guaranteed to be covered, whatever the body type.
 */
export function tailorOutfit(a: Appearance, tights: Shell, skirt: Shell, body: BodyInfo, quality: 'hi' | 'lo'): Outfit {
  const B = body.bounds;
  const b = (r: string) => B[r] ?? { ymin: 0, ymax: 0, pmin: 0, pmax: 0 };
  const T = tights.loops;
  const pieces: Piece[] = [];
  const hide = new Set<string>(['torso_up', 'torso_lo', 'uarm_hi_l', 'uarm_hi_r', 'thigh_hi_l', 'thigh_hi_r', 'foot_l', 'foot_r']);

  // --- top
  const top = a.top;
  const longSleeve = LONG_SLEEVED.includes(top);
  const crop = top === 'crop';
  const hipTop = b('thigh_hi_l').ymax;
  const lowestClean = body.crotchY + 0.06; // tights rows below this wrap each leg (bodysuit look)
  const longTop = top === 'hoodie' || top === 'blazer';
  // the tights torso piece stops at the hips; longer tops continue with a straight tube cut from the skirt shell
  const hem = Math.max(lowestClean, crop ? b('torso_up').ymin - 0.008 : hipTop - 0.035);
  const sleeve = longSleeve ? b('farm_l').pmax + 0.012 : b('uarm_hi_l').pmax + 0.03;
  const neckBase = b('torso_up').ymax + 0.003;
  const collarRise = top === 'hoodie' ? 0.05 : top === 'shirt' || top === 'native' ? 0.025 : 0.0;
  const collar = neckBase + collarRise;
  if (longSleeve) { hide.add('uarm_lo_l'); hide.add('uarm_lo_r'); hide.add('farm_l'); hide.add('farm_r'); }
  const topGeo = cutShell(tights, (p, v) =>
    p === 0 || p === 3 ? v - hem :
    p === 1 ? collar - v :
    p === 2 ? sleeve - v : -1);
  const chestY = b('torso_up').ymax - 0.13; // armpit line: cloth hangs from here
  const topDrape = { tee: 0.018, crop: 0.008, shirt: 0.016, blazer: 0.016, hoodie: 0.026, native: 0.03 }[top];
  const drape = { torso: [chestY, hem, topDrape] as [number, number, number], arm: [sleeve, longSleeve ? 0.01 : 0.006] as [number, number] };
  if (topGeo) pieces.push({ name: 'top', geo: topGeo, color: a.topColor, offset: TOP_OFFSET[top], fabric: TOP_FABRIC[top], morphs: 'body', drape });
  if (collarRise > 0 && quality === 'hi') {
    // raised collar band (shirt collar / hoodie neck)
    const bandGeo = cutShell(tights, (p, v) => p === 1 ? Math.min(v - (neckBase - 0.004), collar - v) : -1);
    if (bandGeo) pieces.push({ name: 'collar', geo: bandGeo, color: a.topColor, offset: TOP_OFFSET[top] + (top === 'hoodie' ? 0.010 : 0.004), fabric: TOP_FABRIC[top], morphs: 'body' });
  }
  if (longTop) {
    const longHem = body.crotchY - (top === 'blazer' ? 0.04 : 0.005);
    const hGeo = cutShell(skirt, (_p, v) => Math.min(v - longHem, hem + 0.03 - v));
    if (hGeo) pieces.push({ name: 'hip', geo: hGeo, color: a.topColor, offset: TOP_OFFSET[top] + topDrape * 0.8, fabric: TOP_FABRIC[top], morphs: 'body' });
  }
  if (top === 'native') {
    // kaftan: the torso piece continues as a knee-length skirt cut from the skirt shell
    const kneeHem = b('thigh_lo_l').ymin - 0.02;
    const kGeo = cutShell(skirt, (_p, v) => v - kneeHem);
    if (kGeo) pieces.push({ name: 'kaftan', geo: kGeo, color: a.topColor, offset: 0.014, fabric: 'ankara', morphs: 'body' });
  }

  // --- bottom
  const bottom = a.bottom;
  const waist = crop ? hem + 0.012 : hipTop + 0.006;
  if (bottom === 'skirt') {
    hide.add('thigh_lo_l'); hide.add('thigh_lo_r');
    const skirtHem = b('thigh_lo_l').ymin - 0.02;
    const sGeo = cutShell(skirt, (_p, v) => v - skirtHem);
    if (sGeo) pieces.push({ name: 'skirt', geo: sGeo, color: a.bottomColor, offset: BOTTOM_OFFSET.skirt, fabric: BOTTOM_FABRIC.skirt, morphs: 'body' });
    // high-waisted band bridging the skirt shell's own waistline and the top's hem (needed on taller bodies)
    const skirtTop = skirt.loops.torso[skirt.loops.torso.length - 1] ?? waist;
    if (skirtTop - 0.03 < waist) {
      const bandGeo = cutShell(tights, (p, v) => p === 0 ? Math.min(waist - v, v - (skirtTop - 0.03)) : -1);
      if (bandGeo) pieces.push({ name: 'skirt-band', geo: bandGeo, color: a.bottomColor, offset: 0.004, fabric: 'plain', morphs: 'body' });
    }
  } else {
    const legHem = bottom === 'shorts' ? b('thigh_hi_l').ymin - 0.03 : b('shin_l').ymin - 0.025;
    if (bottom !== 'shorts') { hide.add('thigh_lo_l'); hide.add('thigh_lo_r'); }
    const bGeo = cutShell(tights, (p, v) => p === 0 ? waist - v : p === 3 ? v - legHem : -1);
    const legDrape = { trousers: 0.02, joggers: 0.024, shorts: 0.012, skirt: 0 }[bottom];
    if (bGeo) pieces.push({ name: 'bottom', geo: bGeo, color: a.bottomColor, offset: BOTTOM_OFFSET[bottom], fabric: BOTTOM_FABRIC[bottom], morphs: 'body', drape: { leg: [hipTop - 0.05, legHem, legDrape] } });
    if (bottom === 'joggers' && quality === 'hi') {
      const cuffGeo = cutShell(tights, (p, v) => p === 3 ? Math.min(v - legHem, legHem + 0.045 - v) : -1);
      if (cuffGeo) pieces.push({ name: 'cuff', geo: cuffGeo, color: a.bottomColor, offset: 0.003, fabric: 'knit', morphs: 'body' });
    }
  }
  return { pieces, hide };
}

/* ------------------------------------------------------------------ fabric textures */

const texCache = new Map<string, THREE.Texture>();

function canvasTexture(key: string, size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void, repeat: [number, number]): THREE.Texture {
  let t = texCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, t);
  return t;
}

/** Deterministic noise so fabrics look identical for every player. */
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

export function fabricTexture(kind: Fabric, color: string): THREE.Texture | null {
  // UV u runs once around the limb/torso, v is metres along it (see mh_export.py).
  switch (kind) {
    case 'plain':
      return canvasTexture('plain', 64, (ctx, s) => {
        const r = rng(7); const img = ctx.createImageData(s, s);
        for (let i = 0; i < s * s; i++) { const v = 232 + Math.floor(r() * 23); img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
        ctx.putImageData(img, 0, 0);
      }, [40, 60]);
    case 'knit':
      return canvasTexture('knit', 64, (ctx, s) => {
        ctx.fillStyle = '#f2f2f2'; ctx.fillRect(0, 0, s, s);
        ctx.fillStyle = '#d8d8d8';
        for (let y = 0; y < s; y += 4) ctx.fillRect(0, y, s, 2);
        const r = rng(3); const img = ctx.getImageData(0, 0, s, s);
        for (let i = 0; i < s * s; i++) { const d = Math.floor(r() * 14) - 7; img.data[i * 4] += d; img.data[i * 4 + 1] += d; img.data[i * 4 + 2] += d; }
        ctx.putImageData(img, 0, 0);
      }, [30, 90]);
    case 'twill':
      return canvasTexture('twill', 64, (ctx, s) => {
        ctx.fillStyle = '#eeeeee'; ctx.fillRect(0, 0, s, s);
        ctx.strokeStyle = '#dcdcdc'; ctx.lineWidth = 1.5;
        for (let i = -s; i < s * 2; i += 5) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + s, s); ctx.stroke(); }
      }, [60, 90]);
    case 'satin':
      return null;
    case 'ankara': {
      const base = new THREE.Color(color);
      const hsl = { h: 0, s: 0, l: 0 }; base.getHSL(hsl);
      const acc1 = '#' + new THREE.Color().setHSL((hsl.h + 0.5) % 1, Math.max(0.55, hsl.s), hsl.l > 0.5 ? 0.3 : 0.62).getHexString();
      const acc2 = hsl.l > 0.6 ? '#1a1410' : '#f6ecd2';
      return canvasTexture('ankara|' + color, 256, (ctx, s) => {
        ctx.fillStyle = color; ctx.fillRect(0, 0, s, s);
        const cell = s / 4;
        for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 4; gx++) {
          const cx = gx * cell + cell / 2, cy = gy * cell + cell / 2;
          const alt = (gx + gy) % 2 === 0;
          ctx.strokeStyle = acc2; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(cx, cy, cell * 0.36, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle = alt ? acc1 : acc2;
          ctx.beginPath();
          for (let k = 0; k < 8; k++) { const ang = (k / 8) * Math.PI * 2; const rr = k % 2 ? cell * 0.12 : cell * 0.26; ctx.lineTo(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr); }
          ctx.closePath(); ctx.fill();
          ctx.fillStyle = alt ? acc2 : acc1;
          ctx.beginPath(); ctx.arc(cx, cy, cell * 0.08, 0, Math.PI * 2); ctx.fill();
          // small dots between motifs
          ctx.fillStyle = acc2;
          ctx.beginPath(); ctx.arc(gx * cell, gy * cell, 4, 0, Math.PI * 2); ctx.fill();
        }
      }, [3, 6]);
    }
  }
}

/* ------------------------------------------------------------------ cloth material */

const SHELL_VERTEX = `
#include <skinning_vertex>`;

/** MeshStandardMaterial that inflates the shell along its (bind-pose) normal. */
export function clothMaterial(piece: Piece, quality: 'hi' | 'lo'): THREE.MeshStandardMaterial {
  const tex = quality === 'lo' && piece.fabric !== 'ankara' ? null : fabricTexture(piece.fabric, piece.color);
  const m = new THREE.MeshStandardMaterial({
    color: piece.fabric === 'ankara' ? '#ffffff' : piece.color,
    map: tex,
    roughness: piece.roughness ?? (piece.fabric === 'satin' ? 0.35 : 0.9),
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const offset = { value: piece.offset };
  const d = piece.drape ?? {};
  const torso = { value: new THREE.Vector3(d.torso?.[0] ?? 0, d.torso?.[1] ?? -1, d.torso?.[2] ?? 0) };
  const leg = { value: new THREE.Vector3(d.leg?.[0] ?? 0, d.leg?.[1] ?? -1, d.leg?.[2] ?? 0) };
  const arm = { value: new THREE.Vector2(d.arm?.[0] ?? 1, d.arm?.[1] ?? 0) };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uShellOffset = offset;
    sh.uniforms.uDrapeTorso = torso; sh.uniforms.uDrapeLeg = leg; sh.uniforms.uDrapeArm = arm;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uShellOffset; uniform vec3 uDrapeTorso; uniform vec3 uDrapeLeg; uniform vec2 uDrapeArm;
attribute float _region; attribute float _loop;`)
      .replace('#include <skinning_vertex>', `
float gOff = uShellOffset;
float gReg = floor(_region + 0.5);
if (gReg < 0.5) { /* collar */ }
else if (gReg < 2.5) gOff += uDrapeTorso.z * clamp((uDrapeTorso.x - _loop) / max(0.01, uDrapeTorso.x - uDrapeTorso.y), 0.0, 1.0);
else if (gReg < 10.5) gOff += uDrapeArm.y * clamp(_loop / max(0.01, uDrapeArm.x), 0.0, 1.0);
else gOff += uDrapeLeg.z * clamp((uDrapeLeg.x - _loop) / max(0.01, uDrapeLeg.x - uDrapeLeg.y), 0.0, 1.0);
transformed += normal * gOff;` + SHELL_VERTEX);
  };
  m.customProgramCacheKey = () => 'gist-cloth';
  m.userData.offset = offset;
  return m;
}
