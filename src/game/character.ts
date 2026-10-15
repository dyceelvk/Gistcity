/**
 * Character factory: realistic MakeHuman-based `Human` when the character
 * library loaded, procedural `Avatar` otherwise (offline / very old devices).
 * Both expose the same minimal surface used by the game.
 */
import type * as THREE from 'three';
import type { Appearance } from './appearance';
import { Avatar } from './avatar';
import { Human, humanLibrary, type Quality } from './human';

export interface Character {
  root: THREE.Group;
  appearance: Appearance;
  setAppearance(a: Appearance): void;
  /** speedClass: 0 idle, 1 walk, 2 run; mps: actual ground speed (m/s) for stride matching. */
  animate(dt: number, speedClass: number, mps?: number): void;
  dispose?(): void;
}

export function makeCharacter(a: Appearance, quality: Quality = 'hi'): Character {
  if (humanLibrary()) {
    try { return new Human(a, { quality }); } catch (err) { console.warn('[gist] Human failed, using procedural avatar', err); }
  }
  return new Avatar(a);
}
