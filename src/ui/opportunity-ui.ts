/**
 * The Revenue desk panel (gov-revenue): business permits & roles, market runs,
 * the car market (player-to-player listings), city investment funds, and the
 * giving economy (charity + help asks between citizens).
 */
import { fmtG } from '../game/state';
import type { Opportunity, PermitRole } from '../net/opportunity';

export interface OpportunityHost {
  opp: Opportunity;
  cash(): number;
  myVehicles(): { id: string; name: string }[];
  openPanel(id: string): void;
  toast(msg: string, ms?: number): void;
  ask(title: string, hint: string, placeholder: string, numeric?: boolean): Promise<string | null>;
  confirm(title: string): boolean;
  onMoney(): void;
  /** Ask a citizen for help (in-world: shows the ask in the dialogue layer). */
  begFromWorld(): void;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const ROLES: { role: PermitRole; icon: string; title: string; desc: string; fee: number }[] = [
  { role: 'trader', icon: '📦', title: 'Trader', desc: 'Buy and sell goods across the city. Unlocks market runs at this desk.', fee: 25000 },
  { role: 'food_seller', icon: '🍲', title: 'Food seller', desc: 'Run a food business. Market runs pay a small turnover bonus.', fee: 15000 },
  { role: 'car_dealer', icon: '🚗', title: 'Car dealer', desc: 'List your cars for sale to other citizens. The city takes a 5% market fee.', fee: 80000 },
];

export class OpportunityUI {
  render(id: string) { if (id === 'revenue') void this.renderDesk(); }
  stopTimers() { /* nothing ticking */ }

  constructor(private host: OpportunityHost) {}

  private async renderDesk() {
    const body = $('#revenueBody');
    body.innerHTML = '<p class="muted">Loading the revenue desk…</p>';
    let permits, invest, listings;
    try {
      [permits, invest, listings] = await Promise.all([
        this.host.opp.permits(), this.host.opp.investView(), this.host.opp.openListings(),
      ]);
    } catch (e: any) {
      body.innerHTML = `<p class="muted">${esc(e?.message ?? 'Could not open the desk')}</p>`;
      return;
    }
    const has = (r: PermitRole) => permits.some((p) => p.role === r);
    const portfolio = invest.mine.reduce((n, h) => n + h.value, 0);

    body.innerHTML = `
      <div class="regCard">
        <small>BUSINESS PERMITS — YOUR ROLES</small>
        ${permits.length ? permits.map((p) => `
          <div class="birthRow"><strong>${ROLES.find((r) => r.role === p.role)?.icon ?? '💼'} ${esc(p.business_name)}</strong>
            <span>${esc(p.role.replace('_', ' '))}</span>
            ${p.role !== 'car_dealer' ? `<button class="ghost" data-trade="${p.role}">Run to market</button>` : ''}</div>`).join('')
          : '<p class="muted">You hold no permits yet. A permit is a real role in the city — it opens the money paths below.</p>'}
        <div class="roleGrid">
          ${ROLES.map((r) => `
            <div class="roleCard ${has(r.role) ? 'owned' : ''}">
              <strong>${r.icon} ${r.title}</strong>
              <p>${r.desc}</p>
              ${has(r.role) ? '<em class="ownedTag">Permit active ✓</em>'
                : `<button class="primary" data-permit="${r.role}" data-fee="${r.fee}">Buy permit · ${fmtG(r.fee)}</button>`}
            </div>`).join('')}
        </div>
      </div>

      <div class="regCard">
        <small>CAR MARKET — CITIZEN LISTINGS</small>
        ${listings.length ? `<div class="birthList">${listings.map((l) => `
          <div class="birthRow"><strong>🚗 ${esc(l.model ?? 'Vehicle')}</strong>
            <span>${fmtG(l.price)} · from @${esc(l.seller ?? 'citizen')}</span>
            <button class="primary" data-buy="${l.id}">Buy</button></div>`).join('')}</div>`
          : '<p class="muted">No cars on the market right now.</p>'}
        ${has('car_dealer') ? `
          <label>List one of your cars (car dealers)</label>
          <div class="roleGrid" id="myCars"></div>` : '<p class="muted">A car dealer permit lets you list your cars here.</p>'}
      </div>

      <div class="regCard">
        <small>CITY INVESTMENT FUNDS</small>
        <p class="muted">Units are priced by the city clock — values move game-day by game-day. Portfolio: <strong>${fmtG(portfolio)}</strong></p>
        <div class="birthList">
          ${invest.funds.map((f) => `
            <div class="birthRow"><strong>${esc(f.name)}</strong>
              <span>${fmtG(f.price)}/unit · ${(f.daily_rate_bps / 100).toFixed(2)}%/day</span>
              <button class="ghost" data-fund-buy="${f.code}">Buy</button>
              <button class="ghost" data-fund-sell="${f.code}">Sell</button></div>`).join('')}
          ${invest.mine.map((h) => `
            <div class="birthRow"><strong>📈 ${esc(h.fund)}</strong>
              <span>${h.units.toFixed(3)} units · ${fmtG(h.value)}</span></div>`).join('')}
        </div>
      </div>

      <div class="regCard">
        <small>THE GIVING ECONOMY</small>
        <p>Nobody starts with nothing: the Community Fund gives a small daily charity to anyone who needs a start. Citizens can also ask each other for help — and giving is always a choice.</p>
        <div class="profileActions">
          <button class="primary" data-act="charity">🤲 Collect daily charity</button>
          <button class="ghost" data-act="beg">Ask a citizen for help</button>
        </div>
      </div>
    `;

    body.querySelectorAll('[data-permit]').forEach((el) => el.addEventListener('click', () => void this.buyPermit(el as HTMLElement)));
    body.querySelectorAll('[data-trade]').forEach((el) => el.addEventListener('click', () => void this.tradeRun((el as HTMLElement).dataset.trade as PermitRole)));
    body.querySelectorAll('[data-buy]').forEach((el) => el.addEventListener('click', () => void this.buyListing((el as HTMLElement).dataset.buy!)));
    body.querySelectorAll('[data-fund-buy]').forEach((el) => el.addEventListener('click', () => void this.invest('buy', (el as HTMLElement).dataset.fundBuy!)));
    body.querySelectorAll('[data-fund-sell]').forEach((el) => el.addEventListener('click', () => void this.invest('sell', (el as HTMLElement).dataset.fundSell!)));
    body.querySelector('[data-act="charity"]')?.addEventListener('click', () => void this.charity());
    body.querySelector('[data-act="beg"]')?.addEventListener('click', () => this.host.begFromWorld());

    // car dealer listing forms
    const cars = body.querySelector('#myCars');
    if (cars) {
      const mine = this.host.myVehicles();
      if (!mine.length) cars.innerHTML = '<p class="muted">You own no cars to list.</p>';
      for (const v of mine) {
        const row = document.createElement('div');
        row.className = 'birthRow';
        row.innerHTML = `<strong>🚗 ${esc(v.name)}</strong><input class="listPrice" placeholder="Price in G" inputmode="numeric" style="max-width:120px" /><button class="primary">List</button>`;
        row.querySelector('button')?.addEventListener('click', () => {
          const price = Number((row.querySelector('input') as HTMLInputElement).value);
          void (async () => {
            const r = await this.host.opp.listVehicle(v.id, price);
            this.host.toast(r.ok ? 'Listed on the car market.' : (r.message ?? 'Could not list'));
            if (r.ok) await this.renderDesk();
          })();
        });
        cars.appendChild(row);
      }
    }
  }

