/**
 * The Civil Registry panel: marriage proposals with a real marriage agreement
 * both sides sign, the family tree (spouse, children, parents with ages), and
 * the daily birth registry where every newborn is matched to the parents who
 * gave birth that day. The family-room childbirth itself is an in-world scene
 * (see Game.familyRoom) — abstract and non-explicit by design.
 */
import type { Family, Marriage } from '../net/family';

export interface FamilyHost {
  family: Family;
  openPanel(id: string): void;
  toast(msg: string, ms?: number): void;
  ask(title: string, hint: string, placeholder: string, numeric?: boolean): Promise<string | null>;
  confirm(title: string): boolean;
  /** Something about the family changed (marriage, birth) — the game refreshes. */
  onFamilyChanged(): void;
  /** Runs the in-world family-room scene (fade to black + registration). */
  familyRoom(): void;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');

export class FamilyUI {
  private poll = 0;
  render(id: string) { if (id === 'registry') void this.renderRegistry(); }
  stopTimers() { window.clearTimeout(this.poll); this.poll = 0; }

  constructor(private host: FamilyHost) {}

  async activeMarriage(): Promise<Marriage | null> {
    const ms = await this.host.family.marriages().catch(() => [] as Marriage[]);
    return ms.find((m) => m.status === 'active') ?? null;
  }

  private async renderRegistry() {
    const body = $('#registryBody');
    body.innerHTML = '<p class="muted">Loading registry…</p>';
    let me, tree, marriages, births;
    try {
      [me, tree, marriages, births] = await Promise.all([
        this.host.family.me(),
        this.host.family.tree(),
        this.host.family.marriages(),
        this.host.family.birthRegistry(),
      ]);
    } catch (e: any) {
      body.innerHTML = `<p class="muted">${esc(e?.message ?? 'Could not open the registry')}</p>`;
      return;
    }
    const proposed = marriages.find((m) => m.status === 'proposed');
    const active = marriages.find((m) => m.status === 'active');
    const ended = marriages.filter((m) => m.status === 'ended');

    body.innerHTML = `
      <div class="regCard">
        <small>YOUR RECORD</small>
        <div class="regMe"><strong>${esc(me.name)}</strong><span class="ageChip">${Math.floor(me.age)} y/o</span></div>
        <p class="muted">${active ? `Married to <strong>${esc(active.partner)}</strong> · since ${when(active.activated_at)}`
          : proposed ? `Proposal to <strong>${esc(proposed.partner)}</strong> waiting for signatures`
          : 'Single — you may propose marriage at this desk.'}</p>
      </div>

      ${!active && !proposed ? `
      <div class="regCard">
        <small>PROPOSE MARRIAGE</small>
        <input id="proposeWho" placeholder="Their username (e.g. chioma)" autocomplete="off" ${me.age < 18 ? 'disabled' : ''} />
        <label>Marriage agreement — what you both promise each other</label>
        <textarea id="proposeTerms" rows="3" maxlength="1000" ${me.age < 18 ? 'disabled' : ''}>We agree to build a life together in GistCity: shared respect, shared decisions, and honesty about our time, money and family.</textarea>
        <button class="primary" id="proposeBtn" ${me.age < 18 ? 'disabled title="Adults only (18+)"' : ''}>Send proposal</button>
        ${me.age < 18 ? '<p class="muted">You must be 18 or older to marry.</p>' : ''}
      </div>` : ''}

      ${proposed ? `
      <div class="regCard">
        <small>MARRIAGE AGREEMENT — NEEDS BOTH SIGNATURES</small>
        <p class="agreeText">${esc(proposed.agreement)}</p>
        <div class="signRow">
          <span>${proposed.i_signed ? '✅' : '⬜'} You (${esc(me.name)})</span>
          <span>${proposed.partner_signed ? '✅' : '⬜'} ${esc(proposed.partner)}</span>
        </div>
        <div class="profileActions">
          ${proposed.i_signed ? '<button class="ghost off" disabled>Waiting for their signature…</button>' : '<button class="primary" id="signBtn">Read &amp; sign the agreement</button>'}
          <button class="ghost danger" id="cancelBtn">Withdraw proposal</button>
        </div>
        <p class="muted">The marriage becomes active only when <em>both</em> of you have signed.</p>
      </div>` : ''}

      ${active ? `
      <div class="regCard">
        <small>FAMILY ROOM</small>
        <p>Married couples can start a family at the GistCity General Hospital maternity room — enter together and a new life is registered to you both. The scene is gentle and private: enter the room, fade to black, and your newborn is matched to you in today's registry.</p>
        <div class="profileActions">
          <button class="primary" id="familyRoomBtn">Go to the family room</button>
          <button class="ghost danger" id="endBtn">End the marriage</button>
        </div>
      </div>` : ''}

      <div class="regCard">
        <small>FAMILY TREE</small>
        <div class="tree">
          <div class="treeRow"><span class="treeTag">Parents</span>
            ${tree.parents.mother ? `<span class="treePerson">👩 ${esc(tree.parents.mother.name)} <em>${Math.floor(tree.parents.mother.age)} y/o</em></span>` : '<span class="muted">—</span>'}
            ${tree.parents.father ? `<span class="treePerson">👨 ${esc(tree.parents.father.name)} <em>${Math.floor(tree.parents.father.age)} y/o</em></span>` : ''}
          </div>
          <div class="treeRow"><span class="treeTag">You</span>
            <span class="treePerson me">🧑 ${esc(tree.self.name)} <em>${Math.floor(tree.self.age)} y/o</em></span>
            ${tree.spouse ? `<span class="treePerson">💍 ${esc(tree.spouse.name)} <em>${Math.floor(tree.spouse.age)} y/o</em></span>` : ''}
          </div>
          <div class="treeRow"><span class="treeTag">Children</span>
            ${tree.children.length
              ? tree.children.map((c) => `<span class="treePerson">👶 ${esc(c.name)} <em>${Math.floor(c.age)} y/o</em></span>`).join('')
              : '<span class="muted">None yet.</span>'}
          </div>
        </div>
      </div>

      <div class="regCard">
        <small>BIRTH REGISTRY — TODAY</small>
        ${births.length ? `<div class="birthList">${births.map((b) => `
          <div class="birthRow"><strong>👶 ${esc(b.name)}</strong>
            <span>matched to <strong>${esc(b.mother ?? '—')}</strong> &amp; <strong>${esc(b.father ?? '—')}</strong></span>
            <small>${when(b.registered_at)}</small></div>`).join('')}</div>`
          : '<p class="muted">No births registered today.</p>'}
      </div>

      ${ended.length ? `<div class="regCard"><small>PAST MARRIAGES</small>
        ${ended.map((m) => `<p class="muted">${esc(m.partner)} — ended ${when(m.activated_at)}</p>`).join('')}</div>` : ''}
    `;

    $('#proposeBtn')?.addEventListener('click', () => void this.propose());
    $('#signBtn')?.addEventListener('click', () => void this.sign(proposed!));
    $('#cancelBtn')?.addEventListener('click', () => void this.withdraw(proposed!));
    $('#familyRoomBtn')?.addEventListener('click', () => this.host.familyRoom());
    $('#endBtn')?.addEventListener('click', () => void this.end(active!));

    // while a signature is still pending, keep the record fresh (the other side
    // may countersign at any moment — online over realtime, locally after a beat)
    window.clearTimeout(this.poll);
    if (proposed && !proposed.partner_signed) {
      this.poll = window.setTimeout(() => { if ($('#registryBody')) void this.renderRegistry(); }, 2500);
    }
  }

