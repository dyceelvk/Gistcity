/**
 * Opportunity & the giving economy: business permits (trader / food seller /
 * car dealer roles), market runs, player-to-player car sales, city investment
 * funds, charity and help-asks between citizens.
 *
 * Online every call is a SECURITY DEFINER database function (see
 * supabase/migrations/20261019000006_gistcity_opportunity.sql). Offline
 * practice mode keeps the same rules in a local save — money only ever moves
 * between the local wallet and local institutions.
 */
import type { Store } from '../game/state';
import { cloud, errorText } from './supabase';

export type PermitRole = 'trader' | 'food_seller' | 'car_dealer';
export interface Permit { role: PermitRole; business_name: string; issued_at: string }
export interface Listing { id: string; vehicle_id: string; price: number; seller?: string; model?: string }
export interface Fund { code: string; name: string; description: string; price: number; daily_rate_bps: number }
export interface Holding { fund: string; units: number; value: number }
export interface InvestmentView { funds: Fund[]; mine: Holding[] }
export interface BegAsk { id: string; amount: number; from: string; from_name: string; created_at: string }
export interface Result { ok: boolean; message?: string; error?: string; amount?: number; profit?: number; units?: number; proceeds?: number; left?: number; given?: boolean }

export interface Opportunity {
  readonly online: boolean;
  permits(): Promise<Permit[]>;
  buyPermit(role: PermitRole, businessName: string): Promise<Result>;
  tradeRun(role: PermitRole): Promise<Result>;
  listVehicle(vehicleId: string, price: number): Promise<Result>;
  unlist(listingId: string): Promise<Result>;
  buyListing(listingId: string): Promise<Result>;
  openListings(): Promise<Listing[]>;
  investView(): Promise<InvestmentView>;
  investBuy(fund: string, amount: number): Promise<Result>;
  investSell(fund: string, amountG: number): Promise<Result>;
  charity(): Promise<Result>;
  begAsk(username: string, amount: number): Promise<Result>;
  begRespond(askId: string, accept: boolean): Promise<Result>;
  begInbox(): Promise<BegAsk[]>;
}

export const OPP_ERRORS: Record<string, string> = {
  GC_UNKNOWN_ROLE: 'Unknown role.',
  GC_INVALID_NAME: 'Business name: 2–32 characters.',
  GC_ALREADY_PERMITTED: 'You already hold this permit.',
  GC_PERMIT_REQUIRED: 'You need the permit for this role first (Revenue desk).',
  GC_TRADE_DONE: 'You have traded enough today — the market closes for you.',
  GC_NOT_OWNER: 'That vehicle is not yours.',
  GC_NOT_FOUND: 'That listing no longer exists.',
  GC_SELF: 'That is your own listing.',
  GC_INVALID_AMOUNT: 'Check the amount.',
  GC_INSUFFICIENT_UNITS: 'You do not hold that much in this fund.',
  GC_UNKNOWN_FUND: 'Unknown fund.',
  GC_CHARITY_DONE: 'You have received today\'s charity — come back tomorrow.',
  GC_ASK_OPEN: 'You already asked this citizen — wait for their answer.',
  GC_BLOCKED: 'This citizen is not available.',
  GC_KEY_REQUIRED: 'Try that again.',
};
const oppError = (code?: string) => (code && OPP_ERRORS[code]) || errorText(code);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x'.repeat(8));
const PERMIT_FEES: Record<PermitRole, number> = { trader: 25000, food_seller: 15000, car_dealer: 80000 };

/* ------------------------------------------------------------------ cloud */

