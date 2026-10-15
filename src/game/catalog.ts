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
  vendor: 'suya' | 'buka' | 'lounge' | 'hospital' | 'gym';
  kind: 'food' | 'drink' | 'service' | 'medicine';
  effects: Partial<{ hunger: number; thirst: number; energy: number; health: number; popularity: number; reputation: number; xp: number }>;
  line: string;
}

export const CONSUMABLES: Consumable[] = [
  { id: 'food-suya',     name: 'Suya (extra pepper)',        price: 500,  icon: '🍢', vendor: 'suya',   kind: 'food',    effects: { hunger: 35, popularity: 2, xp: 8 },   line: 'Suya with plenty pepper 🌶️' },
  { id: 'drink-water',   name: 'Pure water sachet',          price: 100,  icon: '💧', vendor: 'suya',   kind: 'drink',   effects: { thirst: 35 },                        line: 'Cold pure water. Bite the corner.' },
  { id: 'food-jollof',   name: 'Jollof, plantain & chicken', price: 800,  icon: '🍲', vendor: 'buka',   kind: 'food',    effects: { hunger: 60, thirst: 10, reputation: 1, xp: 10 }, line: 'Party jollof with the smoky bottom 🔥' },
  { id: 'drink-zobo',    name: 'Cold zobo',                  price: 250,  icon: '🧃', vendor: 'buka',   kind: 'drink',   effects: { thirst: 55 },                        line: 'Zobo so cold it resets your day.' },
  { id: 'drink-chapman', name: 'Chapman',                    price: 400,  icon: '🍹', vendor: 'lounge', kind: 'drink',   effects: { thirst: 50, popularity: 1 },         line: 'Chapman with the cucumber slice 🥒' },
  { id: 'svc-lounge',    name: 'Pull up (lounge entry)',     price: 1500, icon: '🪩', vendor: 'lounge', kind: 'service', effects: { popularity: 5, xp: 15, energy: -5 }, line: 'You pulled up and the DJ noticed 🪩' },
  // GistCity General Hospital (mirrors the server catalog; prices are enforced server-side when online)
  { id: 'svc-treatment', name: 'Doctor consultation & treatment', price: 2500, icon: '🩺', vendor: 'hospital', kind: 'service', effects: { health: 60, energy: 10, xp: 5 }, line: 'Dr Musa checked you over and treated you 🩺' },
  { id: 'med-paracetamol', name: 'Paracetamol (pack)',          price: 800,  icon: '💊', vendor: 'hospital', kind: 'medicine', effects: { health: 20 }, line: 'Two tablets with water. Better already 💊' },
  { id: 'med-vitamin-c', name: 'Vitamin C & multivitamin',      price: 1200, icon: '🍊', vendor: 'hospital', kind: 'medicine', effects: { health: 10, energy: 10 }, line: 'Vitamins sorted 🍊' },
  { id: 'food-moimoi',   name: 'Canteen moi-moi & pap',         price: 450,  icon: '🍮', vendor: 'hospital', kind: 'food',    effects: { hunger: 30, thirst: 15 }, line: 'Hospital canteen moi-moi, surprisingly sweet 🍮' },
  { id: 'svc-gym',       name: 'Gym session',                   price: 300,  icon: '🏋️', vendor: 'gym',      kind: 'service', effects: { health: 8, energy: -10, thirst: -10, reputation: 1, xp: 8 }, line: 'Iron Temple session done. Gains loading 💪' },
];
export const consumableById = (id: string) => CONSUMABLES.find((c) => c.id === id);
