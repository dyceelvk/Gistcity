/**
 * Unified input: keyboard + mouse on desktop, virtual joystick + touch-look on
 * mobile. Produces a movement axis relative to the screen, a run flag and
 * camera look deltas; the game maps the axis onto the camera's heading.
 */
export class Input {
  private keys = new Set<string>();
  /** Screen-space movement axis from the joystick (-1..1). */
  joy = { x: 0, y: 0, active: false };
  lookDX = 0; lookDY = 0; zoomDelta = 0;
  runToggle = false;
  onInteract: (() => void) | null = null;
  onEscape: (() => void) | null = null;
  onToggleRun: (() => void) | null = null;
  /** True once the user has touched the screen (we're on a touch device). */
  touch = false;
  private lookPointer: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private joyPointer: number | null = null;
  private joyOrigin = { x: 0, y: 0 };

  constructor(private canvasHost: HTMLElement, private joyEl: HTMLElement, private joyKnob: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const k = e.key.toLowerCase();
      if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
      this.keys.add(k);
      if ((k === 'e' || k === ' ') && !e.repeat) this.onInteract?.();
      if (k === 'escape') this.onEscape?.();
      if (k === 'capslock' && !e.repeat) { this.runToggle = !this.runToggle; this.onToggleRun?.(); }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => { this.keys.clear(); });

    // camera look: drag anywhere on the 3D view that isn't the joystick zone
    canvasHost.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') this.touch = true;
      if (e.pointerType === 'touch' && e.clientX < window.innerWidth * 0.42 && e.clientY > window.innerHeight * 0.4) {
        this.startJoy(e); return;
      }
      if (this.lookPointer !== null) return;
      this.lookPointer = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
      try { canvasHost.setPointerCapture?.(e.pointerId); } catch { /* synthetic event */ }
    });
    canvasHost.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.lookPointer) {
        this.lookDX += e.clientX - this.lookLast.x;
        this.lookDY += e.clientY - this.lookLast.y;
        this.lookLast = { x: e.clientX, y: e.clientY };
      } else if (e.pointerId === this.joyPointer) this.moveJoy(e);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === this.lookPointer) this.lookPointer = null;
      if (e.pointerId === this.joyPointer) this.endJoy();
    };
    canvasHost.addEventListener('pointerup', end);
    canvasHost.addEventListener('pointercancel', end);
    canvasHost.addEventListener('wheel', (e) => { this.zoomDelta += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    canvasHost.addEventListener('contextmenu', (e) => e.preventDefault());

    // the joystick element itself (visible on touch devices)
    joyEl.addEventListener('pointerdown', (e) => { this.touch = true; this.startJoy(e); });
    joyEl.addEventListener('pointermove', (e) => { if (e.pointerId === this.joyPointer) this.moveJoy(e); });
    joyEl.addEventListener('pointerup', (e) => { if (e.pointerId === this.joyPointer) this.endJoy(); });
    joyEl.addEventListener('pointercancel', (e) => { if (e.pointerId === this.joyPointer) this.endJoy(); });
  }

  private startJoy(e: PointerEvent) {
    if (this.joyPointer !== null) return;
    this.joyPointer = e.pointerId;
    const rect = this.joyEl.getBoundingClientRect();
    // anchor the joystick where the finger landed, inside the zone
    this.joyOrigin = { x: e.clientX, y: e.clientY };
    this.joyEl.style.left = `${Math.min(Math.max(e.clientX - rect.width / 2, 8), window.innerWidth - rect.width - 8)}px`;
    this.joyEl.style.top = `${Math.min(Math.max(e.clientY - rect.height / 2, 8), window.innerHeight - rect.height - 8)}px`;
    this.joyEl.classList.add('active');
    this.joy.active = true;
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* synthetic event */ }
    e.preventDefault();
  }
  private moveJoy(e: PointerEvent) {
    const dx = e.clientX - this.joyOrigin.x, dy = e.clientY - this.joyOrigin.y;
    const max = 46;
    const len = Math.hypot(dx, dy);
    const k = len > max ? max / len : 1;
    const x = dx * k, y = dy * k;
    this.joyKnob.style.transform = `translate(${x}px, ${y}px)`;
    this.joy.x = x / max; this.joy.y = y / max;
  }
  private endJoy() {
    this.joyPointer = null;
    this.joy.x = 0; this.joy.y = 0; this.joy.active = false;
    this.joyKnob.style.transform = 'translate(0,0)';
    this.joyEl.classList.remove('active');
    this.joyEl.style.left = ''; this.joyEl.style.top = '';
  }

  /** Movement axis: x = right, y = forward (screen/camera relative), each -1..1. */
  axis() {
    let x = 0, y = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) y += 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) y -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) x += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) x -= 1;
    if (this.joy.active) { x += this.joy.x; y -= this.joy.y; }
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    return { x, y, mag: Math.min(1, len) };
  }
  get running() { return this.keys.has('shift') || this.runToggle; }
  /** Read and clear accumulated look deltas. */
  consumeLook() { const r = { dx: this.lookDX, dy: this.lookDY, zoom: this.zoomDelta }; this.lookDX = 0; this.lookDY = 0; this.zoomDelta = 0; return r; }
}
