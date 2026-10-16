/**
 * The one place the game spends or earns G.
 *
 * Online: every operation is a database function call with an idempotency key
 * (see supabase/migrations/*foundation.sql) and the wallet balance returned by
 * the server replaces the local number. Offline practice mode (no Supabase
 * config): the same rules are applied to the local save on this device only.
 */
import { itemById } from '../game/appearance';
import { consumableById } from '../game/catalog';
import type { Store } from '../game/state';
import { cloud, errorText, type MoneyResult } from './supabase';

export interface SpendResult { ok: boolean; error?: string; message?: string; effects?: Record<string, number>; paid?: number }

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }));

/** Server pay table mirror (display only; the database decides what is paid). */
export const HUSTLE_PAY: Record<string, number> = { dispatch: 1500, market: 2000, pos: 2000, pitch: 1000 };

export class Economy {
  /** In-flight keys per operation so a double tap re-sends the same request instead of a new one. */
  private pending = new Map<string, string>();
  constructor(private store: Store) {}

  get online() { return cloud.signedIn; }

  private key(op: string) {
    let k = this.pending.get(op);
    if (!k) { k = uuid(); this.pending.set(op, k); }
    return k;
  }
  private settle(op: string, r: MoneyResult) {
    this.pending.delete(op);
    if (typeof r.balance === 'number') this.store.update((s) => { s.cash = r.balance!; });
  }

  /** Buy a wardrobe/furniture item or a consumable. */
  async buy(itemId: string): Promise<SpendResult> {
    const durable = itemById(itemId), consumable = consumableById(itemId);
    const price = durable?.price ?? consumable?.price;
    if (price === undefined) return { ok: false, error: 'GC_UNKNOWN_ITEM', message: errorText('GC_UNKNOWN_ITEM') };
    const effects = consumable?.effects as Record<string, number> | undefined;
    if (!this.online) {
      const s = this.store.state;
      if (durable && s.inventory.includes(itemId)) return { ok: false, error: 'GC_ALREADY_OWNED', message: errorText('GC_ALREADY_OWNED') };
      if (s.cash < price) return { ok: false, error: 'GC_INSUFFICIENT_FUNDS', message: errorText('GC_INSUFFICIENT_FUNDS') };
      this.store.update((st) => { st.cash -= price; if (durable) st.inventory.push(itemId); });
      return { ok: true, effects };
    }
    const op = 'buy:' + itemId;
    if (this.pending.has(op) && this.inflight.has(op)) return { ok: false, error: 'busy', message: 'Still processing…' };
    this.inflight.add(op);
    try {
      const r = await cloud.purchase(itemId, this.key(op));
      this.settle(op, r);
      if (r.ok && durable) this.store.update((st) => { if (!st.inventory.includes(itemId)) st.inventory.push(itemId); });
      return { ok: r.ok, error: r.error, message: r.ok ? undefined : errorText(r.error), effects: r.effects ?? effects };
    } catch (e: any) {
      const code = String(e?.code ?? e?.message ?? 'network');
      return { ok: false, error: code, message: errorText(ERRORS_FROM_RAISE(code)) };
    } finally { this.inflight.delete(op); }
  }
  private inflight = new Set<string>();

  /** Pay out a finished Hustle Hub gig. */
  async hustle(id: string): Promise<SpendResult> {
    if (!this.online) {
      const pay = HUSTLE_PAY[id] ?? 0;
      this.store.update((st) => { st.cash += pay; });
      return { ok: true, paid: pay };
    }
    const op = 'hustle:' + id + ':' + Date.now();
    try {
      const r = await cloud.completeHustle(id, this.key(op));
      this.settle(op, r);
      return { ok: r.ok, error: r.error, paid: r.paid, message: r.ok ? undefined : r.error === 'GC_COOLDOWN' ? `Rest small — try that hustle again in ${r.retry_in ?? 60}s.` : errorText(r.error) };
    } catch (e: any) { return { ok: false, error: 'network', message: errorText('network') }; }
  }

  /**
   * Credit an earned amount (POS service fee). Offline: straight into the wallet.
   * Online: variable per-customer payouts need an RPC (docs/AUDIT.md §11) — the
   * shift settles through the server pay table instead, so fees return 0 here.
   */
  async earnG(amount: number, _reason: string): Promise<SpendResult> {
    if (!this.online) {
      this.store.update((st) => { st.cash += amount; });
      return { ok: true, paid: amount };
    }
    return { ok: true, paid: 0 };
  }

  /** Voluntary gift to another citizen. */
  async gift(toUsername: string, amount: number, note: string): Promise<SpendResult> {
    amount = Math.floor(amount);
    if (!(amount > 0)) return { ok: false, error: 'GC_INVALID_AMOUNT', message: 'Enter an amount above 0.' };
    if (!this.online) return { ok: false, error: 'offline', message: 'Gifts need an online account.' };
    const op = 'gift:' + toUsername + ':' + amount + ':' + note;
    try {
      const r = await cloud.transfer(toUsername, amount, note, this.key(op));
      this.settle(op, r);
      return { ok: r.ok, error: r.error, message: r.ok ? undefined : errorText(r.error) };
    } catch { return { ok: false, error: 'network', message: errorText('network') }; }
  }

  /** Voluntary donation to a community/church/business account. */
  async donate(code: string, amount: number): Promise<SpendResult> {
    amount = Math.floor(amount);
    if (!(amount > 0)) return { ok: false, error: 'GC_INVALID_AMOUNT', message: 'Enter an amount above 0.' };
    if (!this.online) {
      if (this.store.state.cash < amount) return { ok: false, error: 'GC_INSUFFICIENT_FUNDS', message: errorText('GC_INSUFFICIENT_FUNDS') };
      this.store.update((st) => { st.cash -= amount; });
      return { ok: true };
    }
    const op = 'donate:' + code + ':' + amount + ':' + Date.now();
    try {
      const r = await cloud.donate(code, amount, this.key(op));
      this.settle(op, r);
      return { ok: r.ok, error: r.error, message: r.ok ? undefined : errorText(r.error) };
    } catch { return { ok: false, error: 'network', message: errorText('network') }; }
  }
}

/** `raise exception 'GC_X'` arrives as the message text; map it back to the code. */
const ERRORS_FROM_RAISE = (msg: string) => { const m = msg.match(/GC_[A-Z_]+/); return m ? m[0] : msg.includes('Failed to fetch') ? 'network' : msg; };
