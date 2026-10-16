/**
 * QuickCash POS — the real Nigerian POS shift.
 *
 * The flow, exactly as it happens on the street:
 *   1. you APPLY at the stand (you do not own the POS) and wait for approval;
 *   2. approved → you stand behind the counter — the shop camera watches the
 *      transaction like a CCTV;
 *   3. customers walk up one by one and TELL YOU THE AMOUNT they want;
 *   4. you ask "withdraw or transfer?" — they answer;
 *   5. you count cash / approve on the terminal and keep the service fee.
 */
import * as THREE from 'three';
import { makeCharacter, type Character } from './character';
import { defaultState } from './state';
import { SKIN_TONES, CLOTH_COLORS, type Appearance } from './appearance';

export interface PosHooks {
  /** Dialogue card. Resolves with the chosen option index, or -1 when closed. */
  ask(name: string, role: string, line: string, choices: string[]): Promise<number>;
  /** One-sided dialogue line (the customer speaks). */
  say(name: string, role: string, line: string): void;
  toast(msg: string): void;
  /** Status chip under the objective: "POS SHIFT · 2/5 · 340 G". */
  chip(text: string | null): void;
  /** Service fee credited to the wallet immediately. */
  earn(amount: number): void;
  /** End of shift report. */
  onEnd(served: number, earned: number): void;
}

const CUSTOMER_NAMES = ['Chidi', 'Amaka', 'Segun', 'Bisi', 'Emeka', 'Ngozi', 'Tunde', 'Funke', 'Musa', 'Hauwa', 'Kelechi', 'Zainab', 'Damilola', 'Uche', 'Aisha', 'Obi'];
const METHODS = ['withdraw', 'transfer'] as const;
const fmt = (n: number) => n.toLocaleString('en-NG');

interface Job {
  char: Character;
  name: string;
  amount: number;
  method: (typeof METHODS)[number];
  state: 'approach' | 'counter' | 'served' | 'leave';
  t: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
}

export class PosShift {
  active = false;
  served = 0;
  earned = 0;
  total = 5;
  private jobs: Job[] = [];
  private busy = false;
  private layer = new THREE.Group();

  constructor(private scene: THREE.Scene, private hooks: PosHooks) {
    this.scene.add(this.layer);
  }

  /** Begin a shift: the player is behind the counter, customers come from the street. */
  begin(counter: THREE.Vector3, street: THREE.Vector3) {
    this.end(true);
    this.active = true;
    this.served = 0; this.earned = 0;
    this.hooks.chip(`POS SHIFT · 0/${this.total} · 0 G`);
    this.hooks.toast('Shift started — a customer is walking up to the counter.');
    this.spawn(counter, street);
    void this.queueNext(counter, street);
  }

