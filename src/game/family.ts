/**
 * The GistCity age model — the same math as `public.age_years()` /
 * `public.born_at_for_age()` in supabase/migrations/20261018000005_gistcity_family.sql.
 *
 * The city clock runs 1 game-day in 24 real minutes; 1 game-month is 7 game-days
 * (2.8 real hours). Age advances through the accelerated calendar:
 *
 *   month  0 → 1   : 0 → 10 years     (childhood)
 *   month  1 → 12  : 10 → 25 years    (growing up)
 *   month 12 →     : +1 year per month (adult life)
 *
 * New players start at 18. Newborns start at 0 and grow through the same curve.
 */

export const GAME_DAY_MINUTES = 24;
export const DAYS_PER_MONTH = 7;
/** Real milliseconds in one game-month. */
export const MONTH_MS = GAME_DAY_MINUTES * 60 * DAYS_PER_MONTH * 1000;

/** Game-months elapsed since a birth timestamp. */
export function monthsSince(bornAt: number | string, now = Date.now()): number {
  const born = typeof bornAt === 'string' ? Date.parse(bornAt) : bornAt;
  return Math.max(0, (now - born) / MONTH_MS);
}

/** Years old, exactly like the server. */
export function ageYears(bornAt: number | string, now = Date.now()): number {
  const m = monthsSince(bornAt, now);
  const age = m <= 1 ? 10 * m : m <= 12 ? 10 + (15 * (m - 1)) / 11 : 25 + (m - 12);
  return Math.round(age * 100) / 100;
}

/** Birth timestamp for a given age (inverse of ageYears). */
export function bornAtForAge(age: number, now = Date.now()): number {
  const months = age <= 10 ? (age / 10) * 1 : age <= 25 ? 1 + (11 * (age - 10)) / 15 : 12 + (age - 25);
  return now - months * MONTH_MS;
}

/** "8 y/o", "25 y/o"… */
export function ageLabel(bornAt: number | string, now = Date.now()): string {
  return `${Math.floor(ageYears(bornAt, now))} y/o`;
}

/** Adult (18+) — marriage, government jobs, driving, property purchases. */
export const isAdult = (bornAt: number | string, now = Date.now()) => ageYears(bornAt, now) >= 18;
