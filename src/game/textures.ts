/**
 * Procedural texture library — everything is generated on a canvas at boot,
 * no asset downloads. Textures are cached by key and shared so the static
 * bake can still merge geometry by material.
 */
import * as THREE from 'three';

const cache = new Map<string, THREE.Texture>();

function canvas(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function memo(key: string, make: () => THREE.Texture): THREE.Texture {
  let t = cache.get(key);
  if (!t) { t = make(); cache.set(key, t); }
  return t;
}

/** Deterministic pseudo-random in [0,1). */
function rnd(seed: number) {
  let s = seed * 9301 + 49297;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

function speckle(g: CanvasRenderingContext2D, s: number, n: number, colors: string[], rMin: number, rMax: number, alpha: number, seed: number) {
  const r = rnd(seed);
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[Math.floor(r() * colors.length)] ?? colors[0]!;
    g.globalAlpha = alpha * (0.5 + r() * 0.5);
    const rad = rMin + r() * (rMax - rMin);
    g.beginPath();
    g.arc(r() * s, r() * s, rad, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}

function streaks(g: CanvasRenderingContext2D, s: number, n: number, color: string, alpha: number, seed: number) {
  const r = rnd(seed);
  g.strokeStyle = color;
  for (let i = 0; i < n; i++) {
    g.globalAlpha = alpha * (0.35 + r() * 0.65);
    g.lineWidth = 1 + r() * 3;
    const x = r() * s;
    g.beginPath();
    g.moveTo(x, r() * s * 0.3);
    g.lineTo(x + (r() - 0.5) * 18, s * (0.5 + r() * 0.5));
    g.stroke();
  }
  g.globalAlpha = 1;
}

/** Painted plaster wall — mottled, faintly weathered. One tile ≈ 3 m. */
export function plasterTex(color: string): THREE.Texture {
  return memo('plaster:' + color, () => canvas(256, (g, s) => {
    g.fillStyle = color; g.fillRect(0, 0, s, s);
    speckle(g, s, 260, ['#ffffff', '#000000', color], 2, 16, 0.06, 11);
    streaks(g, s, 10, '#000000', 0.05, 21);
    streaks(g, s, 6, '#ffffff', 0.05, 22);
  }));
}

/** Dark asphalt with aggregate speckle and worn patches. One tile ≈ 6 m. */
export function asphaltTex(): THREE.Texture {
  return memo('asphalt', () => canvas(256, (g, s) => {
    g.fillStyle = '#2b2f34'; g.fillRect(0, 0, s, s);
    speckle(g, s, 700, ['#3c4147', '#22262a', '#454a50', '#1c1f22'], 0.6, 2.6, 0.55, 31);
    speckle(g, s, 26, ['#565c63', '#26292d'], 6, 22, 0.10, 32); // worn patches
  }));
}

/** Concrete pavement slabs with joints. One tile ≈ 3 m (2 slabs). */
export function sidewalkTex(): THREE.Texture {
  return memo('sidewalk', () => canvas(256, (g, s) => {
    g.fillStyle = '#a9a69c'; g.fillRect(0, 0, s, s);
    speckle(g, s, 420, ['#b8b5ab', '#96938a', '#c2bfb5'], 1, 5, 0.35, 41);
    g.strokeStyle = '#7e7b72'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(0, 0.5); g.lineTo(s, 0.5); g.moveTo(0.5, 0); g.lineTo(0.5, s); g.stroke();
    g.strokeStyle = '#918e85'; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(0, s / 2); g.lineTo(s, s / 2); g.moveTo(s / 2, 0); g.lineTo(s / 2, s); g.stroke();
  }));
}

/** Lawn / field grass with soil showing through. One tile ≈ 4 m. */
export function grassTex(tint = '#6f9149'): THREE.Texture {
  return memo('grass:' + tint, () => canvas(256, (g, s) => {
    g.fillStyle = tint; g.fillRect(0, 0, s, s);
    speckle(g, s, 90, ['#7fa356', '#5d7c3c', '#86a95c', '#516e35'], 8, 26, 0.22, 51);
    speckle(g, s, 26, ['#8a7b52', '#6b8f42', '#49632e'], 10, 30, 0.10, 52); // bare soil / clumps
  }));
}

/** Dry red-ochre earth (market lots, building plots). One tile ≈ 4 m. */
export function earthTex(tint = '#a58c72'): THREE.Texture {
  return memo('earth:' + tint, () => canvas(256, (g, s) => {
    g.fillStyle = tint; g.fillRect(0, 0, s, s);
    speckle(g, s, 520, ['#b39a7e', '#8f775f', '#c0a888', '#7c6650'], 1, 6, 0.5, 61);
    streaks(g, s, 12, '#7c6650', 0.12, 62);
  }));
}

/** Roof tiles — rows of rounded shingles with shading. One tile ≈ 2 m. */
export function roofTilesTex(color = '#46525c'): THREE.Texture {
  return memo('tiles:' + color, () => canvas(256, (g, s) => {
    g.fillStyle = color; g.fillRect(0, 0, s, s);
    const rows = 6, cols = 8, rh = s / rows, cw = s / cols;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * cw * 0.5;
      for (let c = -1; c < cols + 1; c++) {
        const x = c * cw + off, y = r * rh;
        const grd = g.createLinearGradient(x, y, x, y + rh);
        grd.addColorStop(0, 'rgba(255,255,255,0.16)');
        grd.addColorStop(0.55, 'rgba(0,0,0,0.0)');
        grd.addColorStop(1, 'rgba(0,0,0,0.30)');
        g.fillStyle = grd;
        g.fillRect(x, y, cw - 1, rh);
        g.fillStyle = 'rgba(0,0,0,0.22)';
        g.fillRect(x, y + rh - 2.5, cw - 1, 2.5);
      }
    }
    speckle(g, s, 160, ['#ffffff', '#000000'], 1, 3, 0.06, 71);
  }));
}

/** Tree bark — vertical ridges. */
export function barkTex(color = '#6b4f37'): THREE.Texture {
  return memo('bark:' + color, () => canvas(128, (g, s) => {
    g.fillStyle = color; g.fillRect(0, 0, s, s);
    const r = rnd(81);
    for (let i = 0; i < 34; i++) {
      g.strokeStyle = r() > 0.5 ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.22)';
      g.lineWidth = 1 + r() * 5;
      const x = r() * s;
      g.beginPath();
      g.moveTo(x, -4);
      g.bezierCurveTo(x + (r() - 0.5) * 10, s * 0.33, x + (r() - 0.5) * 10, s * 0.66, x + (r() - 0.5) * 14, s + 4);
      g.stroke();
    }
  }));
}

/**
 * Leaf-cluster cutout for billboard foliage planes: overlapping leaf blobs on
 * transparent background. The silhouette is what sells the tree from afar.
 */
export function leafTex(): THREE.Texture {
  return memo('leaf', () => {
    const t = canvas(256, (g, s) => {
      const r = rnd(91);
      // soft central mass
      for (let i = 0; i < 190; i++) {
        const a = r() * Math.PI * 2;
        const rad = Math.pow(r(), 0.62) * s * 0.46;
        const x = s / 2 + Math.cos(a) * rad, y = s / 2 + Math.sin(a) * rad * 0.92;
        const lr = 9 + r() * 17;
        const shade = 0.55 + 0.45 * (1 - rad / (s * 0.5));
        const green = Math.floor(92 + shade * 70 + r() * 26);
        g.fillStyle = `rgb(${Math.floor(green * 0.42)},${green},${Math.floor(green * 0.52)})`;
        g.beginPath();
        g.ellipse(x, y, lr, lr * (0.6 + r() * 0.4), a, 0, Math.PI * 2);
        g.fill();
      }
      // dark core shading
      const grd = g.createRadialGradient(s / 2, s / 2, s * 0.05, s / 2, s / 2, s * 0.5);
      grd.addColorStop(0, 'rgba(0,20,0,0.35)');
      grd.addColorStop(1, 'rgba(0,20,0,0)');
      g.fillStyle = grd; g.fillRect(0, 0, s, s);
    });
    return t;
  });
}

/** Palm-frond cutout: a stem with leaflets down both sides. */
export function frondTex(): THREE.Texture {
  return memo('frond', () => {
    const t = canvas(256, (g, s) => {
      const r = rnd(101);
      // stem
      g.strokeStyle = '#4c6b34'; g.lineWidth = 7;
      g.beginPath(); g.moveTo(8, s / 2); g.quadraticCurveTo(s * 0.55, s * 0.42, s - 6, s / 2); g.stroke();
      // leaflets
      const n = 26;
      for (let i = 0; i < n; i++) {
        const t0 = i / (n - 1);
        const x = 10 + t0 * (s - 22);
        const y = s / 2 - Math.sin(t0 * Math.PI) * s * 0.07;
        const len = Math.sin(t0 * Math.PI) * s * 0.40 + 10;
        for (const dir of [-1, 1]) {
          const tilt = dir * (0.9 - t0 * 0.35) + (r() - 0.5) * 0.25;
          const green = Math.floor(120 + r() * 50);
          g.strokeStyle = `rgb(${Math.floor(green * 0.40)},${green},${Math.floor(green * 0.48)})`;
          g.lineWidth = 3.2 + r() * 2.2;
          g.beginPath();
          g.moveTo(x, y);
          g.quadraticCurveTo(x + 12 * dir, y + dir * len * 0.55, x + 20 * dir, y + dir * len);
          g.stroke();
        }
      }
    });
    return t;
  });
}

/** Soft cloud puff (radial alpha) for billboard clouds. */
export function cloudPuffTex(): THREE.Texture {
  return memo('puff', () => {
    const t = canvas(128, (g, s) => {
      const grd = g.createRadialGradient(s / 2, s / 2, s * 0.06, s / 2, s / 2, s * 0.5);
      grd.addColorStop(0, 'rgba(255,255,255,0.95)');
      grd.addColorStop(0.55, 'rgba(255,255,255,0.55)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, s, s);
    });
    return t;
  });
}

/** Clone a texture with its own repeat (images stay shared). */
export function tiled(t: THREE.Texture, rx: number, ry: number): THREE.Texture {
  const c = t.clone();
  c.needsUpdate = true;
  c.repeat.set(rx, ry);
  return c;
}

/** Shared material builders (cached per variant so the bake can batch). */
export function wallMaterial(color: string): THREE.MeshStandardMaterial {
  const key = 'wallM:' + color;
  let m = cache.get(key) as unknown as THREE.MeshStandardMaterial | undefined;
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map: plasterTex(color), roughness: 0.92, metalness: 0.02 });
    cache.set(key, m as unknown as THREE.Texture);
  }
  return m;
}

export function tiledRoofMaterial(color: string): THREE.MeshStandardMaterial {
  const key = 'roofM:' + color;
  let m = cache.get(key) as unknown as THREE.MeshStandardMaterial | undefined;
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map: roofTilesTex(color), roughness: 0.88, metalness: 0.04 });
    cache.set(key, m as unknown as THREE.Texture);
  }
  return m;
}