export class CloudOpportunity implements Opportunity {
  readonly online = true;
  private async call<T = any>(fn: string, args: Record<string, unknown>): Promise<T> {
    try { return await cloud.rpc<T>(fn, args); }
    catch (e: any) {
      const code = (String(e?.message ?? '').match(/GC_[A-Z_]+/) ?? [])[0];
      throw Object.assign(new Error(oppError(code)), { code });
    }
  }
  private async ok(fn: string, args: Record<string, unknown>): Promise<Result> {
    try { const r = await this.call<any>(fn, args); return { ok: true, ...r }; }
    catch (e: any) { return { ok: false, error: e.code, message: e.message }; }
  }
  async permits(): Promise<Permit[]> { return (await this.call<any[]>('my_permits', {})) ?? []; }
  buyPermit(role: PermitRole, businessName: string) { return this.ok('permit_buy', { p_role: role, p_business_name: businessName, p_key: uuid() }); }
  tradeRun(role: PermitRole) { return this.ok('trade_run', { p_role: role, p_key: uuid() }); }
  listVehicle(vehicleId: string, price: number) { return this.ok('vehicle_list', { p_vehicle: vehicleId, p_price: Math.round(price), p_key: uuid() }); }
  unlist(listingId: string) { return this.ok('vehicle_unlist', { p_listing: listingId }); }
  buyListing(listingId: string) { return this.ok('vehicle_buy_from', { p_listing: listingId, p_key: uuid() }); }
  async openListings(): Promise<Listing[]> {
    return (await this.call<any[]>('open_listings', {})) ?? [];
  }
  async investView(): Promise<InvestmentView> { return this.call('invest_view', {}); }
  investBuy(fund: string, amount: number) { return this.ok('invest_buy', { p_fund: fund, p_amount: Math.round(amount), p_key: uuid() }); }
  investSell(fund: string, amountG: number) { return this.ok('invest_sell', { p_fund: fund, p_amount_g: Math.round(amountG), p_key: uuid() }); }
  charity() { return this.ok('charity_collect', { p_key: uuid() }); }
  begAsk(username: string, amount: number) { return this.ok('beg_ask', { p_username: username.toLowerCase(), p_amount: Math.round(amount), p_key: uuid() }); }
  begRespond(askId: string, accept: boolean) { return this.ok('beg_respond', { p_ask: askId, p_accept: accept, p_key: uuid() }); }
  async begInbox(): Promise<BegAsk[]> { return (await this.call<any[]>('beg_inbox', {})) ?? []; }
}

/* ------------------------------------------------------------------ local */

interface LocalOppData {
  permits: Permit[];
  invested: Holding[];
  tradesToday: number; tradeDay: string;
  charityToday: number; charityDay: string;
  listings: (Listing & { mine: boolean })[];
}
const LKEY = 'gist_opportunity_v1';
const blank = (): LocalOppData => ({ permits: [], invested: [], tradesToday: 0, tradeDay: '', charityToday: 0, charityDay: '', listings: [] });

export class LocalOpportunity implements Opportunity {
  readonly online = false;
  private d: LocalOppData;
  constructor(private store: Store) {
    let d: LocalOppData | null = null;
    try { const raw = localStorage.getItem(LKEY); if (raw) d = { ...blank(), ...JSON.parse(raw) }; } catch { /* fresh */ }
    this.d = d ?? blank();
  }
  private save() { try { localStorage.setItem(LKEY, JSON.stringify(this.d)); } catch { /* ignore */ } }
  private pay(amount: number): boolean {
    if (this.store.state.cash < amount) return false;
    this.store.update((s) => { s.cash -= amount; });
    return true;
  }
  private earn(amount: number) { this.store.update((s) => { s.cash += amount; }); }
  private today() { return new Date().toISOString().slice(0, 10); }

  async permits(): Promise<Permit[]> { return [...this.d.permits]; }
  async buyPermit(role: PermitRole, businessName: string): Promise<Result> {
    const name = businessName.trim().slice(0, 32);
    if (name.length < 2) return { ok: false, message: oppError('GC_INVALID_NAME') };
    if (this.d.permits.some((p) => p.role === role)) return { ok: false, message: oppError('GC_ALREADY_PERMITTED') };
    const fee = PERMIT_FEES[role];
    if (!this.pay(fee)) return { ok: false, message: `You need ${fee.toLocaleString()} G for this permit.` };
    this.d.permits.push({ role, business_name: name, issued_at: new Date().toISOString() });
    this.save();
    return { ok: true, amount: fee };
  }
  async tradeRun(role: PermitRole): Promise<Result> {
    if (!this.d.permits.some((p) => p.role === role)) return { ok: false, message: oppError('GC_PERMIT_REQUIRED') };
    if (this.d.tradeDay !== this.today()) { this.d.tradeDay = this.today(); this.d.tradesToday = 0; }
    if (this.d.tradesToday >= 8) return { ok: false, message: oppError('GC_TRADE_DONE') };
    const profit = Math.round(700 + Math.random() * 1900 + (role === 'food_seller' ? 300 : 0));
    this.d.tradesToday++;
    this.save();
    this.earn(profit);
    return { ok: true, profit, left: 8 - this.d.tradesToday };
  }
  async listVehicle(vehicleId: string, price: number): Promise<Result> {
    if (!this.d.permits.some((p) => p.role === 'car_dealer')) return { ok: false, message: oppError('GC_PERMIT_REQUIRED') };
    if (price < 1) return { ok: false, message: oppError('GC_INVALID_AMOUNT') };
    this.d.listings = this.d.listings.filter((l) => l.vehicle_id !== vehicleId);
    this.d.listings.push({ id: uuid(), vehicle_id: vehicleId, price: Math.round(price), mine: true, model: vehicleId.slice(0, 8) });
    // a local market: another dealer may buy within the day
    window.setTimeout(() => {
      const l = this.d.listings.find((x) => x.vehicle_id === vehicleId);
      if (!l || !l.mine) return;
      if (Math.random() < 0.7) {
        const cut = Math.max(1, Math.round(l.price * 0.05));
        this.earn(l.price - cut);
        this.d.listings = this.d.listings.filter((x) => x.id !== l.id);
        this.save();
      }
    }, 8000);
    this.save();
    return { ok: true };
  }
  async unlist(listingId: string): Promise<Result> {
    const before = this.d.listings.length;
    this.d.listings = this.d.listings.filter((l) => !(l.id === listingId && l.mine));
    this.save();
    return this.d.listings.length < before ? { ok: true } : { ok: false, message: oppError('GC_NOT_FOUND') };
  }
  async buyListing(listingId: string): Promise<Result> {
    const l = this.d.listings.find((x) => x.id === listingId);
    if (!l) return { ok: false, message: oppError('GC_NOT_FOUND') };
    if (l.mine) return { ok: false, message: oppError('GC_SELF') };
    if (!this.pay(l.price)) return { ok: false, message: 'Not enough G.' };
    this.d.listings = this.d.listings.filter((x) => x.id !== listingId);
    this.save();
    return { ok: true, amount: l.price };
  }
  async openListings(): Promise<Listing[]> { return this.d.listings.map(({ mine: _m, ...l }) => l); }

