/**
 * Panels for the living-society systems: Unity College (education), the
 * Government Secretariat (10-step employment), the hospital, Grace Chapel
 * ("Church 🏠"), Odogwu Motors, your vehicles and the citizens panel.
 * Everything here calls the server (or the practice simulation offline) and
 * shows the real result — no decorative buttons.
 */
import { fmtG, type Store } from '../game/state';
import type { Society, EducationView, GovStatus, ChurchInfo, VehicleModel, VehicleView, InterviewQuestion } from '../net/society';
import { HOSPITAL_SERVICES } from '../net/society';
import { cloud, type RemoteState, type Area } from '../net/supabase';

export interface SocietyHost {
  store: Store;
  society: Society;
  toast(msg: string, ms?: number): void;
  ask(title: string, hint: string, placeholder: string, numeric?: boolean): Promise<string | null>;
  closePanel(): void;
  /** Where am I (for the citizens panel + contextual hints). */
  area(): Area;
  activity(): string;
  /** Buy a vehicle; the game chooses the forecourt spot and refreshes the street. */
  buyVehicle(model: string, color: string): Promise<void>;
  myVehicles(): VehicleView[];
  refreshVehicles(): Promise<void>;
  /** Run the shift minigame then pay via the server. */
  workShift(): Promise<void>;
  /** Attend the live service: reserves a seat server-side then sits you on a pew. */
  attendService(serviceId: number): Promise<void>;
  /** Hospital purchase (server-authorised) + needs effects. */
  treat(id: string): Promise<void>;
  health(): number;
  churchSlug(): string;
  onlineCount(): number;
  award(id: string): void;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const secs = (s: number) => s <= 0 ? 'now' : s < 60 ? `${Math.ceil(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.ceil(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
const ago = (iso: string) => { const d = (Date.now() - new Date(iso).getTime()) / 1000; return d < 60 ? 'just now' : d < 3600 ? `${Math.floor(d / 60)} min ago` : d < 86400 ? `${Math.floor(d / 3600)} h ago` : new Date(iso).toLocaleDateString(); };
export const AREA_LABEL: Record<Area, string> = { city: 'the streets', home: 'at home', school: 'Unity College', gov: 'the Secretariat', hospital: 'the hospital', church: 'Grace Chapel', dealer: 'Odogwu Motors' };

export class SocietyPanels {
  private timers = new Map<string, number>();
  private edu: EducationView | null = null;
  private gov: GovStatus | null = null;
  private church: ChurchInfo | null = null;
  private models: VehicleModel[] | null = null;
  private interview: InterviewQuestion[] | null = null;
  private pickedColor = new Map<string, string>();
  private busy = false;

  constructor(private host: SocietyHost) {
    for (const id of ['school', 'gov', 'hospital', 'church', 'dealer', 'vehicles', 'online']) {
      const body = document.getElementById(`${id}Body`);
      body?.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]'); if (b && !b.classList.contains('off')) void this.act(id, b.dataset.act!, b.dataset); });
    }
  }
  /** Called by the HUD when a panel opens; starts a light refresh loop for live data. */
  render(id: string) {
    this.stopTimers();
    if (id === 'school') void this.renderSchool();
    else if (id === 'gov') { void this.renderGov(); this.timers.set('gov', window.setInterval(() => void this.renderGov(true), 5000)); }
    else if (id === 'hospital') this.renderHospital();
    else if (id === 'church') { void this.renderChurch(); this.timers.set('church', window.setInterval(() => void this.renderChurch(true), 10000)); }
    else if (id === 'dealer') void this.renderDealer();
    else if (id === 'vehicles') void this.renderVehicles();
    else if (id === 'online') { this.renderOnline(); this.timers.set('online', window.setInterval(() => this.renderOnline(), 3000)); }
  }
  stopTimers() { for (const t of this.timers.values()) clearInterval(t); this.timers.clear(); }
  /**
   * Replace a panel body. On quiet (timer) refreshes, if nothing but the
   * countdowns changed, only the `[data-cd]` texts are patched so buttons are
   * never yanked from under a finger and the scroll position stays put.
   */
  private set(id: string, html: string, quiet = false) {
    const el = document.getElementById(`${id}Body`); if (!el) return;
    const strip = (h: string) => h.replace(/(<(\w+)[^>]*data-cd[^>]*>)[^<]*(<\/\2>)/g, '$1$3');
    const key = strip(html);
    if (quiet && el.dataset.key === key) {
      const tpl = document.createElement('template'); tpl.innerHTML = html;
      const a = el.querySelectorAll('[data-cd]'), b = tpl.content.querySelectorAll('[data-cd]');
      a.forEach((n, i) => { const t = b[i]?.textContent ?? ''; if (n.textContent !== t) n.textContent = t; });
      return;
    }
    const scroller = el.closest('.panel') as HTMLElement | null; const top = scroller?.scrollTop ?? 0;
    el.innerHTML = html; el.dataset.key = key;
    if (scroller) scroller.scrollTop = top;
  }
  private cd(text: string) { return `<span data-cd>${text}</span>`; }
  private fail(e: unknown) { this.host.toast((e as any)?.message ?? 'Something went wrong'); }

  /* ------------------------------------------------------------- school */

  private async renderSchool() {
    this.set('school', '<p class="muted">Loading the prospectus…</p>');
    try { this.edu = await this.host.society.education(); } catch (e) { this.set('school', `<p class="muted">${esc((e as any)?.message ?? 'Could not reach Unity College')}</p>`); return; }
    const v = this.edu, cash = this.host.store.state.cash;
    const cards = v.courses.map((c) => {
      const ready = c.status === 'enrolled' && c.classes_attended >= c.classes_required;
      const chip = c.status === 'passed' ? '<span class="chip ok">Certified ✓</span>' : c.status === 'enrolled' ? `<span class="chip">Enrolled · ${c.classes_attended}/${c.classes_required} classes</span>` : `<span class="chip dim">Fee ${fmtG(c.fee)}</span>`;
      let action = '';
      if (!c.status) action = `<button class="primary ${cash < c.fee ? 'off' : ''}" data-act="enrol" data-course="${c.id}">${cash < c.fee ? `Need ${fmtG(c.fee)}` : `Enrol · ${fmtG(c.fee)}`}</button>`;
      else if (c.status === 'enrolled' && ready) action = `<button class="primary" data-act="exam" data-course="${c.id}">Take the exam (pass mark ${c.pass_mark}%)</button>`;
      else if (c.status === 'enrolled') action = `<p class="tip">${c.next_class_in > 0 ? `Next class in ${secs(c.next_class_in)}.` : 'A class is open now.'} Sit in the classroom (📚) to attend — ${c.classes_required - c.classes_attended} more to go.${c.attempts ? ` Exam attempts: ${c.attempts}.` : ''}</p>`;
      else action = `<p class="tip">${esc(c.certificate_title)} — on your record.</p>`;
      return `<div class="card"><div class="cardTop"><strong>${esc(c.title)}</strong>${chip}</div><p>${esc(c.description)}</p><small class="muted">${c.classes_required} classes · exam pass mark ${c.pass_mark}% · certificate: ${esc(c.certificate_title)}</small>${action}</div>`;
    }).join('');
    const certs = v.certificates.length ? v.certificates.map((c) => `<div class="kv cert"><span><strong>${esc(c.title)}</strong><br><small class="muted">grade ${esc(c.grade)} · ${c.score}% · serial <code>${esc(c.serial)}</code></small></span><span>${new Date(c.issued_at).toLocaleDateString()}</span></div>`).join('') : '<p class="muted">No certificates yet. Pass an exam and it is issued by the school — with a serial the Registry can verify.</p>';
    this.set('school', `<h4>Courses</h4><div class="cards">${cards}</div><h4>Your certificates</h4>${certs}<p class="muted small">${this.host.society.online ? 'Issued and verified server-side.' : 'Practice mode: progress is saved on this device until you sign in.'}</p>`);
  }

  /* --------------------------------------------------------- government */

  private async renderGov(quiet = false) {
    if (!quiet) this.set('gov', '<p class="muted">Checking your file at the Secretariat…</p>');
    try { this.gov = await this.host.society.govStatus(); } catch (e) { if (!quiet) this.set('gov', `<p class="muted">${esc((e as any)?.message ?? 'The Secretariat is not reachable')}</p>`); return; }
    const g = this.gov, a = g.application, emp = g.employment;
    let top = '';
    if (emp) {
      const next = emp.next_shift_in;
      top = `<div class="card hero"><div class="cardTop"><strong>${esc(emp.title)}</strong><span class="chip ok">Employed</span></div><p>${esc(emp.dept)} · employee no. <code>${esc(emp.employee_no)}</code></p>
        <div class="kv"><span>Salary per shift</span><span>${fmtG(emp.salary_per_shift)}</span></div><div class="kv"><span>Shifts worked</span><span>${emp.shifts_worked}</span></div><div class="kv"><span>Payroll account</span><span>${fmtG(g.payroll_balance)}</span></div>
        ${next > 0 ? `<p class="tip">Next shift opens in ${this.cd(secs(next))}.</p>` : '<p class="tip">A shift is open now: 5 citizens to serve at the desk.</p>'}
        <div class="row"><button class="primary ${next > 0 ? 'off' : ''}" data-act="shift">${next > 0 ? `Shift in ${this.cd(secs(next))}` : 'Work a shift'}</button><button class="ghost" data-act="resign">Resign</button></div></div>`;
    } else if (a) {
      const steps = g.steps.map((s) => { const done = a.step > s.step || a.status === 'hired'; const cur = a.step === s.step && a.status === 'in_progress'; return `<li class="${done ? 'done' : cur ? 'cur' : ''}"><b>${s.step}</b><div><strong>${esc(s.name)}</strong><small>${esc(s.description)}</small></div></li>`; }).join('');
      let action = '';
      if (a.status === 'rejected') action = `<p class="warn">Application rejected: ${esc(a.reason ?? 'not eligible')}.</p><button class="ghost" data-act="withdraw">Clear file</button>`;
      else if (a.step === 6) action = this.interview ? this.interviewForm(this.interview) : `<button class="primary" data-act="interview">Start the interview</button>`;
      else if (a.step === 8) action = `<div class="row"><button class="primary" data-act="offer" data-accept="1">Accept the offer</button><button class="ghost" data-act="offer" data-accept="0">Decline</button></div>`;
      else if (a.status === 'in_progress') action = `<p class="tip">${a.step === 4 && a.queue_ahead > 0 ? `Queue no. ${a.queue_no} · ${a.queue_ahead} ahead of you. ` : a.queue_no ? `Queue no. ${a.queue_no}. ` : ''}The office moves the file in ${this.cd(secs(a.wait_s))}.</p><button class="ghost" data-act="withdraw">Withdraw application</button>`;
      top = `<div class="card hero"><div class="cardTop"><strong>Application: ${esc(a.title)}</strong><span class="chip ${a.status === 'rejected' ? 'bad' : ''}">Step ${a.step}/10 · ${esc(a.status.replace('_', ' '))}</span></div><ol class="stepper">${steps}</ol>${action}
        <details><summary>Audit trail (${a.history.length})</summary>${a.history.map((h) => `<div class="kv small"><span>Step ${h.step} · ${esc(h.note)}</span><span data-cd>${ago(h.at)}</span></div>`).join('')}</details></div>`;
    }
    const positions = g.positions.map((p) => {
      const can = !emp && !(a && a.status === 'in_progress');
      const req = p.required_course ? (p.has_certificate ? `<span class="chip ok">✓ ${esc(p.required_title)}</span>` : `<span class="chip bad">Needs ${esc(p.required_title)}</span>`) : '<span class="chip ok">No certificate required</span>';
      const full = p.filled >= p.slots;
      return `<div class="card"><div class="cardTop"><strong>${esc(p.title)}</strong><span class="chip dim">Grade ${p.grade}</span></div><p>${esc(p.dept)} · ${esc(p.description)}</p>${req}
        <div class="kv"><span>Salary per shift</span><span>${fmtG(p.salary_per_shift)}</span></div><div class="kv"><span>Slots</span><span>${p.filled}/${p.slots} filled${p.queue ? ` · ${p.queue} in queue` : ''}</span></div>
        ${can ? `<button class="primary ${p.has_certificate || !p.required_course ? '' : 'off'}" data-act="apply" data-pos="${p.id}">${full ? 'Join the waiting list' : 'Apply'}</button>` : ''}</div>`;
    }).join('');
    this.set('gov', `${top}<h4>Open positions</h4><p class="muted small">Ten-step process: application → verification → queue → interview → offer → onboarding. Salaries come from the Government Payroll account (${fmtG(g.payroll_balance)}), never from thin air.</p><div class="cards">${positions}</div>`, quiet);
  }
  private interviewForm(qs: InterviewQuestion[]) {
    return `<form id="interviewForm" class="interview">${qs.map((q) => `<fieldset><legend>${esc(q.question)}</legend>${q.options.map((o, i) => `<label><input type="radio" name="q${q.id}" value="${i}" required> ${esc(o)}</label>`).join('')}</fieldset>`).join('')}<button class="primary" data-act="answer">Submit answers</button></form>`;
  }

  /* ----------------------------------------------------------- hospital */

  private renderHospital() {
    const cash = this.host.store.state.cash, hp = this.host.health();
    const level = hp > 60 ? 'ok' : hp > 30 ? 'warn' : 'bad';
    const items = HOSPITAL_SERVICES.map((s) => `<div class="card row"><span class="ic">${s.icon}</span><div><strong>${esc(s.name)}</strong><br><small class="muted">${s.id === 'svc-checkup' ? 'Nurse reads your vitals.' : s.id === 'svc-treatment' ? 'Health +60. Doctor on duty.' : s.id === 'med-paracetamol' ? 'Health +20.' : s.id === 'med-vitamin-c' ? 'Health +10 · energy +5.' : 'Hunger +25 · thirst +10.'}</small></div><button class="primary ${cash < s.price ? 'off' : ''}" data-act="treat" data-id="${s.id}">${s.price ? fmtG(s.price) : 'Free'}</button></div>`).join('');
    this.set('hospital', `<div class="card hero"><div class="cardTop"><strong>Your health</strong><span class="chip ${level}">${Math.round(hp)}%</span></div><i class="bar"><b style="width:${Math.round(hp)}%"></b></i><p class="tip">Health drops slowly, faster when you are starving, dehydrated or exhausted. Low health only slows you down — nobody dies in GistCity. Sleep restores a little; treatment restores a lot.</p></div><h4>Services</h4>${items}`);
  }

  /* ------------------------------------------------------------- church */

  private async renderChurch(quiet = false) {
    if (!quiet) this.set('church', '<p class="muted">Opening the church register…</p>');
    try { this.church = await this.host.society.churchInfo(this.host.churchSlug()); } catch (e) { if (!quiet) this.set('church', `<p class="muted">${esc((e as any)?.message ?? 'Could not load the church')}</p>`); return; }
    const c = this.church, me = c.my_role;
    const services = c.services.map((s) => `<div class="card row"><div><strong>${esc(s.title)}</strong> ${s.live ? `<span class="chip live">LIVE · ends in ${this.cd(secs(s.ends_in_s))}</span>` : `<span class="chip dim">in ${this.cd(secs(s.starts_in_s))}</span>`}<br><small class="muted">${esc(s.description)} · ${s.duration_min} min · ${s.attending} attending${s.my_seat ? ` · your seat #${s.my_seat}` : ''}</small></div>${s.live ? `<button class="primary ${s.my_seat || c.available <= 0 ? 'off' : ''}" data-act="attend" data-service="${s.id}">${s.my_seat ? 'Seated' : c.available <= 0 ? 'Full' : 'Attend'}</button>` : ''}</div>`).join('');
    const offerings = c.recent_offerings.length ? c.recent_offerings.slice(0, 6).map((o) => `<div class="kv small"><span>${esc(o.from)}</span><span>${fmtG(o.amount)} · ${this.cd(ago(o.at))}</span></div>`).join('') : '<p class="muted small">No offerings yet.</p>';
    const expenses = c.expenses.length ? c.expenses.slice(0, 6).map((e) => `<div class="kv small"><span>${esc(e.reason)}</span><span>${fmtG(e.amount)} · ${this.cd(ago(e.at))}</span></div>`).join('') : '<p class="muted small">No expenses recorded.</p>';
    const salary = c.salary ? `<div class="kv"><span>Pastor salary agreement</span><span>${fmtG(c.salary.amount)} / week · ${c.salary.approved_at ? 'approved' : 'awaiting a member\'s approval'}</span></div>` : '<div class="kv"><span>Pastor salary agreement</span><span>none proposed</span></div>';
    const pastorTools = c.pastor_is_me ? `<h4>Pastor tools</h4><div class="row"><button class="ghost" data-act="pay">Authorise an expense</button><button class="ghost" data-act="salary" data-mode="propose">Propose salary</button>${c.salary?.approved_at ? '<button class="ghost" data-act="salary" data-mode="claim">Claim weekly salary</button>' : ''}</div><p class="muted small">Every payment leaves the church account through the ledger with a reason — members can see it above.</p>` : '';
    const memberTools = me && !c.pastor_is_me && c.salary && !c.salary.approved_at ? `<button class="ghost" data-act="salary" data-mode="approve">Approve the pastor's salary (${fmtG(c.salary.amount)}/week)</button>` : '';
    const others = c.other_churches.length ? `<h4>Other churches</h4>${c.other_churches.map((o) => `<div class="kv small"><span>${esc(o.name)} · pastor ${esc(o.pastor)}</span><span>${o.members} members</span></div>`).join('')}` : '';
    this.set('church', `<div class="card hero"><div class="cardTop"><strong>${esc(c.name)}</strong><span class="chip ${me ? 'ok' : 'dim'}">${me ? (c.pastor_is_me ? 'You are the pastor' : `Member · ${me}`) : 'Visitor'}</span></div><p>${esc(c.description)}</p>
      <div class="statGrid"><div class="stat"><small>PASTOR</small><strong>${esc(c.pastor)}</strong></div><div class="stat"><small>MEMBERS</small><strong>${c.members}</strong></div><div class="stat"><small>ATTENDING NOW</small><strong>${c.attending_now}</strong></div><div class="stat"><small>SEATS</small><strong>${c.seats}</strong><small>${c.occupied} occupied · ${c.available} free</small></div></div>
      <div class="row">${me ? (c.pastor_is_me ? '' : '<button class="ghost" data-act="leave">Leave church</button>') : '<button class="primary" data-act="join">Join this church</button>'}<button class="primary" data-act="give">Give an offering</button></div></div>
      <h4>Services</h4>${services}
      <h4>Church account</h4><div class="kv"><span>Balance</span><span>${fmtG(c.balance)}</span></div>${salary}${memberTools}<details><summary>Recent offerings</summary>${offerings}</details><details><summary>Authorised expenses</summary>${expenses}</details>${pastorTools}${others}
      <h4>Start a church</h4><p class="muted small">Any citizen can register a church (registration fee 50,000 G to the Treasury). You become its pastor; members join, attend and give — all through the same ledger.</p><button class="ghost" data-act="register">Register a new church</button>`, quiet);
  }

  /* ------------------------------------------------------------- dealer */

  private async renderDealer() {
    this.set('dealer', '<p class="muted">Chief Odogwu is bringing the price list…</p>');
    try { this.models = await this.host.society.vehicleModels(); } catch (e) { this.set('dealer', `<p class="muted">${esc((e as any)?.message ?? 'Showroom closed')}</p>`); return; }
    const cash = this.host.store.state.cash, lic = this.host.society.hasCertificate('drivers-licence');
    const cards = this.models.map((m) => {
      const picked = this.pickedColor.get(m.id) ?? m.colors[0];
      const sw = m.colors.map((col) => `<button class="swatch ${col === picked ? 'on' : ''}" style="background:${col}" data-act="color" data-model="${m.id}" data-color="${col}" aria-label="${col}"></button>`).join('');
      const blocked = m.requires_licence && !lic ? 'Licence required' : m.stock <= 0 ? 'Sold out' : cash < m.price ? `Need ${fmtG(m.price)}` : '';
      return `<div class="card"><div class="cardTop"><strong>${esc(m.name)}</strong><span class="chip dim">${m.stock} in stock</span></div><p>${esc(m.description)}</p><div class="kv"><span>Top speed</span><span>${m.top_speed} m/s</span></div><div class="swatches">${sw}</div>
        <button class="primary ${blocked ? 'off' : ''}" data-act="buy" data-model="${m.id}">${blocked || `Buy · ${fmtG(m.price)}`}</button></div>`;
    }).join('');
    this.set('dealer', `<p class="muted small">${lic ? 'Licence verified ✓ — pick a colour and buy. Your car is delivered to the forecourt outside.' : 'No licence, no sale: pass the driving course at Unity College first (3,000 G).'}</p><div class="cards">${cards}</div>`);
  }

  /* ----------------------------------------------------------- vehicles */

  private async renderVehicles() {
    this.set('vehicles', '<p class="muted">Checking the keys…</p>');
    try { await this.host.refreshVehicles(); } catch (e) { this.fail(e); }
    const list = this.host.myVehicles();
    if (!list.length) { this.set('vehicles', '<p class="muted">You do not own a vehicle yet. Get a licence at Unity College, then visit Odogwu Motors (east ring road).</p>'); return; }
    this.set('vehicles', list.map((v) => `<div class="card"><div class="cardTop"><strong><i class="dot" style="background:${esc(v.color)}"></i> ${esc(v.name)}</strong><span class="chip ${v.mine ? 'ok' : 'dim'}">${v.mine ? 'Owner' : `Keys from ${esc(v.owner_name ?? 'a friend')}`}</span></div>
      <div class="kv"><span>Plate</span><span><code>${esc(v.plate)}</code></span></div><div class="kv"><span>Parked</span><span>${v.area === 'city' ? `near ${this.where(v.x, v.z)}` : esc(v.area)}</span></div>
      ${v.mine ? `<div class="kv"><span>Keys shared with</span><span>${v.keys.length ? v.keys.map((k) => `@${esc(k)} <button class="mini" data-act="revoke" data-vehicle="${v.id}" data-user="${esc(k)}">×</button>`).join(' ') : 'nobody'}</span></div><button class="ghost" data-act="share" data-vehicle="${v.id}">Share keys with a citizen</button>` : ''}</div>`).join('') + '<p class="muted small">Walk up to your car and choose Drive. Joystick/W-A-S-D to drive, E or the exit button to park.</p>');
  }
  private where(x: number, z: number) {
    if (Math.hypot(x, z) < 12) return 'the roundabout';
    if (z < -50) return 'the north ring road'; if (z > 50) return 'the south ring road'; if (x < -50) return 'the west ring road'; if (x > 50) return 'the east ring road';
    return x < 0 ? (z < 0 ? 'the market' : 'Old Road') : (z < 0 ? 'Gist Heights' : 'the Pitch');
  }

  /* ------------------------------------------------------------- online */

  private renderOnline() {
    const me = this.host.area();
    const remotes = [...cloud.remote.values()];
    const inArea = remotes.filter((r) => r.area === me).length;
    const active = remotes.filter((r) => r.activity || r.vehicle).length;
    const rows = remotes.length ? remotes.map((r) => `<div class="kv"><span><strong>${esc(r.name)}</strong> <small class="muted">@${esc(r.username)}</small></span><span>${this.doing(r)}</span></div>`).join('') : `<p class="muted">${this.host.society.online ? 'Nobody else is online right now. Share the link!' : 'Practice mode — sign in to see other citizens.'}</p>`;
    this.set('online', `<div class="statGrid"><div class="stat"><small>ONLINE NOW</small><strong>${remotes.length + (this.host.society.online ? 1 : 0)}</strong></div><div class="stat"><small>IN ${esc(AREA_LABEL[me]).toUpperCase()}</small><strong>${inArea + 1}</strong></div><div class="stat"><small>IN AN ACTIVITY</small><strong>${active + (this.host.activity() ? 1 : 0)}</strong></div></div>
      <p class="muted small">You: ${esc(AREA_LABEL[me])}${this.host.activity() ? ` · ${esc(this.host.activity())}` : ''}</p>${rows}`);
  }
  private doing(r: RemoteState) {
    if (r.vehicle) return `driving a ${esc(r.vehicle.model.replace(/-/g, ' '))}`;
    if (r.activity) return esc(r.activity);
    if (r.pose === 'sleep') return 'sleeping';
    if (r.pose === 'sit') return `sitting · ${AREA_LABEL[r.area]}`;
    return AREA_LABEL[r.area];
  }

  /* ------------------------------------------------------------ actions */

  private async act(panel: string, act: string, d: DOMStringMap) {
    if (this.busy && act !== 'color') return;
    this.busy = true;
    try {
      const S = this.host.society;
      switch (act) {
        case 'enrol': { const r = await S.enroll(d.course!); this.host.toast(r.ok ? 'Enrolled! Sit in the classroom to attend your first class 📚' : r.message!); if (r.ok) this.host.store.update((s) => { s.stats.xp += 10; }); await this.renderSchool(); break; }
        case 'exam': { const r = await S.takeExam(d.course!); this.host.toast(r.passed ? `PASSED with ${r.score}% 🎓 Certificate ${r.certificate?.serial ?? ''} issued` : r.ok ? `Scored ${r.score}% — pass mark ${r.pass_mark}%. Attend more classes and try again.` : r.message!, 5000); if (r.passed) { this.host.store.update((s) => { s.stats.xp += 60; s.stats.reputation += 5; }); this.host.award('graduate'); } await this.renderSchool(); break; }
        case 'apply': { const r = await S.govApply(d.pos!); this.host.toast(r.ok ? 'Application submitted. The office verifies your documents next — check back in a few seconds.' : r.message!, 4000); await this.renderGov(true); break; }
        case 'withdraw': { const r = await S.govWithdraw(); this.host.toast(r.ok ? 'File cleared.' : r.message!); this.interview = null; await this.renderGov(true); break; }
        case 'interview': { const r = await S.govInterviewQuestions(); if (!r.ok) { this.host.toast(r.message!); break; } this.interview = r.questions ?? []; await this.renderGov(true); break; }
        case 'answer': {
          const f = document.getElementById('interviewForm') as HTMLFormElement | null; if (!f) break;
          const answers: Record<string, number> = {}; let missing = false;
          for (const q of this.interview ?? []) { const v = (f.elements.namedItem(`q${q.id}`) as RadioNodeList | null)?.value; if (v === undefined || v === '') missing = true; else answers[q.id] = Number(v); }
          if (missing) { this.host.toast('Answer every question.'); break; }
          const r = await S.govAttendInterview(answers);
          this.host.toast(r.passed ? `Interview passed (${r.score}%). The office prepares your offer.` : r.ok ? `Scored ${r.score}% — ${r.rejected ? 'application closed.' : 'you may retry after the office reschedules.'}` : r.message!, 5000);
          this.interview = null; await this.renderGov(true); break;
        }
        case 'offer': { const r = await S.govAcceptOffer(d.accept === '1'); this.host.toast(r.ok ? (d.accept === '1' ? `Offer accepted. Onboarding in progress${r.employee_no ? ` · employee no. ${r.employee_no}` : ''}.` : 'Offer declined.') : r.message!, 4000); if (r.ok && d.accept === '1') { this.host.award('civil-servant'); this.host.store.update((s) => { s.stats.xp += 100; s.stats.reputation += 10; }); } await this.renderGov(true); break; }
        case 'shift': { await this.host.workShift(); await this.renderGov(true); break; }
        case 'resign': { if (!confirm('Resign from your government post? Your employee number is retired.')) break; const r = await S.govResign(); this.host.toast(r.ok ? 'You resigned. The slot is open for the next applicant.' : r.message!); await this.renderGov(true); break; }
        case 'treat': { await this.host.treat(d.id!); this.renderHospital(); break; }
        case 'join': { const r = await S.churchJoin(this.host.churchSlug()); this.host.toast(r.ok ? `Welcome to the family ⛪` : r.message!); await this.renderChurch(true); break; }
        case 'leave': { const r = await S.churchLeave(this.host.churchSlug()); this.host.toast(r.ok ? 'You left the church.' : r.message!); await this.renderChurch(true); break; }
        case 'attend': { await this.host.attendService(Number(d.service)); break; }
        case 'give': {
          const amt = await this.host.ask('Offering', 'Voluntary. Goes straight into the church account through the ledger.', 'Amount in G'); if (!amt) break;
          const n = Number(amt.replace(/[^\d]/g, ''));
          const r = await S.churchOffer(this.host.churchSlug(), n); this.host.toast(r.ok ? `Thank you for your offering of ${fmtG(n)} 🙏` : r.message!); await this.renderChurch(true); break;
        }
        case 'register': {
          const name = await this.host.ask('Register a church', 'Fee 50,000 G to the Treasury. You become the pastor.', 'Church name', false); if (!name) break;
          const desc = await this.host.ask('Describe the church', 'Shown on the notice board to every citizen.', 'Short description', false);
          const r = await S.churchRegister(name, desc ?? ''); this.host.toast(r.ok ? `${name} is registered. Members can now join.` : r.message!, 4000); await this.renderChurch(true); break;
        }
        case 'pay': {
          const who = await this.host.ask('Authorise an expense', 'Username of the citizen or supplier to pay from the church account.', '@username', false); if (!who) break;
          const amt = await this.host.ask('Amount', `Church balance: ${fmtG(this.church?.balance ?? 0)}.`, 'Amount in G'); if (!amt) break;
          const why = await this.host.ask('Reason', 'Recorded in the public expense log.', 'e.g. generator fuel', false); if (!why) break;
          const r = await S.churchPay(this.host.churchSlug(), who.replace(/^@/, ''), Number(amt.replace(/[^\d]/g, '')), why); this.host.toast(r.ok ? 'Expense paid and logged.' : r.message!); await this.renderChurch(true); break;
        }
        case 'salary': {
          const mode = d.mode as 'propose' | 'approve' | 'claim';
          let amount: number | undefined;
          if (mode === 'propose') { const a = await this.host.ask('Propose a weekly salary', 'A member must approve it before it can be claimed.', 'Amount in G'); if (!a) break; amount = Number(a.replace(/[^\d]/g, '')); }
          const r = await S.churchSalary(this.host.churchSlug(), mode, amount); this.host.toast(r.ok ? (mode === 'propose' ? 'Proposal recorded — ask a member to approve it.' : mode === 'approve' ? 'Salary agreement approved.' : 'Salary paid from the church account.') : r.message!); await this.renderChurch(true); break;
        }
        case 'color': { this.pickedColor.set(d.model!, d.color!); await this.renderDealer(); break; }
        case 'buy': { const m = this.models?.find((x) => x.id === d.model); if (!m) break; await this.host.buyVehicle(m.id, this.pickedColor.get(m.id) ?? m.colors[0]); await this.renderDealer(); break; }
        case 'share': { const u = await this.host.ask('Share keys', 'The citizen can drive this vehicle; you stay the owner and can revoke any time.', '@username', false); if (!u) break; const r = await S.shareVehicle(d.vehicle!, u.replace(/^@/, ''), true); this.host.toast(r.ok ? `Keys shared with @${u.replace(/^@/, '')}` : r.message!); await this.renderVehicles(); break; }
        case 'revoke': { const r = await S.shareVehicle(d.vehicle!, d.user!, false); this.host.toast(r.ok ? `Keys taken back from @${d.user}` : r.message!); await this.renderVehicles(); break; }
      }
    } catch (e) { this.fail(e); }
    finally { this.busy = false; void panel; }
  }
}