  private async buyPermit(el: HTMLElement) {
    const role = el.dataset.permit as PermitRole;
    const fee = Number(el.dataset.fee ?? 0);
    const name = await this.host.ask(
      'Register your business',
      `The ${role.replace('_', ' ')} permit costs ${fmtG(fee)} (paid to the city). What is your business name?`,
      'Business name (2–32 characters)', false);
    if (name === null) return;
    const r = await this.host.opp.buyPermit(role, name);
    this.host.toast(r.ok ? `💼 Permit issued — you are now a ${role.replace('_', ' ')}.` : (r.message ?? 'Could not issue'));
    if (r.ok) this.host.onMoney();
    await this.renderDesk();
  }

  private async tradeRun(role: PermitRole) {
    const r = await this.host.opp.tradeRun(role);
    if (r.ok) {
      this.host.toast(`📦 Market run done — profit ${fmtG(r.profit ?? 0)} (${r.left ?? 0} runs left today)`, 4200);
      this.host.onMoney();
    } else this.host.toast(r.message ?? 'Could not trade');
    await this.renderDesk();
  }

  private async buyListing(id: string) {
    if (!this.host.confirm('Buy this vehicle? The price is paid to the seller.')) return;
    const r = await this.host.opp.buyListing(id);
    this.host.toast(r.ok ? '🚗 The vehicle is yours. It will appear in your garage when online.' : (r.message ?? 'Could not buy'));
    if (r.ok) this.host.onMoney();
    await this.renderDesk();
  }

  private async invest(side: 'buy' | 'sell', fund: string) {
    const v = await this.host.ask(
      side === 'buy' ? `Invest in ${fund}` : `Sell ${fund} units`,
      side === 'buy' ? 'How much G do you want to invest? (min 100)' : 'How much G worth of units do you want to sell?',
      'Amount in G');
    if (v === null) return;
    const amount = Math.round(Number(v));
    if (!Number.isFinite(amount)) return;
    const r = side === 'buy' ? await this.host.opp.investBuy(fund, amount) : await this.host.opp.investSell(fund, amount);
    this.host.toast(r.ok
      ? (side === 'buy' ? `Bought ${r.units?.toFixed(3)} units in ${fund}.` : `Sold — ${fmtG(r.proceeds ?? 0)} back to your wallet.`)
      : (r.message ?? 'Could not complete'));
    if (r.ok) this.host.onMoney();
    await this.renderDesk();
  }

  private async charity() {
    const r = await this.host.opp.charity();
    this.host.toast(r.ok ? `🤲 The Community Fund gave you ${fmtG(r.amount ?? 0)} (${r.left ?? 0} left today). Use it well.` : (r.message ?? 'Nothing today'));
    if (r.ok) this.host.onMoney();
    await this.renderDesk();
  }
}
