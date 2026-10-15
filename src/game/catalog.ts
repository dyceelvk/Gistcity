/**
 * Consumables and services sold around the city. Prices here are for display
 * only — the database `catalog_items` table is authoritative when online
 * (public/characters is unrelated; see supabase/migrations/*foundation.sql).
 */
export interface Consumable {
  id: string;
  name: string;
  price: number;
  icon: string;
  /** Vendor zone id in the world (suya / buka / lounge). */
  vendor: 'suya' | 'buka' | 'lounge';
  kind: 'food' | 'drink' | 'service';
  effects: Partial<{ hunger: number; thirst: number; energy: number; popularity: number; reputation: number; xp: number }>;
  line: string;
}

export const CONSUMABLES: Consumable[] = [
  { id: 'food-suya',     name: 'Suya (extra pepper)',        price: 500,  icon: '🍢', vendor: 'suya',   kind: 'food',    effects: { hunger: 35, popularity: 2, xp: 8 },   line: 'Suya with plenty pepper 🌶️' },
  { id: 'drink-water',   name: 'Pure water sachet',          price: 100,  icon: '💧', vendor: 'suya',   kind: 'drink',   effects: { thirst: 35 },                        line: 'Cold pure water. Bite the corner.' },
  { id: 'food-jollof',   name: 'Jollof, plantain & chicken', price: 800,  icon: '🍲', vendor: 'buka',   kind: 'food',    effects: { hunger: 60, thirst: 10, reputation: 1, xp: 10 }, line: 'Party jollof with the smoky bottom 🔥' },
  { id: 'drink-zobo',    name: 'Cold zobo',                  price: 250,  icon: '🧃', vendor: 'buka',   kind: 'drink',   effects: { thirst: 55 },                        line: 'Zobo so cold it resets your day.' },
  { id: 'drink-chapman', name: 'Chapman',                    price: 400,  icon: '🍹', vendor: 'lounge', kind: 'drink',   effects: { thirst: 50, popularity: 1 },         line: 'Chapman with the cucumber slice 🥒' },
  { id: 'svc-lounge',    name: 'Pull up (lounge entry)',     price: 1500, icon: '🪩', vendor: 'lounge', kind: 'service', effects: { popularity: 5, xp: 15, energy: -5 }, line: 'You pulled up and the DJ noticed 🪩' },
];
export const consumableById = (id: string) => CONSUMABLES.find((c) => c.id === id);
