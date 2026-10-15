/**
 * Day / night. One GistCity day lasts DAY_MINUTES real minutes and is derived
 * from the wall clock, so every citizen in the city sees the same time of day
 * without any server traffic. Drives the sun, sky, fog, street lights and
 * window glow.
 */
import * as THREE from 'three';
import { mat } from './avatar';
import { LAMP_MAT } from './props';

export const DAY_MINUTES = 24;

export interface DayState { hour: number; label: string; night: boolean; daylight: number }

const lerpC = (a: string, b: string, t: number) => new THREE.Color(a).lerp(new THREE.Color(b), t);
/** 0 at midnight → 1 at noon, smooth. */
const daylightOf = (h: number) => THREE.MathUtils.smoothstep(h, 5.5, 8) * (1 - THREE.MathUtils.smoothstep(h, 17.5, 20));

export function hourNow(now = Date.now()) {
  const o = (globalThis as any).__gistHour; // debug override (screenshots / tests)
  if (typeof o === 'number') return o;
  return ((now / 60000) % DAY_MINUTES) / DAY_MINUTES * 24;
}

export function describe(hour: number): DayState {
  const d = daylightOf(hour);
  const label = hour < 5 ? 'night' : hour < 7 ? 'dawn' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 19.5 ? 'evening' : 'night';
  return { hour, label, night: d < 0.25, daylight: d };
}

export const fmtHour = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;

export class DayCycle {
  state: DayState = describe(hourNow());
  private windowM = (() => { const w = mat('#2f4a55', 0.25, 0.4); w.userData.live = true; return w; })();
  private lastApplied = -1;
  constructor(private sun: THREE.DirectionalLight, private hemi: THREE.HemisphereLight, private skyUniforms: { top: { value: THREE.Color }; mid: { value: THREE.Color }; bottom: { value: THREE.Color } } | null, private scene: THREE.Scene) {}

  /** Re-evaluates the time of day; cheap, call every frame. Returns true when the display hour changed. */
  update(indoor: boolean): boolean {
    const h = hourNow();
    const changed = Math.floor(h * 60) !== Math.floor(this.state.hour * 60);
    this.state = describe(h);
    if (indoor) return changed;
    // apply at most ~20×/s
    const q = Math.floor(h * 1800);
    if (q === this.lastApplied) return changed;
    this.lastApplied = q;
    const d = this.state.daylight;
    const dusk = Math.max(0, 1 - Math.abs(h - 18.3) / 1.6) + Math.max(0, 1 - Math.abs(h - 6.6) / 1.4); // golden hours
    // sun: arc across the sky, warm at the horizon
    const ang = ((h - 6) / 12) * Math.PI; // 6h → 0, 18h → π
    this.sun.intensity = 0.05 + 2.6 * d;
    this.sun.color.copy(lerpC('#ffe2b8', '#ff9a4a', Math.min(1, dusk)));
    this.hemi.intensity = 0.22 + 0.95 * d;
    this.hemi.color.copy(lerpC('#1a2440', '#dff1ff', d));
    this.hemi.groundColor.copy(lerpC('#141a16', '#5c6b4e', d));
    (this as any).sunAng = ang;
    if (this.skyUniforms) {
      const nightTop = '#070b1a', nightMid = '#101a33', nightBot = '#2a2436';
      const duskTop = '#3b4a8a', duskMid = '#f08a5d', duskBot = '#ffd29d';
      const dayTop = '#3f86d6', dayMid = '#9fd0ee', dayBot = '#f3dfc0';
      const t = d, k = Math.min(1, dusk) * (1 - d) * 1.4;
      this.skyUniforms.top.value.copy(lerpC(nightTop, dayTop, t).lerp(new THREE.Color(duskTop), Math.min(1, k)));
      this.skyUniforms.mid.value.copy(lerpC(nightMid, dayMid, t).lerp(new THREE.Color(duskMid), Math.min(1, k)));
      this.skyUniforms.bottom.value.copy(lerpC(nightBot, dayBot, t).lerp(new THREE.Color(duskBot), Math.min(1, k)));
    }
    if (this.scene.fog) (this.scene.fog as THREE.Fog).color.copy(lerpC('#0f1422', '#e9dcc3', d).lerp(new THREE.Color('#f4b183'), Math.min(1, dusk) * (1 - d) * 0.8));
    // lights on in the evening
    const lamps = 1 - THREE.MathUtils.smoothstep(d, 0.2, 0.6);
    LAMP_MAT.emissiveIntensity = 0.15 + 2.6 * lamps;
    this.windowM.emissive.set('#ffd79a');
    this.windowM.emissiveIntensity = 0.9 * lamps;
    return changed;
  }
  /** Sun direction for the shadow light (unit vector pointing from the player towards the sun). */
  sunOffset(): THREE.Vector3 {
    const ang = (this as any).sunAng ?? Math.PI / 2;
    const el = Math.max(0.18, Math.sin(ang));
    return new THREE.Vector3(-Math.cos(ang) * 0.8, el, 0.45).normalize().multiplyScalar(62);
  }
}
