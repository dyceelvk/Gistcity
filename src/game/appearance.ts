/**
 * Appearance schema, style presets and the item catalogue.
 *
 * The same `Appearance` object is what gets saved to Supabase
 * (`gist_players.appearance`), broadcast to other players over Realtime and
 * handed to `buildAvatar()`. Swapping the procedural avatar for rigged GLTF
 * models later only changes the renderer — not this schema.
 */

export type HairStyle = 'lowcut' | 'fade' | 'afro' | 'braids' | 'bun' | 'locs' | 'gele' | 'bald';
export type FaceShape = 'oval' | 'round' | 'square';
export type Beard = 'none' | 'goatee' | 'full';
export type TopStyle = 'tee' | 'shirt' | 'blazer' | 'crop' | 'hoodie' | 'native';
export type BottomStyle = 'trousers' | 'shorts' | 'skirt' | 'joggers';
export type Accessory = 'cap' | 'glasses' | 'chain' | 'bag' | 'earrings' | 'watch';
export type Vibe = 'Casual' | 'Street' | 'Baddie' | 'Luxury' | 'Corporate' | 'Custom';

export interface Appearance {
  skin: string;
  hair: HairStyle;
  hairColor: string;
  face: FaceShape;
  beard: Beard;
  /** Lip colour (makeup). `null` = natural. */
  lips: string | null;
  top: TopStyle;
  topColor: string;
  bottom: BottomStyle;
  bottomColor: string;
  shoesColor: string;
  accessories: Accessory[];
  vibe: Vibe;
}

export const SKIN_TONES = ['#4a2a1c', '#5c3522', '#6e4029', '#86512f', '#9a6240', '#b07a52', '#c58f66', '#d9a981'];
export const HAIR_COLORS = ['#120d0a', '#2a1a10', '#4a2a16', '#7a4a22', '#b5651d', '#d9b14a', '#e8e4dc', '#c0392b', '#8e44ad', '#1e90ff'];
export const CLOTH_COLORS = [
  '#f4f0e7', '#1a1a1a', '#a5ff38', '#1f3a93', '#e33e79', '#f5c242', '#2ecc71', '#8e44ad',
  '#e74c3c', '#16a085', '#d8b46a', '#5d4037', '#95a5a6', '#ff7f50', '#00bcd4', '#6c5ce7',
];
export const LIP_COLORS: (string | null)[] = [null, '#8b2d3c', '#c0392b', '#e91e63', '#b86b5b', '#5a2a2a'];

export const HAIR_STYLES: { id: HairStyle; label: string }[] = [
  { id: 'lowcut', label: 'Low cut' },
  { id: 'fade', label: 'Fade' },
  { id: 'afro', label: 'Afro' },
  { id: 'braids', label: 'Braids' },
  { id: 'locs', label: 'Locs' },
  { id: 'bun', label: 'Bun' },
  { id: 'gele', label: 'Gele' },
  { id: 'bald', label: 'Bald' },
];
export const FACE_SHAPES: { id: FaceShape; label: string }[] = [
  { id: 'oval', label: 'Oval' },
  { id: 'round', label: 'Round' },
  { id: 'square', label: 'Square' },
];
export const BEARDS: { id: Beard; label: string }[] = [
  { id: 'none', label: 'Clean' },
  { id: 'goatee', label: 'Goatee' },
  { id: 'full', label: 'Full beard' },
];
export const TOPS: { id: TopStyle; label: string; free: boolean }[] = [
  { id: 'tee', label: 'T-shirt', free: true },
  { id: 'shirt', label: 'Shirt', free: true },
  { id: 'hoodie', label: 'Hoodie', free: false },
  { id: 'crop', label: 'Crop top', free: false },
  { id: 'blazer', label: 'Blazer', free: false },
  { id: 'native', label: 'Native (Senator)', free: false },
];
export const BOTTOMS: { id: BottomStyle; label: string; free: boolean }[] = [
  { id: 'trousers', label: 'Trousers', free: true },
  { id: 'shorts', label: 'Shorts', free: true },
  { id: 'joggers', label: 'Joggers', free: true },
  { id: 'skirt', label: 'Skirt', free: false },
];
export const ACCESSORIES: { id: Accessory; label: string }[] = [
  { id: 'cap', label: 'Cap' },
  { id: 'glasses', label: 'Shades' },
  { id: 'chain', label: 'Chain' },
  { id: 'bag', label: 'Bag' },
  { id: 'watch', label: 'Watch' },
  { id: 'earrings', label: 'Earrings' },
];