  private spawn(counter: THREE.Vector3, street: THREE.Vector3) {
    const a: Appearance = {
      ...defaultState().appearance,
      skin: SKIN_TONES[Math.floor(Math.random() * SKIN_TONES.length)] ?? '#8d5524',
      topColor: CLOTH_COLORS[Math.floor(Math.random() * CLOTH_COLORS.length)] ?? '#2e86de',
      bottomColor: CLOTH_COLORS[Math.floor(Math.random() * CLOTH_COLORS.length)] ?? '#222',
    };
    const char = makeCharacter(a, 'lo');
    const from = street.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, 0, (Math.random() - 0.5) * 2));
    char.root.position.copy(from);
    this.layer.add(char.root);
    const name = CUSTOMER_NAMES[Math.floor(Math.random() * CUSTOMER_NAMES.length)] ?? 'Customer';
    const amount = (5 + Math.floor(Math.random() * 16)) * 500; // 2,500 – 10,000 G
    const method = METHODS[Math.floor(Math.random() * 2)] ?? 'withdraw';
    this.jobs.push({ char, name, amount, method, state: 'approach', t: 0, from, to: counter.clone() });
  }

  private async queueNext(counter: THREE.Vector3, street: THREE.Vector3) {
    // one customer at a time — the next walks up when the counter frees up
    while (this.active) {
      await new Promise((r) => setTimeout(r, 1200));
      if (!this.active) return;
      const last = this.jobs[this.jobs.length - 1];
      if (last && (last.state === 'approach' || last.state === 'counter')) continue;
      if (this.served + this.jobs.filter((j) => j.state === 'served' || j.state === 'leave').length >= this.total) return;
      if (this.jobs.filter((j) => j.state !== 'leave').length < 2) this.spawn(counter, street);
    }
  }

  /** Called every frame: walks customers and runs the counter talk. */
  update(dt: number) {
    if (!this.active) return;
    for (const j of this.jobs) {
      if (j.state === 'approach') {
        const d = j.to.clone().sub(j.char.root.position); d.y = 0;
        const dist = d.length();
        if (dist < 0.25) {
          j.state = 'counter'; j.t = 0;
          j.char.animate(dt, 0);
          j.char.root.rotation.y = Math.atan2(-d.x, -d.z) + Math.PI;
          void this.serve(j);
        } else {
          const step = Math.min(dist, 1.35 * dt);
          j.char.root.position.addScaledVector(d.normalize(), step);
          j.char.root.rotation.y = Math.atan2(d.x, d.z);
          j.char.animate(dt, 1, 1.35);
        }
      } else if (j.state === 'leave') {
        j.t += dt;
        const d = j.from.clone().sub(j.char.root.position); d.y = 0;
        const dist = d.length();
        if (dist > 0.3) {
          const step = Math.min(dist, 1.5 * dt);
          j.char.root.position.addScaledVector(d.normalize(), step);
          j.char.root.rotation.y = Math.atan2(d.x, d.z);
          j.char.animate(dt, 1, 1.5);
        } else {
          j.char.animate(dt, 0);
          if (j.t > 2.2) { this.layer.remove(j.char.root); j.state = 'served'; }
        }
      } else {
        j.char.animate(dt, 0);
      }
    }
    this.jobs = this.jobs.filter((j) => j.state !== 'served');
    if (this.served >= this.total && !this.busy && this.jobs.every((j) => j.state === 'leave' || j.state === 'served')) {
      const s = this.served, e = this.earned;
      this.end(true);
      this.hooks.onEnd(s, e);
    }
  }

  /** The counter conversation — Nigerian POS, step by step. */
  private async serve(j: Job) {
    if (this.busy) return;
    this.busy = true;
    const fee = Math.max(20, Math.round(j.amount * 0.03));
    const wants = j.method === 'withdraw' ? 'withdraw' : 'transfer';
    this.hooks.say(j.name, 'QUICKCASH CUSTOMER', `Good afternoon! I want to ${wants} ${fmt(j.amount)} G.`);
    const a1 = await this.hooks.ask(j.name, 'QUICKCASH CUSTOMER', `I want to ${wants} ${fmt(j.amount)} G — can you sort me?`, [
      'Ask: "Withdraw or transfer?"',
      'Decline — next customer',
    ]);
    if (a1 !== 0 || !this.active) { this.sendOff(j, 'No wahala — I will come back.'); this.busy = false; return; }
    this.hooks.say(j.name, 'QUICKCASH CUSTOMER', j.method === 'withdraw' ? 'Na withdraw — cash please.' : 'Na transfer — sharp sharp.');
    const a2 = await this.hooks.ask(j.name, 'QUICKCASH CUSTOMER', j.method === 'withdraw'
      ? `Cash out ${fmt(j.amount)} G? The fee is ${fmt(fee)} G.`
      : `Send ${fmt(j.amount)} G by transfer? The fee is ${fmt(fee)} G.`, [
      `Count cash & approve · fee ${fmt(fee)} G`,
      'Decline',
    ]);
    if (a2 !== 0 || !this.active) { this.sendOff(j, 'Haba now! No problem.'); this.busy = false; return; }
    // terminal processing beat — the shop camera keeps watching
    this.hooks.say(j.name, 'TERMINAL', 'Processing on the QuickCash terminal…');
    await new Promise((r) => setTimeout(r, 1100));
    this.hooks.earn(fee);
    this.served++;
    this.earned += fee;
    this.hooks.chip(`POS SHIFT · ${this.served}/${this.total} · ${fmt(this.earned)} G`);
    this.sendOff(j, `Transaction complete — ${fmt(j.amount)} G ${j.method}. Thank you!`);
    this.hooks.toast(`✅ ${fmt(j.amount)} G ${j.method} approved · +${fmt(fee)} G fee`);
    this.busy = false;
  }

  private sendOff(j: Job, line: string) {
    this.hooks.say(j.name, 'QUICKCASH CUSTOMER', line);
    j.state = 'leave'; j.t = 0;
  }

  end(silent = false) {
    for (const j of this.jobs) this.layer.remove(j.char.root);
    this.jobs = [];
    this.busy = false;
    if (this.active && !silent) this.hooks.onEnd(this.served, this.earned);
    this.active = false;
    this.hooks.chip(null);
  }
}
