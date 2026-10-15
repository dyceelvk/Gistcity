/**
 * Daily-life needs: hunger, thirst and energy on a 0–100 scale (100 = satisfied).
 * Rates are gentle on purpose — this is a social world, not a chore list — and
 * nothing here can kill a character. Low needs slow you down a little and show
 * an indicator until you eat, drink or sleep.
 */
export interface Needs { hunger: number; thirst: number; energy: number; at: number }

/** Points lost per real hour of play. */
export const DECAY_PER_HOUR = { hunger: 12, thirst: 18, energy: 8 } as const;
/** Energy regained per second while sleeping (full night ≈ 40 s). */
export const SLEEP_REGEN_PER_S = 2.5;
/** While you were away, needs keep falling — but never by more than this. */
export const OFFLINE_CAP = 40;
export const LOW = 30, CRITICAL = 12;

export const defaultNeeds = (): Needs => ({ hunger: 85, thirst: 85, energy: 90, at: Date.now() });

const clamp = (v: number) => Math.max(0, Math.min(100, v));

export function sanitizeNeeds(raw: unknown): Needs {
  const d = defaultNeeds();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = (k: keyof Needs) => (typeof r[k] === 'number' && isFinite(r[k] as number) ? (r[k] as number) : d[k]);
  return { hunger: clamp(n('hunger')), thirst: clamp(n('thirst')), energy: clamp(n('energy')), at: n('at') };
}

/** Apply the time that passed while the game was closed (capped). */
export function catchUp(n: Needs, now = Date.now()): Needs {
  const hours = Math.max(0, (now - n.at) / 3.6e6);
  if (hours <= 0) return n;
  const drop = (rate: number) => Math.min(OFFLINE_CAP, rate * hours);
  return { hunger: clamp(n.hunger - drop(DECAY_PER_HOUR.hunger)), thirst: clamp(n.thirst - drop(DECAY_PER_HOUR.thirst)), energy: clamp(n.energy - drop(DECAY_PER_HOUR.energy)), at: now };
}

/** Per-frame update. Returns true when a value crossed a whole number (so the HUD can repaint cheaply). */
export function tick(n: Needs, dt: number, sleeping: boolean): boolean {
  const before = [n.hunger | 0, n.thirst | 0, n.energy | 0];
  const h = dt / 3600;
  const slow = sleeping ? 0.5 : 1;
  n.hunger = clamp(n.hunger - DECAY_PER_HOUR.hunger * h * slow);
  n.thirst = clamp(n.thirst - DECAY_PER_HOUR.thirst * h * slow);
  n.energy = clamp(sleeping ? n.energy + SLEEP_REGEN_PER_S * dt : n.energy - DECAY_PER_HOUR.energy * h);
  n.at = Date.now();
  return before[0] !== (n.hunger | 0) || before[1] !== (n.thirst | 0) || before[2] !== (n.energy | 0);
}

export function apply(n: Needs, effects: Partial<Record<'hunger' | 'thirst' | 'energy', number>>) {
  if (effects.hunger) n.hunger = clamp(n.hunger + effects.hunger);
  if (effects.thirst) n.thirst = clamp(n.thirst + effects.thirst);
  if (effects.energy) n.energy = clamp(n.energy + effects.energy);
}

export type NeedLevel = 'ok' | 'low' | 'critical';
export const level = (v: number): NeedLevel => (v <= CRITICAL ? 'critical' : v <= LOW ? 'low' : 'ok');

/** Movement multiplier: each critical need costs 12 % speed, floor 0.7. */
export function speedFactor(n: Needs) {
  const crit = [n.hunger, n.thirst, n.energy].filter((v) => v <= CRITICAL).length;
  return Math.max(0.7, 1 - 0.12 * crit);
}

export function worst(n: Needs): { key: 'hunger' | 'thirst' | 'energy'; value: number } {
  const entries: ['hunger' | 'thirst' | 'energy', number][] = [['hunger', n.hunger], ['thirst', n.thirst], ['energy', n.energy]];
  entries.sort((a, b) => a[1] - b[1]);
  return { key: entries[0][0], value: entries[0][1] };
}