export const DEFAULT_APPEARANCE: Appearance = {
  skin: '#86512f',
  hair: 'lowcut',
  hairColor: '#120d0a',
  face: 'oval',
  beard: 'none',
  lips: null,
  top: 'tee',
  topColor: '#a5ff38',
  bottom: 'trousers',
  bottomColor: '#27323a',
  shoesColor: '#1a1a1a',
  accessories: [],
  vibe: 'Casual',
};

/** One-tap style directions. Items the player does not own are skipped at apply time. */
export const VIBE_PRESETS: Record<Exclude<Vibe, 'Custom'>, Partial<Appearance>> = {
  Casual: { top: 'tee', topColor: '#f4f0e7', bottom: 'joggers', bottomColor: '#27323a', shoesColor: '#f4f0e7', accessories: [] },
  Street: { top: 'hoodie', topColor: '#1a1a1a', bottom: 'joggers', bottomColor: '#95a5a6', shoesColor: '#e74c3c', accessories: ['cap', 'chain'] },
  Baddie: { top: 'crop', topColor: '#e33e79', bottom: 'skirt', bottomColor: '#1a1a1a', shoesColor: '#f4f0e7', accessories: ['earrings', 'bag', 'glasses'], lips: '#c0392b' },
  Luxury: { top: 'blazer', topColor: '#f4f0e7', bottom: 'trousers', bottomColor: '#f4f0e7', shoesColor: '#d8b46a', accessories: ['watch', 'glasses', 'chain'] },
  Corporate: { top: 'blazer', topColor: '#1f3a93', bottom: 'trousers', bottomColor: '#1a1a1a', shoesColor: '#5d4037', accessories: ['watch'] },
};

export type ItemCategory = 'top' | 'bottom' | 'accessory' | 'furniture';

export interface StoreItem {
  id: string;
  name: string;
  category: ItemCategory;
  price: number;
  desc: string;
  /** What owning this item unlocks. */
  unlock: { top?: TopStyle; bottom?: BottomStyle; accessory?: Accessory; furniture?: string };
  /** Colour applied when you equip it from the store. */
  color?: string;
}