  async investView(): Promise<InvestmentView> {
    // deterministic practice prices, same spirit as the server
    const funds: Fund[] = [
      { code: 'grain', name: 'GistCity Grain Index', description: 'Farms and food processing around the city.', price: 1000, daily_rate_bps: 12 },
      { code: 'hustle', name: 'Hustle Growth Fund', description: 'Small businesses: POS, dispatch, market trade.', price: 1000, daily_rate_bps: 30 },
      { code: 'estate', name: 'Civic Estate Trust', description: 'Development around the Civic Ring (steady).', price: 1000, daily_rate_bps: 20 },
    ];
    return { funds, mine: this.d.invested.map((h) => ({ ...h, value: Math.round(h.units * (funds.find((f) => f.code === h.fund)?.price ?? 1000)) })) };
  }
  async investBuy(fund: string, amount: number): Promise<Result> {
    if (amount < 100) return { ok: false, message: oppError('GC_INVALID_AMOUNT') };
    const view = await this.investView();
    const f = view.funds.find((x) => x.code === fund);
    if (!f) return { ok: false, message: oppError('GC_UNKNOWN_FUND') };
    if (!this.pay(amount)) return { ok: false, message: 'Not enough G.' };
    const units = Math.round((amount / f.price) * 1e6) / 1e6;
    const held = this.d.invested.find((h) => h.fund === fund);
    if (held) held.units += units; else this.d.invested.push({ fund, units, value: 0 });
    this.save();
    return { ok: true, units };
  }
  async investSell(fund: string, amountG: number): Promise<Result> {
    const view = await this.investView();
    const f = view.funds.find((x) => x.code === fund);
    const held = this.d.invested.find((h) => h.fund === fund);
    if (!f || !held) return { ok: false, message: oppError('GC_INSUFFICIENT_UNITS') };
    const units = Math.round((amountG / f.price) * 1e6) / 1e6;
    if (units <= 0 || units > held.units) return { ok: false, message: oppError('GC_INSUFFICIENT_UNITS') };
    const proceeds = Math.round(units * f.price);
    held.units = Math.round((held.units - units) * 1e6) / 1e6;
    if (held.units <= 0.000001) this.d.invested = this.d.invested.filter((h) => h.fund !== fund);
    this.save();
    this.earn(proceeds);
    return { ok: true, units, proceeds };
  }
  async charity(): Promise<Result> {
    if (this.d.charityDay !== this.today()) { this.d.charityDay = this.today(); this.d.charityToday = 0; }
    if (this.d.charityToday >= 5) return { ok: false, message: oppError('GC_CHARITY_DONE') };
    const amount = 150 + Math.floor(Math.random() * 451);
    this.d.charityToday++;
    this.save();
    this.earn(amount);
    return { ok: true, amount, left: 5 - this.d.charityToday };
  }
  async begAsk(username: string, amount: number): Promise<Result> {
    if (amount < 50 || amount > 20000) return { ok: false, message: oppError('GC_INVALID_AMOUNT') };
    // a local citizen hears you and answers after a beat
    const at = amount;
    window.setTimeout(() => {
      if (at <= 2000) {
        this.earn(at);
        // (their answer arrives through the dialogue/toast layer)
      }
    }, 1800);
    return { ok: true, amount: at };
  }
  async begRespond(): Promise<Result> { return { ok: true, given: true }; }
  async begInbox(): Promise<BegAsk[]> { return []; }
}

export const makeOpportunity = (store: Store): Opportunity =>
  (cloud.enabled && cloud.signedIn ? new CloudOpportunity() : new LocalOpportunity(store));