  private async propose() {
    const who = ($('#proposeWho') as HTMLInputElement).value.trim();
    const terms = ($('#proposeTerms') as HTMLTextAreaElement).value.trim();
    if (!who) { this.host.toast('Enter their username first.'); return; }
    if (!this.host.confirm(`Send a marriage proposal to @${who}? They will need to sign the agreement too.`)) return;
    const r = await this.host.family.propose(who, terms);
    this.host.toast(r.ok ? `💍 Proposal sent to @${who} — they will review the agreement.` : (r.message ?? 'Could not send'));
    if (r.ok) this.host.onFamilyChanged();
    await this.renderRegistry();
  }

  private async sign(m: Marriage) {
    if (!this.host.confirm('Sign this marriage agreement? The marriage becomes active when both of you have signed.')) return;
    const r = await this.host.family.sign(m.id);
    this.host.toast(r.ok ? (r.status === 'active' ? '💍 You are married!' : 'Signed — waiting for their signature.') : (r.message ?? 'Could not sign'));
    if (r.ok) this.host.onFamilyChanged();
    await this.renderRegistry();
  }

  private async withdraw(m: Marriage) {
    if (!this.host.confirm('Withdraw this proposal?')) return;
    const r = await this.host.family.end(m.id, 'proposal withdrawn');
    this.host.toast(r.ok ? 'Proposal withdrawn.' : (r.message ?? 'Could not withdraw'));
    await this.renderRegistry();
  }

  private async end(m: Marriage) {
    const reason = await this.host.ask('End the marriage', 'You may leave at any time. A short reason goes on the record (optional).', 'Reason (optional)', false);
    if (reason === null) return;
    const r = await this.host.family.end(m.id, reason || 'unstated');
    this.host.toast(r.ok ? 'The marriage has been ended.' : (r.message ?? 'Could not end'));
    if (r.ok) this.host.onFamilyChanged();
    await this.renderRegistry();
  }
}