export const STORE: StoreItem[] = [
  { id: 'hoodie-black', name: 'Lagos Nights Hoodie', category: 'top', price: 3500, desc: 'Heavy cotton, streetwear staple.', unlock: { top: 'hoodie' }, color: '#1a1a1a' },
  { id: 'crop-pink', name: 'Baddie Crop Set', category: 'top', price: 4200, desc: 'Crop top, main-character energy.', unlock: { top: 'crop' }, color: '#e33e79' },
  { id: 'blazer-navy', name: 'Marina Blazer', category: 'top', price: 7500, desc: 'Corporate Island fit.', unlock: { top: 'blazer' }, color: '#1f3a93' },
  { id: 'native-gold', name: 'Senator Native', category: 'top', price: 9000, desc: 'Owambe ready. Tailored kaftan.', unlock: { top: 'native' }, color: '#d8b46a' },
  { id: 'skirt-black', name: 'Pencil Skirt', category: 'bottom', price: 2800, desc: 'Sharp and simple.', unlock: { bottom: 'skirt' }, color: '#1a1a1a' },
  { id: 'acc-cap', name: 'Snapback Cap', category: 'accessory', price: 1500, desc: 'Keep the sun off your gist.', unlock: { accessory: 'cap' } },
  { id: 'acc-glasses', name: 'Designer Shades', category: 'accessory', price: 2500, desc: 'See everybody, let nobody see you.', unlock: { accessory: 'glasses' } },
  { id: 'acc-chain', name: 'Cuban Chain', category: 'accessory', price: 6000, desc: 'Big boy / big girl lifestyle.', unlock: { accessory: 'chain' } },
  { id: 'acc-bag', name: 'Mini Bag', category: 'accessory', price: 3200, desc: 'Carries phone, charger and vibes.', unlock: { accessory: 'bag' } },
  { id: 'acc-watch', name: 'Gold Watch', category: 'accessory', price: 8000, desc: 'Time na money.', unlock: { accessory: 'watch' } },
  { id: 'acc-earrings', name: 'Hoop Earrings', category: 'accessory', price: 1800, desc: 'Small detail, big difference.', unlock: { accessory: 'earrings' } },
  { id: 'furn-bed', name: 'Queen Bed', category: 'furniture', price: 6000, desc: 'Sleep like you have no landlord.', unlock: { furniture: 'bed' } },
  { id: 'furn-sofa', name: 'Velvet Sofa', category: 'furniture', price: 7000, desc: 'For gist sessions.', unlock: { furniture: 'sofa' } },
  { id: 'furn-tv', name: '55" Smart TV', category: 'furniture', price: 9500, desc: 'Big Brother on a big screen.', unlock: { furniture: 'tv' } },
  { id: 'furn-rug', name: 'Ankara Rug', category: 'furniture', price: 2200, desc: 'Pattern on pattern.', unlock: { furniture: 'rug' } },
  { id: 'furn-plant', name: 'Monstera Plant', category: 'furniture', price: 1200, desc: 'Aesthetic. Alive. Mostly.', unlock: { furniture: 'plant' } },
  { id: 'furn-fridge', name: 'Double-door Fridge', category: 'furniture', price: 8000, desc: 'Cold zobo on demand.', unlock: { furniture: 'fridge' } },
  { id: 'furn-ac', name: 'Split AC', category: 'furniture', price: 7500, desc: 'Heat? Which heat?', unlock: { furniture: 'ac' } },
  { id: 'furn-art', name: 'Wall Art', category: 'furniture', price: 1800, desc: 'A Lagos skyline print.', unlock: { furniture: 'art' } },
  { id: 'furn-lamp', name: 'Floor Lamp', category: 'furniture', price: 1400, desc: 'Soft light for soft life.', unlock: { furniture: 'lamp' } },
  { id: 'furn-dining', name: 'Dining Set', category: 'furniture', price: 5200, desc: 'Sunday jollof HQ.', unlock: { furniture: 'dining' } },
];

export const itemById = (id: string) => STORE.find((i) => i.id === id);

export function ownsTop(inv: string[], top: TopStyle) {
  if (TOPS.find((t) => t.id === top)?.free) return true;
  return STORE.some((i) => inv.includes(i.id) && i.unlock.top === top);
}
export function ownsBottom(inv: string[], bottom: BottomStyle) {
  if (BOTTOMS.find((b) => b.id === bottom)?.free) return true;
  return STORE.some((i) => inv.includes(i.id) && i.unlock.bottom === bottom);
}
export function ownsAccessory(inv: string[], acc: Accessory) {
  return STORE.some((i) => inv.includes(i.id) && i.unlock.accessory === acc);
}
export function ownsFurniture(inv: string[], f: string) {
  return STORE.some((i) => inv.includes(i.id) && i.unlock.furniture === f);
}

