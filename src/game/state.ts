/**
 * Player state: the single source of truth for everything that persists.
 * Saved to localStorage immediately and mirrored to Supabase when signed in.
 */
import { Appearance, DEFAULT_APPEARANCE, sanitizeAppearance } from './appearance';
import { defaultNeeds, sanitizeNeeds, type Needs } from './needs';

export interface Stats {
  popularity: number;
  reputation: number;
  hustle: number;
  xp: number;
}

export interface PlayerState {
  name: string;
  /** Unique account handle (set by the server at registration; empty in offline practice). */
  username: string;
  appearance: Appearance;
  /** G balance. Online this mirrors the server wallet; offline it is the practice balance. */
  cash: number;
  needs: Needs;
  inventory: string[];
  /** Furniture ids currently placed in the apartment. */
  apartment: string[];
  stats: Stats;
  achievements: string[];
  jobsDone: number;
  visited: string[];
  createdAt: number;
}

export const ACHIEVEMENTS: Record<string, { title: string; desc: string }> = {
  'first-steps': { title: 'Welcome to Gist City', desc: 'Took your first walk in the city.' },
  'first-hustle': { title: 'Hustler', desc: 'Completed your first hustle.' },
  'five-hustles': { title: 'Street Smart', desc: 'Completed five hustles.' },
  'first-fit': { title: 'Fresh Fit', desc: 'Bought your first outfit piece.' },
  'homeowner': { title: 'Soft Life Loading', desc: 'Furnished your apartment.' },
  'socialite': { title: 'Socialite', desc: 'Gisted with ten people.' },
  'explorer': { title: 'Area Boss', desc: 'Visited every hangout spot.' },
  'big-boy': { title: 'Odogwu', desc: 'Held 50,000 G at once.' },
  'well-fed': { title: 'Belle Full', desc: 'Ate and drank in the city.' },
  'rested': { title: 'Soft Life', desc: 'Slept a full night in your own flat.' },
};

const KEY = 'gist_save_v1';
/** Starter grant for a new citizen (the server's economy_config.starter_grant mirrors this). */
export const START_G = 10000;
/** Currency formatting: GistCity's currency is G. */
export const fmtG = (n: number) => Math.round(n).toLocaleString('en-NG') + ' G';

export function defaultState(): PlayerState {
  return {
    name: 'New GistCitizen',
    username: '',
    appearance: { ...DEFAULT_APPEARANCE },
    cash: START_G,
    needs: defaultNeeds(),
    inventory: [],
    apartment: [],
    stats: { popularity: 0, reputation: 0, hustle: 0, xp: 0 },
    achievements: [],
    jobsDone: 0,
    visited: [],
    createdAt: Date.now(),
  };
}

export function sanitizeState(raw: unknown): PlayerState {
  const d = defaultState();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const num = (v: unknown, def: number, max = 1e9) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : def);
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 200) : []);
  const s = r.stats && typeof r.stats === 'object' ? r.stats : {};
  return {
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 24) : d.name,
    username: typeof r.username === 'string' ? r.username.slice(0, 20) : '',
    appearance: sanitizeAppearance(r.appearance),
    cash: num(r.cash, d.cash, Number.MAX_SAFE_INTEGER),
    needs: sanitizeNeeds(r.needs),
    inventory: strs(r.inventory),
    apartment: strs(r.apartment),
    stats: {
      popularity: num(s.popularity, 0),
      reputation: num(s.reputation, 0),
      hustle: num(s.hustle, 0),
      xp: num(s.xp, 0),
    },
    achievements: strs(r.achievements),
    jobsDone: num(r.jobsDone, 0),
    visited: strs(r.visited),
    createdAt: num(r.createdAt, d.createdAt, Number.MAX_SAFE_INTEGER),
  };
}

export function loadLocal(): PlayerState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitizeState(JSON.parse(raw));
  } catch { /* corrupt save – start fresh */ }
  return defaultState();
}

export function saveLocal(s: PlayerState) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage full / private mode */ }
}

export const levelFor = (xp: number) => Math.floor(Math.sqrt(xp / 50)) + 1;
export const xpForLevel = (lvl: number) => (lvl - 1) * (lvl - 1) * 50;

/** A tiny event bus so the HUD re-renders when state changes. */
type Listener = (s: PlayerState) => void;
export class Store {
  state: PlayerState;
  private listeners = new Set<Listener>();
  dirty = false;
  constructor(initial: PlayerState) { this.state = initial; }
  subscribe(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  update(mut: (s: PlayerState) => void) {
    mut(this.state);
    this.dirty = true;
    saveLocal(this.state);
    for (const l of this.listeners) l(this.state);
  }
  replace(next: PlayerState) {
    this.state = next;
    saveLocal(next);
    for (const l of this.listeners) l(this.state);
  }
}
