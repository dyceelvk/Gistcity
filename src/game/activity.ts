/**
 * Character activity state machine.
 *
 * Exactly one primary activity runs at a time:
 *
 *  - Locomotion states (IDLE / WALKING / RUNNING) are derived from movement
 *    whenever nothing else holds the character.
 *  - Exclusive states (SITTING, EATING, DRINKING, SLEEPING, DRIVING, TALKING,
 *    CHANGING_CLOTHES) hold the character: no walking while sleeping, no
 *    driving without being in the car, no changing clothes while running.
 *  - Overlay states (WORKING, INTERACTING) describe what the character is
 *    doing *while* they can still move — a delivery rider works and walks.
 *
 * Timed sequences (EATING, DRINKING, CHANGING_CLOTHES, INTERACTING) end
 * themselves when their duration runs out and hand control back to whatever
 * the player was doing (e.g. eating while seated returns to SITTING).
 */

export type Activity =
  | 'IDLE' | 'WALKING' | 'RUNNING'
  | 'SITTING' | 'EATING' | 'DRINKING' | 'SLEEPING'
  | 'WORKING' | 'DRIVING' | 'TALKING' | 'CHANGING_CLOTHES' | 'INTERACTING';

/** States that fully occupy the character: no walking, no stacking. */
export const EXCLUSIVE: ReadonlySet<Activity> = new Set<Activity>([
  'SITTING', 'EATING', 'DRINKING', 'SLEEPING', 'DRIVING', 'TALKING', 'CHANGING_CLOTHES',
]);

/** States that describe an activity without stopping movement. */
export const OVERLAY: ReadonlySet<Activity> = new Set<Activity>(['WORKING', 'INTERACTING']);

/** States that end themselves after their duration. */
export const SEQUENCES: ReadonlySet<Activity> = new Set<Activity>(['EATING', 'DRINKING', 'CHANGING_CLOTHES', 'INTERACTING']);

/** What the HUD chip / presence broadcast shows for each state ('' = nothing worth showing). */
export const ACTIVITY_LABEL: Record<Activity, string> = {
  IDLE: '', WALKING: '', RUNNING: '',
  SITTING: 'Sitting', EATING: 'Eating', DRINKING: 'Drinking', SLEEPING: 'Sleeping',
  WORKING: 'Working', DRIVING: 'Driving', TALKING: 'Talking', CHANGING_CLOTHES: 'Changing',
  INTERACTING: '',
};

export class ActivityMachine {
  current: Activity = 'IDLE';
  /** Where control returns when a nested sequence ends (e.g. eating while seated). */
  private resume: Activity | null = null;
  private endsAt = 0;
  private onEnd: ((a: Activity) => void) | null = null;

  /** True while an exclusive state holds the character. */
  get exclusive(): boolean { return EXCLUSIVE.has(this.current); }
  /** True while movement must stop (exclusive states except TALKING — you can walk away from a chat). */
  get freezeMovement(): boolean { return this.exclusive && this.current !== 'TALKING'; }
  /** True while a timed sequence is running. */
  get sequence(): boolean { return SEQUENCES.has(this.current); }

  canEnter(a: Activity): boolean {
    if (a === this.current && !SEQUENCES.has(a)) return true;
    // Overlays stack onto locomotion only.
    if (OVERLAY.has(a)) return !this.exclusive;
    // Locomotion is allowed unless an exclusive state holds us.
    if (a === 'IDLE' || a === 'WALKING' || a === 'RUNNING') return !this.exclusive;
    // EATING / DRINKING are allowed while seated (you keep your seat afterwards).
    if ((a === 'EATING' || a === 'DRINKING') && this.current === 'SITTING') return true;
    // Exclusive states never stack.
    return !this.exclusive;
  }

  /**
   * Enter a state. `durationS > 0` turns it into a self-ending sequence.
   * Returns false when the transition is not allowed (the caller should say why).
   */
  enter(a: Activity, durationS = 0, onEnd?: (a: Activity) => void): boolean {
    if (!this.canEnter(a)) return false;
    if ((a === 'EATING' || a === 'DRINKING') && this.current === 'SITTING') this.resume = 'SITTING';
    else this.resume = null;
    this.current = a;
    this.onEnd = onEnd ?? null;
    this.endsAt = durationS > 0 ? performance.now() + durationS * 1000 : 0;
    return true;
  }

  /**
   * Leave a state (or the current one). Control returns to the seat we were
   * sitting on when a nested sequence ends, otherwise to IDLE.
   */
  end(a?: Activity): Activity {
    const was = this.current;
    if (a && a !== was) return was;
    const back = this.resume;
    this.resume = null;
    this.endsAt = 0;
    this.current = back === 'SITTING' && was !== 'SITTING' ? 'SITTING' : 'IDLE';
    const cb = this.onEnd; this.onEnd = null;
    cb?.(was);
    return was;
  }

  /** Hard reset back to IDLE (standing up, leaving a car, waking). */
  endAll(): Activity {
    const was = this.end();
    this.resume = null;
    this.current = 'IDLE';
    return was;
  }

  /** Locomotion drive from the movement code — only applies to the locomotion states. */
  locomotion(speed: number, running: boolean) {
    if (this.exclusive || OVERLAY.has(this.current) || this.sequence) return;
    this.current = speed < 0.12 ? 'IDLE' : running ? 'RUNNING' : 'WALKING';
  }

  /** Tick the timed sequences; ends them when their duration is over. */
  update(): Activity {
    if (this.endsAt && performance.now() >= this.endsAt) this.end();
    return this.current;
  }

  /** Human label for HUD/presence ('' when the state needs no label). `detail` adds context. */
  label(detail = ''): string {
    const base = ACTIVITY_LABEL[this.current];
    if (!base) return '';
    return detail ? `${base.toLowerCase()} ${detail}` : base.toLowerCase();
  }
}