/** Apply a preset, skipping anything the wardrobe doesn't own yet. */
export function applyPreset(a: Appearance, vibe: Exclude<Vibe, 'Custom'>, inv: string[]): Appearance {
  const p = VIBE_PRESETS[vibe];
  const next: Appearance = { ...a, vibe };
  if (p.top && ownsTop(inv, p.top)) { next.top = p.top; if (p.topColor) next.topColor = p.topColor; }
  if (p.bottom && ownsBottom(inv, p.bottom)) { next.bottom = p.bottom; if (p.bottomColor) next.bottomColor = p.bottomColor; }
  if (p.shoesColor) next.shoesColor = p.shoesColor;
  if (p.lips !== undefined) next.lips = p.lips;
  if (p.accessories) next.accessories = p.accessories.filter((x) => ownsAccessory(inv, x));
  return next;
}

/** Make sure a saved/remote appearance is well-formed (old saves, tampered payloads). */
export function sanitizeAppearance(raw: unknown): Appearance {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const color = (v: unknown, d: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : d);
  const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
  const d = DEFAULT_APPEARANCE;
  return {
    skin: color(r.skin, d.skin),
    hair: pick(r.hair, HAIR_STYLES.map((h) => h.id), d.hair),
    hairColor: color(r.hairColor, d.hairColor),
    face: pick(r.face, FACE_SHAPES.map((f) => f.id), d.face),
    beard: pick(r.beard, BEARDS.map((b) => b.id), d.beard),
    lips: r.lips === null ? null : typeof r.lips === 'string' ? color(r.lips, '#8b2d3c') : null,
    top: pick(r.top, TOPS.map((t) => t.id), d.top),
    topColor: color(r.topColor, d.topColor),
    bottom: pick(r.bottom, BOTTOMS.map((b) => b.id), d.bottom),
    bottomColor: color(r.bottomColor, d.bottomColor),
    shoesColor: color(r.shoesColor, d.shoesColor),
    accessories: Array.isArray(r.accessories)
      ? (r.accessories.filter((x) => ACCESSORIES.some((a) => a.id === x)) as Accessory[]).slice(0, 6)
      : [],
    vibe: pick(r.vibe, ['Casual', 'Street', 'Baddie', 'Luxury', 'Corporate', 'Custom'] as const, 'Custom'),
  };
}

/** Deterministic pseudo-random appearance, used for NPCs. */
export function randomAppearance(seed: number): Appearance {
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const pickOf = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
  const fem = rnd() > 0.5;
  const tops: TopStyle[] = fem ? ['tee', 'crop', 'shirt', 'native', 'blazer'] : ['tee', 'shirt', 'hoodie', 'native', 'blazer'];
  const bottoms: BottomStyle[] = fem ? ['trousers', 'skirt', 'joggers', 'shorts'] : ['trousers', 'joggers', 'shorts'];
  const hairs: HairStyle[] = fem ? ['braids', 'bun', 'afro', 'locs', 'gele', 'lowcut'] : ['lowcut', 'fade', 'afro', 'locs', 'bald'];
  const accPool: Accessory[] = fem ? ['earrings', 'bag', 'glasses', 'watch'] : ['cap', 'glasses', 'chain', 'watch'];
  const accessories = accPool.filter(() => rnd() > 0.6);
  return {
    skin: pickOf(SKIN_TONES),
    hair: pickOf(hairs),
    hairColor: rnd() > 0.8 ? pickOf(HAIR_COLORS) : '#120d0a',
    face: pickOf(FACE_SHAPES).id,
    beard: fem ? 'none' : pickOf(BEARDS).id,
    lips: fem && rnd() > 0.5 ? pickOf(LIP_COLORS.filter(Boolean)) : null,
    top: pickOf(tops),
    topColor: pickOf(CLOTH_COLORS),
    bottom: pickOf(bottoms),
    bottomColor: pickOf(['#27323a', '#1a1a1a', '#f4f0e7', '#1f3a93', '#5d4037', '#95a5a6', '#d8b46a']),
    shoesColor: pickOf(['#1a1a1a', '#f4f0e7', '#e74c3c', '#5d4037', '#d8b46a']),
    accessories,
    vibe: 'Custom',
  };
}
