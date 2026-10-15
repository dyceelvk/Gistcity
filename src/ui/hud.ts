/**
 * The HUD: DOM overlay on top of the 3D view — wallet, level, objective,
 * minimap, Style Studio, Store, Your Space, Jobs, Life, Rankings, Account,
 * the timing minigame and toasts.
 */
import {
  ACCESSORIES, BEARDS, BODY_TYPES, BOTTOMS, BUILDS, CLOTH_COLORS, FACE_SHAPES, HAIR_COLORS, HAIR_STYLES, LIP_COLORS, SHOE_STYLES, SKIN_TONES, STORE, TOPS,
  applyPreset, itemById, ownsAccessory, ownsBottom, ownsFurniture, ownsTop, type Accessory, type ItemCategory, type Vibe,
} from '../game/appearance';
import { ACHIEVEMENTS, fmtG, levelFor, xpForLevel, type PlayerState, type Store } from '../game/state';
import { JOBS, type JobId } from '../game/jobs';
import type { World, Zone } from '../game/world';
import { level as needLevel, type Needs } from '../game/needs';
import { cloud, type CloudStatus } from '../net/supabase';

/** One entry of the contextual action menu. */
export interface Action { icon: string; label: string; cost?: number; disabled?: string; run: () => void }

export interface HudHost {
  store: Store;
  world: World;
  applyAppearance(): void;
  setPortrait(on: boolean): void;
  player(): { x: number; z: number; yaw: number };
  jobTarget(): { x: number; z: number; label: string } | null;
  activeJob(): JobId | null;
  startJob(id: JobId): void;
  cancelJob(): void;
  isIndoor(): boolean;
  refreshFurniture(): void;
  cycleCamera(): void;
  resetSave(): void;
  remotes(): { x: number; z: number; name: string }[];
  award(id: string): void;
  /** Buy a store item through the economy (server-authorised when online). Resolves true when paid. */
  buy(id: string): Promise<boolean>;
  isCreating(): boolean;
  finishCreation(): Promise<void>;
  wakeUp(): void;
  /** Leave the car (park it where it stands). */
  exitVehicle(): void;
}
export interface PanelRenderer { render(id: string): void; stopTimers(): void }

/** Places on the map that exist in the plan but are not built yet — shown honestly as coming soon. */
export const COMING_SOON = ['🏦 Bank', '🏪 Businesses & property', '🏘️ Housing market', '💍 Marriage & family'];

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => Array.from(document.querySelectorAll(sel)) as T[];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export class Hud {
  private toastTimer = 0;
  private openId: string | null = null;
  private storeTab: ItemCategory = 'top';
  private mini = $<HTMLCanvasElement>('#minimap');
  private big = $<HTMLCanvasElement>('#bigmap');
  private currentZone: Zone | null = null;
  private currentActions: Action[] = [];
  onAction: ((index: number) => void) | null = null;
  /** Society panels (school, government, church, …) render through this hook. */
  panels: PanelRenderer | null = null;
  /** Conversation with an NPC or another player: a choice was picked (index into the choices). */
  onDialogueChoice: ((index: number) => void) | null = null;
  /** The player ended the conversation (button or walking away). */
  onDialogueClose: (() => void) | null = null;
  /** A panel was opened (id) or closed (null) — the game reacts (e.g. changing-room state). */
  onPanel: ((id: string | null) => void) | null = null;

  constructor(private host: HudHost) {
    const s = host.store;
    s.subscribe((st) => this.renderState(st));
    this.renderState(s.state);

    $$('[data-open]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); const tab = b.dataset.tab as ItemCategory | undefined; if (tab) this.storeTab = tab; this.open(b.dataset.open!); }));
    $$('[data-close]').forEach((b) => b.addEventListener('click', () => this.closeAll()));
    $('#styleDone').addEventListener('click', () => { if (host.isCreating()) void host.finishCreation(); else this.closeAll(); });
    $('#camBtn').addEventListener('click', () => host.cycleCamera());
    $('#accountBtn').addEventListener('click', () => this.open('account'));
    $('#wakeBtn').addEventListener('click', () => host.wakeUp());
    $('#driveExit').addEventListener('click', () => host.exitVehicle());
    $('#resetBtn').addEventListener('click', () => { if (confirm('Reset your GIST save on this device? This cannot be undone.')) host.resetSave(); });
    $('#dlgClose').addEventListener('click', () => this.closeDialogue(true));
    $$('#storeTabs button').forEach((b) => b.addEventListener('click', () => { this.storeTab = b.dataset.tab as ItemCategory; this.renderStore(); }));
    const nameInput = $<HTMLInputElement>('#nameInput');
    nameInput.addEventListener('change', () => {
      const v = nameInput.value.trim().slice(0, 24); if (!v) return;
      s.update((st) => { st.name = v; });
      if (cloud.signedIn) cloud.updateProfile({ display_name: v }).catch((e) => this.toast(e?.message ?? 'Could not save name'));
    });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });
    this.renderStatus(cloud.status);
    this.buildStyleControls();
  }
  cloudStatus(st: CloudStatus) { this.renderStatus(st); }

  /* ------------------------------------------------------------ panels */

  open(id: string) {
    this.closeAll(false);
    const el = document.getElementById(`panel-${id}`);
    if (!el) return;
    el.classList.remove('hidden');
    this.openId = id;
    document.body.classList.add('panel-open');
    if (id === 'style') {
      this.host.setPortrait(true);
      this.renderStyle(this.host.store.state);
      // Private changing area: the wardrobe / booth curtains come across while you change.
      if (!this.host.isCreating()) $('#changing').classList.remove('hidden');
    }
    if (id === 'store') this.renderStore();
    if (id === 'home') this.renderHome();
    if (id === 'jobs') this.renderJobs();
    if (id === 'life') this.renderLife(this.host.store.state);
    if (id === 'rank') void this.renderRank();
    if (id === 'map') this.drawBigMap();
    if (id === 'account') this.renderAccount();
    this.panels?.render(id);
    this.onPanel?.(id);
  }
  closeAll(resetCamera = true) {
    if (this.openId === 'style' && this.host.isCreating()) { this.toast('Finish your character first, then tap ENTER GISTCITY'); return; }
    $$('.panel').forEach((p) => p.classList.add('hidden'));
    document.body.classList.remove('panel-open');
    $('#changing').classList.add('hidden');
    this.panels?.stopTimers();
    if (this.openId === 'style' && resetCamera) this.host.setPortrait(false);
    if (this.openId === 'style') this.host.store.update(() => { /* flush name edits */ });
    const was = this.openId;
    this.openId = null;
    if (was) this.onPanel?.(null);
  }
  get isOpen() { return this.openId !== null; }
  toggle(id: string) { if (this.openId === id) this.closeAll(); else this.open(id); }

  toast(msg: string, ms = 2800) {
    const el = $('#toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
  }
  objective(title: string, text: string, job = false, icon = '✦') {
    $('#objTitle').textContent = title; $('#objText').textContent = text; $('#objIcon').textContent = icon;
    $('#objKicker').textContent = job ? 'ACTIVE HUSTLE' : 'YOUR NEXT MOVE';
    $('#objective').classList.toggle('job', job);
  }
  private lastDistrict = '';
  district(name: string) { if (name === this.lastDistrict) return; this.lastDistrict = name; $('#district').textContent = name; }
  setTouch(on: boolean) { document.body.classList.toggle('touch', on); }
  setRun(on: boolean) { $('#runBtn').classList.toggle('on', on); }
  loaded() { const l = $('#loading'); l.classList.add('done'); setTimeout(() => l.remove(), 700); }
  loadMsg(m: string) { const el = document.getElementById('loadMsg'); if (el) el.textContent = m; }

  /** Contextual action menu for the thing the player is next to. Only actions that can really run are listed. */
  actions(z: Zone | null, list: Action[]) {
    this.currentZone = z; this.currentActions = list;
    const menu = $('#actionMenu');
    if (!list.length) { menu.classList.add('hidden'); return; }
    const cash = this.host.store.state.cash;
    $('#actionTitle').textContent = z ? `${z.icon} ${z.label}` : '';
    const wrap = $('#actionList'); wrap.innerHTML = '';
    list.slice(0, 6).forEach((a, i) => {
      const b = document.createElement('button'); b.className = 'action' + (i === 0 ? ' primary' : '') + (a.disabled ? ' off' : '');
      const cost = a.cost !== undefined ? `<em class="${cash < a.cost ? 'no' : ''}">${fmtG(a.cost)}</em>` : '';
      b.innerHTML = `<kbd>${i === 0 ? 'E' : i + 1}</kbd><span class="ic">${a.icon}</span><span class="lb">${esc(a.label)}</span>${cost}`;
      if (a.disabled) b.title = a.disabled;
      b.addEventListener('click', () => this.onAction?.(i));
      wrap.appendChild(b);
    });
    menu.classList.remove('hidden');
  }

  /** Hunger / thirst / energy bars. */
  needs(n: Needs) {
    const set = (id: string, v: number) => { const el = $(id); el.style.width = `${Math.round(v)}%`; el.parentElement!.parentElement!.dataset.level = needLevel(v); el.parentElement!.parentElement!.title = `${Math.round(v)}%`; };
    set('#needHunger', n.hunger); set('#needThirst', n.thirst); set('#needEnergy', n.energy); set('#needHealth', n.health);
    if (this.openId === 'life') this.renderLife(this.host.store.state);
  }
  sleep(on: boolean, energy: number) {
    const el = $('#sleep'); el.classList.toggle('hidden', !on);
    if (on) { $('#sleepEnergy').textContent = `${Math.round(energy)}%`; $('#sleepFill').style.width = `${Math.round(energy)}%`; }
  }
  emote(e: string) { const el = $('#emote'); el.textContent = e; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }

  /* ---------------------------------------------------------- dialogue */

  /** Show a conversation: the other side's line plus real response choices (keys 1–6). */
  showDialogue(name: string, role: string, line: string, choices: { icon: string; label: string; disabled?: string }[]) {
    $('#dlgName').textContent = name;
    $('#dlgRole').textContent = role.toUpperCase();
    $('#dlgAvatar').textContent = name.charAt(0).toUpperCase();
    $('#dlgLine').textContent = line;
    const wrap = $('#dlgChoices');
    wrap.innerHTML = '';
    choices.slice(0, 6).forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'dlgChoice' + (c.disabled ? ' off' : '');
      b.innerHTML = `<kbd>${i + 1}</kbd><span class="ic">${c.icon}</span><span class="lb">${esc(c.label)}</span>`;
      if (c.disabled) b.title = c.disabled;
      b.addEventListener('click', () => this.onDialogueChoice?.(i));
      wrap.appendChild(b);
    });
    $('#dialogue').classList.remove('hidden');
    this.activityChip('Talking', '💬');
  }
  /** Update just the spoken line (after a choice, while keeping the choices). */
  dialogueLine(line: string) { $('#dlgLine').textContent = line; }
  dialogueChoices(choices: { icon: string; label: string; disabled?: string }[]) {
    const wrap = $('#dlgChoices');
    wrap.innerHTML = '';
    choices.slice(0, 6).forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'dlgChoice' + (c.disabled ? ' off' : '');
      b.innerHTML = `<kbd>${i + 1}</kbd><span class="ic">${c.icon}</span><span class="lb">${esc(c.label)}</span>`;
      b.addEventListener('click', () => this.onDialogueChoice?.(i));
      wrap.appendChild(b);
    });
  }
  get dialogueOpen() { return !$('#dialogue').classList.contains('hidden'); }
  closeDialogue(notify = true) {
    if (!this.dialogueOpen) return;
    $('#dialogue').classList.add('hidden');
    if (notify) this.onDialogueClose?.();
    else this.activityChipClear();
  }
  /** Number keys 1–6 pick a dialogue choice while a conversation is open. */
  pickDialogue(index: number) {
    if (!this.dialogueOpen) return false;
    const btns = $$('#dlgChoices .dlgChoice');
    const b = btns[index];
    if (b && !b.classList.contains('off')) { b.click(); return true; }
    return true; // conversation open: swallow the key
  }

  /** Small chip above the needs showing what the character is doing right now. */
  activityChip(text: string, icon = '💬') {
    if (!text) { this.activityChipClear(); return; }
    $('#actChipIcon').textContent = icon;
    $('#actChipText').textContent = text;
    $('#actChip').classList.remove('hidden');
  }
  activityChipClear() { $('#actChip').classList.add('hidden'); }
  /** Shared city clock (top bar). */
  clock(text: string, night: boolean) { const el = $('#clock'); if (el.textContent !== text) el.textContent = text; document.body.classList.toggle('night', night); }
  /** Driving overlay: speed + park button. */
  drive(on: boolean, kmh = 0, name = '') {
    const el = $('#driveHud'); el.classList.toggle('hidden', !on); document.body.classList.toggle('driving', on);
    if (on) { $('#driveSpeed').textContent = String(Math.round(kmh)); if (name) $('#driveName').textContent = name; }
  }

  /** Small modal input (amounts, notes). Resolves null when cancelled. */
  ask(title: string, hint: string, placeholder: string, numeric = true): Promise<string | null> {
    const root = $('#ask'), input = $<HTMLInputElement>('#askInput'), ok = $('#askOk'), cancel = $('#askCancel');
    $('#askTitle').textContent = title; $('#askHint').textContent = hint; input.value = ''; input.placeholder = placeholder; input.inputMode = numeric ? 'numeric' : 'text';
    root.classList.remove('hidden'); setTimeout(() => input.focus(), 50);
    return new Promise((resolve) => {
      const done = (v: string | null) => { root.classList.add('hidden'); ok.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel); input.removeEventListener('keydown', onKey); resolve(v); };
      const onOk = () => done(input.value.trim() || null), onCancel = () => done(null);
      const onKey = (e: KeyboardEvent) => { e.stopPropagation(); if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
      ok.addEventListener('click', onOk); cancel.addEventListener('click', onCancel); input.addEventListener('keydown', onKey);
    });
  }

  /** Public profile card of another citizen. */
  async showProfile(id: string, fallbackName: string) {
    const body = $('#profileBody');
    body.innerHTML = `<p class="muted">Loading ${esc(fallbackName)}…</p>`;
    this.open('profile');
    try {
      const p = await cloud.publicProfile(id);
      if (!p) { body.innerHTML = `<p class="muted">${esc(fallbackName)} has no public profile yet.</p>`; return; }
      body.innerHTML = `<div class="profileHead"><div class="avatarBig">${esc(p.display_name.charAt(0).toUpperCase())}</div><div><strong>${esc(p.display_name)}</strong><small>@${esc(p.username)}</small></div></div>
        ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : '<p class="muted">No bio yet.</p>'}
        <div class="kv"><span>Citizen since</span><span>${new Date(p.created_at).toLocaleDateString()}</span></div>
        <div class="kv"><span>Level</span><span>${p.level ?? 1}</span></div>
        <div class="kv"><span>Popularity</span><span>${p.popularity ?? 0}</span></div>
        <p class="muted" style="margin-top:12px">Friends, messages and posts are coming in the next phase.</p>`;
    } catch (e: any) { body.innerHTML = `<p class="muted">${esc(e?.message ?? 'Could not load profile')}</p>`; }
  }

  /* ---------------------------------------------------------- top bar */

  private renderState(st: PlayerState) {
    $('#cash').textContent = fmtG(st.cash);
    const lvl = levelFor(st.stats.xp), lo = xpForLevel(lvl), hi = xpForLevel(lvl + 1);
    $('#levelNum').textContent = String(lvl);
    $('#xpFill').style.width = `${Math.round(((st.stats.xp - lo) / (hi - lo)) * 100)}%`;
    $('#playerName').textContent = st.name;
    $('#playerVibe').textContent = `${st.appearance.vibe.toUpperCase()} VIBE`;
    $('#avatarMini').textContent = st.name.trim().charAt(0).toUpperCase() || 'G';
    $('#avatarMini').style.background = st.appearance.topColor;
    if (this.openId === 'style') this.renderStyle(st);
    if (this.openId === 'store') this.renderStore();
    if (this.openId === 'home') this.renderHome();
    if (this.openId === 'life') this.renderLife(st);
    if (this.openId === 'jobs') this.renderJobs();
  }
  private renderStatus(st: CloudStatus) {
    const dot = $('#statusDot'), txt = $('#statusText');
    dot.className = 'dot';
    const map: Record<CloudStatus, [string, string]> = {
      offline: ['', 'Practice · offline'], connecting: ['warn', 'Connecting'], guest: ['warn', 'Signed out'],
      'signed-in': ['ok', this.host.store.state.username ? '@' + this.host.store.state.username : (cloud.email || 'Online')], error: ['bad', 'Config error'],
    };
    const [cls, label] = map[st];
    if (cls) dot.classList.add(cls);
    txt.textContent = label;
    if (this.openId === 'account') this.renderAccount();
  }

  /* ------------------------------------------------------ style studio */

  private buildStyleControls() {
    const s = this.host.store;
    const mk = (parent: HTMLElement, label: string, on: () => void, cls = '') => {
      const b = document.createElement('button'); b.innerHTML = label; b.className = cls; b.addEventListener('click', on); parent.appendChild(b); return b;
    };
    const vibes: Exclude<Vibe, 'Custom'>[] = ['Casual', 'Street', 'Baddie', 'Luxury', 'Corporate'];
    const vc = $('#vibeChips'); vibes.forEach((v) => mk(vc, v, () => { s.update((st) => { st.appearance = applyPreset(st.appearance, v, st.inventory); }); this.host.applyAppearance(); }).dataset.v = v);
    const sw = (parent: HTMLElement, colors: (string | null)[], on: (c: string | null) => void) => colors.forEach((c) => {
      const b = document.createElement('button'); if (c) b.style.background = c; else b.classList.add('none'); b.dataset.c = c ?? 'none'; b.title = c ?? 'Natural';
      b.addEventListener('click', () => on(c)); parent.appendChild(b);
    });
    const up = (fn: (a: PlayerState['appearance']) => void) => { s.update((st) => { fn(st.appearance); st.appearance.vibe = 'Custom'; }); this.host.applyAppearance(); };
    sw($('#skinSwatches'), SKIN_TONES, (c) => up((a) => { a.skin = c!; }));
    sw($('#hairColors'), HAIR_COLORS, (c) => up((a) => { a.hairColor = c!; }));
    sw($('#lipSwatches'), LIP_COLORS, (c) => up((a) => { a.lips = c; }));
    sw($('#topColors'), CLOTH_COLORS, (c) => up((a) => { a.topColor = c!; }));
    sw($('#bottomColors'), CLOTH_COLORS, (c) => up((a) => { a.bottomColor = c!; }));
    sw($('#shoeColors'), CLOTH_COLORS, (c) => up((a) => { a.shoesColor = c!; }));
    BUILDS.forEach((b) => mk($('#buildChips'), b.label, () => up((a) => { a.build = b.id; })).dataset.v = b.id);
    BODY_TYPES.forEach((b) => mk($('#bodyChips'), b.label, () => up((a) => { a.body = b.id; })).dataset.v = b.id);
    SHOE_STYLES.forEach((sh) => mk($('#shoeChips'), sh.label, () => up((a) => { a.shoes = sh.id; })).dataset.v = sh.id);
    FACE_SHAPES.forEach((f) => mk($('#faceChips'), f.label, () => up((a) => { a.face = f.id; })).dataset.v = f.id);
    HAIR_STYLES.forEach((h) => mk($('#hairChips'), h.label, () => up((a) => { a.hair = h.id; })).dataset.v = h.id);
    BEARDS.forEach((b) => mk($('#beardChips'), b.label, () => up((a) => { a.beard = b.id; })).dataset.v = b.id);
    TOPS.forEach((t) => mk($('#topChips'), t.label, () => {
      if (!ownsTop(s.state.inventory, t.id)) { this.storeTab = 'top'; this.open('store'); this.toast(`Buy a ${t.label.toLowerCase()} at GIST Fits first`); return; }
      up((a) => { a.top = t.id; });
    }).dataset.v = t.id);
    BOTTOMS.forEach((b) => mk($('#bottomChips'), b.label, () => {
      if (!ownsBottom(s.state.inventory, b.id)) { this.storeTab = 'top'; this.open('store'); this.toast(`Buy a ${b.label.toLowerCase()} at GIST Fits first`); return; }
      up((a) => { a.bottom = b.id; });
    }).dataset.v = b.id);
    ACCESSORIES.forEach((ac) => mk($('#accChips'), ac.label, () => {
      if (!ownsAccessory(s.state.inventory, ac.id)) { this.storeTab = 'accessory'; this.open('store'); this.toast(`${ac.label} is in the accessories section`); return; }
      up((a) => { a.accessories = a.accessories.includes(ac.id) ? a.accessories.filter((x) => x !== ac.id) : [...a.accessories, ac.id]; });
    }).dataset.v = ac.id);
  }

  private renderStyle(st: PlayerState) {
    const a = st.appearance, inv = st.inventory;
    $('#styleDone').textContent = this.host.isCreating() ? 'ENTER GISTCITY →' : 'DONE';
    $('#styleKicker').textContent = this.host.isCreating() ? 'CREATE YOUR CHARACTER · this is how everyone will see you' : 'STYLE STUDIO';
    const nameInput = $<HTMLInputElement>('#nameInput');
    if (document.activeElement !== nameInput) nameInput.value = st.name;
    const mark = (sel: string, val: string) => $$(sel + ' button').forEach((b) => b.classList.toggle('on', b.dataset.v === val));
    const markC = (sel: string, val: string | null) => $$(sel + ' button').forEach((b) => b.classList.toggle('on', b.dataset.c === (val ?? 'none')));
    mark('#vibeChips', a.vibe); mark('#buildChips', a.build ?? 'masculine'); mark('#bodyChips', a.body ?? 'regular'); mark('#shoeChips', a.shoes ?? 'sneaker'); mark('#faceChips', a.face); mark('#hairChips', a.hair); mark('#beardChips', a.beard);
    mark('#topChips', a.top); mark('#bottomChips', a.bottom);
    markC('#skinSwatches', a.skin); markC('#hairColors', a.hairColor); markC('#lipSwatches', a.lips);
    markC('#topColors', a.topColor); markC('#bottomColors', a.bottomColor); markC('#shoeColors', a.shoesColor);
    $$('#accChips button').forEach((b) => b.classList.toggle('on', a.accessories.includes(b.dataset.v as Accessory)));
    const lock = (sel: string, owned: (id: string) => boolean, priceOf: (id: string) => number | undefined) => $$(sel + ' button').forEach((b) => {
      const id = b.dataset.v!; const ok = owned(id);
      b.classList.toggle('locked', !ok);
      const base = b.textContent!.replace(/\s*🔒.*$/, '');
      b.innerHTML = ok ? esc(base) : `${esc(base)} <i>🔒 ${fmtG(priceOf(id) ?? 0)}</i>`;
    });
    lock('#topChips', (id) => ownsTop(inv, id as any), (id) => STORE.find((i) => i.unlock.top === id)?.price);
    lock('#bottomChips', (id) => ownsBottom(inv, id as any), (id) => STORE.find((i) => i.unlock.bottom === id)?.price);
    lock('#accChips', (id) => ownsAccessory(inv, id as any), (id) => STORE.find((i) => i.unlock.accessory === id)?.price);
  }

  /* ---------------------------------------------------------------- store */

  private renderStore() {
    const s = this.host.store, st = s.state;
    $$('#storeTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === this.storeTab));
    const cat = this.storeTab;
    const items = STORE.filter((i) => (cat === 'top' ? i.category === 'top' || i.category === 'bottom' : i.category === cat));
    const wrap = $('#storeCards'); wrap.innerHTML = '';
    for (const it of items) {
      const owned = st.inventory.includes(it.id);
      const equipped = (it.unlock.top && st.appearance.top === it.unlock.top) || (it.unlock.bottom && st.appearance.bottom === it.unlock.bottom) || (it.unlock.accessory && st.appearance.accessories.includes(it.unlock.accessory)) || (it.unlock.furniture && st.apartment.includes(it.unlock.furniture));
      const icon = it.category === 'top' ? '👕' : it.category === 'bottom' ? '👖' : it.category === 'accessory' ? '🕶️' : '🛋️';
      const card = document.createElement('div'); card.className = 'card';
      card.innerHTML = `<div class="icon" style="${it.color ? `background:${it.color}22;border:1px solid ${it.color}66` : ''}">${icon}</div><div class="body"><strong>${esc(it.name)}</strong><p>${esc(it.desc)}</p><div class="price">${owned ? 'OWNED' : fmtG(it.price)}</div></div>`;
      const btn = document.createElement('button'); btn.className = 'btn';
      if (!owned) { btn.textContent = 'BUY'; btn.disabled = st.cash < it.price; btn.addEventListener('click', () => this.buy(it.id)); }
      else if (it.category === 'furniture') { btn.textContent = equipped ? 'PLACED' : 'PLACE'; btn.classList.toggle('owned', !!equipped); btn.addEventListener('click', () => this.toggleFurniture(it.unlock.furniture!)); }
      else { btn.textContent = equipped ? 'WEARING' : 'WEAR'; btn.classList.toggle('owned', !!equipped); btn.addEventListener('click', () => this.equip(it.id)); }
      card.appendChild(btn); wrap.appendChild(card);
    }
  }
  private buying = false;
  private async buy(id: string) {
    const it = itemById(id); if (!it || this.buying) return;
    const s = this.host.store;
    if (s.state.cash < it.price) { this.toast(`You need ${fmtG(it.price)} for that. Go hustle small!`); return; }
    this.buying = true;
    const paid = await this.host.buy(id);
    this.buying = false;
    if (!paid) { this.renderStore(); return; }
    s.update((st) => { if (it.unlock.furniture && !st.apartment.includes(it.unlock.furniture)) st.apartment.push(it.unlock.furniture); });
    if (it.category === 'furniture') { this.host.refreshFurniture(); this.host.award('homeowner'); this.toast(`${it.name} delivered to your flat 🛋️`); }
    else { this.equip(id); this.host.award('first-fit'); this.toast(`Fresh! You bought ${it.name} 💚`); }
  }
  private equip(id: string) {
    const it = itemById(id); if (!it) return;
    this.host.store.update((st) => {
      const a = st.appearance;
      if (it.unlock.top) { a.top = it.unlock.top; if (it.color) a.topColor = it.color; }
      if (it.unlock.bottom) { a.bottom = it.unlock.bottom; if (it.color) a.bottomColor = it.color; }
      if (it.unlock.accessory && !a.accessories.includes(it.unlock.accessory)) a.accessories.push(it.unlock.accessory);
      a.vibe = 'Custom';
    });
    this.host.applyAppearance();
  }
  private toggleFurniture(f: string) {
    this.host.store.update((st) => { st.apartment = st.apartment.includes(f) ? st.apartment.filter((x) => x !== f) : [...st.apartment, f]; });
    this.host.refreshFurniture();
  }

  /* ----------------------------------------------------------------- home */

  private renderHome() {
    const st = this.host.store.state;
    const wrap = $('#homeCards'); wrap.innerHTML = '';
    const owned = STORE.filter((i) => i.category === 'furniture' && ownsFurniture(st.inventory, i.unlock.furniture!));
    if (!owned.length) { wrap.innerHTML = `<div class="card"><div class="icon">🪑</div><div class="body"><strong>Empty flat energy</strong><p>Buy furniture at GIST Fits (Home tab) and it appears here instantly.</p></div></div>`; return; }
    for (const it of owned) {
      const placed = st.apartment.includes(it.unlock.furniture!);
      const card = document.createElement('div'); card.className = 'card';
      card.innerHTML = `<div class="icon">🛋️</div><div class="body"><strong>${esc(it.name)}</strong><p>${esc(it.desc)}</p></div>`;
      const btn = document.createElement('button'); btn.className = 'btn' + (placed ? '' : ' off'); btn.textContent = placed ? 'PLACED' : 'IN STORAGE';
      btn.addEventListener('click', () => this.toggleFurniture(it.unlock.furniture!));
      card.appendChild(btn); wrap.appendChild(card);
    }
  }

  /* ----------------------------------------------------------------- jobs */

  private renderJobs() {
    const active = this.host.activeJob();
    const act = $('#jobActive');
    act.innerHTML = active ? `<div class="card active"><div class="icon">⏱️</div><div class="body"><strong>Active: ${esc(JOBS.find((j) => j.id === active)!.title)}</strong><p>Follow the objective card. Starting another hustle cancels this one.</p></div><button class="btn off" id="cancelJob">CANCEL</button></div>` : '';
    act.querySelector('#cancelJob')?.addEventListener('click', () => { this.host.cancelJob(); this.renderJobs(); });
    const wrap = $('#jobCards'); wrap.innerHTML = '';
    for (const j of JOBS) {
      const card = document.createElement('div'); card.className = 'card';
      card.innerHTML = `<div class="icon">${j.icon}</div><div class="body"><strong>${esc(j.title)}</strong><p>${esc(j.desc)}</p><div class="price">${esc(j.pay)}</div></div>`;
      const btn = document.createElement('button'); btn.className = 'btn'; btn.textContent = active === j.id ? 'ACTIVE' : 'START';
      btn.disabled = active === j.id || this.host.isIndoor();
      btn.addEventListener('click', () => { this.host.startJob(j.id); this.closeAll(); });
      card.appendChild(btn); wrap.appendChild(card);
    }
    if (this.host.isIndoor()) wrap.insertAdjacentHTML('afterbegin', `<p class="muted">Step outside to start a hustle.</p>`);
  }

  /* ----------------------------------------------------------------- life */

  private renderLife(st: PlayerState) {
    $('#lifeName').textContent = st.username ? `${st.name} · @${st.username}` : st.name;
    const lvl = levelFor(st.stats.xp), lo = xpForLevel(lvl), hi = xpForLevel(lvl + 1);
    const bar = (v: number, max: number) => `<i><b style="width:${Math.min(100, Math.round((v / max) * 100))}%"></b></i>`;
    $('#statGrid').innerHTML = [
      ['LEVEL', `${lvl}`, bar(st.stats.xp - lo, hi - lo)],
      ['WALLET', fmtG(st.cash), ''],
      ['HUNGER', `${Math.round(st.needs.hunger)}%`, bar(st.needs.hunger, 100)],
      ['THIRST', `${Math.round(st.needs.thirst)}%`, bar(st.needs.thirst, 100)],
      ['ENERGY', `${Math.round(st.needs.energy)}%`, bar(st.needs.energy, 100)],
      ['POPULARITY', `${st.stats.popularity}`, bar(st.stats.popularity, 100)],
      ['REPUTATION', `${st.stats.reputation}`, bar(st.stats.reputation, 100)],
      ['HUSTLE', `${st.stats.hustle}`, bar(st.stats.hustle, 50)],
      ['JOBS DONE', `${st.jobsDone}`, ''],
      ['VIBE', st.appearance.vibe, ''],
      ['WARDROBE', `${st.inventory.filter((i) => itemById(i)?.category !== 'furniture').length} pieces`, ''],
    ].map(([k, v, b]) => `<div class="stat"><small>${k}</small><strong>${esc(v)}</strong>${b}</div>`).join('');
    $('#achievements').innerHTML = Object.entries(ACHIEVEMENTS).map(([id, a]) => `<div class="ach ${st.achievements.includes(id) ? 'on' : ''}"><strong>${st.achievements.includes(id) ? '🏅 ' : '🔒 '}${esc(a.title)}</strong><small>${esc(a.desc)}</small></div>`).join('');
  }

  /* ------------------------------------------------------------- rankings */

  private async renderRank() {
    const st = this.host.store.state;
    const body = $('#rankBody'), note = $('#rankNote');
    const me = { name: st.name, popularity: st.stats.popularity, level: levelFor(st.stats.xp), cash: st.cash, you: true };
    let rows = cloud.status === 'signed-in' ? await cloud.leaderboard() : [];
    if (rows.length) { note.textContent = 'Live board · top GistCitizens by popularity.'; if (!rows.some((r) => r.you)) rows.push(me); }
    else {
      note.textContent = cloud.enabled ? 'Sign in to join the live leaderboard. Showing the neighbourhood board.' : 'Offline mode · neighbourhood board (NPCs). Connect Supabase for the live global board.';
      rows = [me, { name: 'Tunde (NPC)', popularity: 42, level: 5, cash: 18400 }, { name: 'Chioma (NPC)', popularity: 37, level: 4, cash: 25100 }, { name: 'Emeka (NPC)', popularity: 25, level: 3, cash: 9000 }, { name: 'Aisha (NPC)', popularity: 12, level: 2, cash: 6200 }];
    }
    rows.sort((a, b) => b.popularity - a.popularity || b.level - a.level || b.cash - a.cash);
    body.innerHTML = rows.map((r, i) => `<tr class="${r.you ? 'you' : ''}"><td>${i + 1}</td><td>${esc(r.name)}${r.you ? ' (you)' : ''}</td><td>${r.popularity}</td><td>${r.level}</td><td>${fmtG(r.cash)}</td></tr>`).join('');
  }

  /* -------------------------------------------------------------- account */

  private renderAccount() {
    const el = $('#accountBody');
    el.innerHTML = '';
    if (!cloud.enabled) {
      el.innerHTML = `<div class="kv"><span>Mode</span><span>Practice · saved on this device</span></div><p class="muted" style="margin-top:12px">Accounts, the shared city, the live leaderboard and the real G economy switch on when the app is built with <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> (see README). Your character and practice balance are saved locally only.</p>`;
      return;
    }
    if (cloud.status === 'error') { el.innerHTML = `<div class="kv"><span>Mode</span><span style="color:var(--danger)">${esc(cloud.error)}</span></div>`; return; }
    const st = this.host.store.state;
    el.innerHTML = `<div class="kv"><span>Username</span><span>@${esc(st.username || '—')}</span></div>
      <div class="kv"><span>Display name</span><span>${esc(st.name)}</span></div>
      <div class="kv"><span>Email</span><span>${esc(cloud.email)} ${cloud.emailVerified ? '· verified ✓' : '· not verified'}</span></div>
      <div class="kv"><span>Wallet</span><span>${fmtG(st.cash)}</span></div>
      <div class="kv"><span>Cloud save</span><span>On · syncs automatically</span></div>`;
    if (!cloud.emailVerified) {
      const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Verify your email to protect your account and enable password reset.'; el.appendChild(p);
      const b = document.createElement('button'); b.className = 'ghost'; b.textContent = 'Resend verification email';
      b.addEventListener('click', async () => { b.disabled = true; try { await cloud.resendVerification(cloud.email); this.toast('Verification email sent ✉️'); } catch (e: any) { this.toast(e?.message ?? 'Could not send'); } b.disabled = false; });
      el.appendChild(b);
    }
    const pw = document.createElement('div');
    pw.innerHTML = `<p class="muted" style="margin-top:14px">Change password</p><div class="accountRow"><input type="password" placeholder="New password (8+ characters)" autocomplete="new-password" /><button>UPDATE</button></div>`;
    const input = pw.querySelector('input')!, btn = pw.querySelector('button')!;
    btn.addEventListener('click', async () => {
      if (input.value.length < 8) { this.toast('Use at least 8 characters'); return; }
      btn.disabled = true;
      try { await cloud.updatePassword(input.value); input.value = ''; this.toast('Password updated 🔒'); } catch (e: any) { this.toast(e?.message ?? 'Could not update password'); }
      btn.disabled = false;
    });
    el.appendChild(pw);
    const legal = document.createElement('p'); legal.className = 'muted'; legal.style.marginTop = '14px';
    legal.innerHTML = `<a href="terms.html" target="_blank" rel="noopener">Terms of use</a> · <a href="privacy.html" target="_blank" rel="noopener">Privacy</a>`;
    el.appendChild(legal);
    const out = document.createElement('button'); out.className = 'ghost'; out.textContent = 'Sign out';
    out.addEventListener('click', async () => { out.disabled = true; cloud.leaveCity(); await cloud.signOut(); location.reload(); });
    el.appendChild(out);
  }

  /* -------------------------------------------------------------- minigame */

  timing(rounds: number, title: string, okText: string, failText: string): Promise<number> {
    const root = $('#minigame'), needle = $('#mgNeedle'), zone = $('#mgZone'), res = $('#mgResult'), tap = $<HTMLButtonElement>('#mgTap'), kicker = $('#mgKicker');
    $('#mgTitle').textContent = title;
    root.classList.remove('hidden');
    return new Promise((resolve) => {
      let round = 0, score = 0, pos = 0, dir = 1, speed = 0.9, raf = 0, last = performance.now(), zoneL = 0.4, zoneW = 0.2, waiting = false;
      const setup = () => {
        round++; kicker.textContent = `ROUND ${round} / ${rounds}`; res.innerHTML = '&nbsp;';
        zoneW = Math.max(0.1, 0.22 - round * 0.02); zoneL = 0.15 + Math.random() * (0.7 - zoneW); speed = 0.8 + round * 0.18;
        zone.style.left = `${zoneL * 100}%`; zone.style.width = `${zoneW * 100}%`;
        pos = 0; dir = 1; waiting = false; tap.disabled = false;
      };
      const tick = (now: number) => {
        const dt = Math.min(0.05, (now - last) / 1000); last = now;
        if (!waiting) { pos += dir * speed * dt; if (pos > 1) { pos = 1; dir = -1; } if (pos < 0) { pos = 0; dir = 1; } }
        needle.style.left = `calc(${pos * 100}% - 3px)`;
        raf = requestAnimationFrame(tick);
      };
      const onTap = () => {
        if (waiting) return;
        waiting = true; tap.disabled = true;
        const hit = pos >= zoneL && pos <= zoneL + zoneW;
        if (hit) score++;
        res.textContent = hit ? okText : failText;
        res.style.color = hit ? 'var(--lime)' : 'var(--danger)';
        setTimeout(() => { if (round >= rounds) finish(); else setup(); }, 750);
      };
      const key = (e: KeyboardEvent) => { if (e.key === ' ' || e.key.toLowerCase() === 'e' || e.key === 'Enter') { e.preventDefault(); onTap(); } };
      const finish = () => { cancelAnimationFrame(raf); tap.removeEventListener('click', onTap); window.removeEventListener('keydown', key, true); root.classList.add('hidden'); resolve(score); };
      tap.addEventListener('click', onTap); window.addEventListener('keydown', key, true);
      setup(); raf = requestAnimationFrame(tick);
    });
  }

  /* ----------------------------------------------------------------- maps */

  drawMinimap() {
    const c = this.mini, g = c.getContext('2d'); if (!g) return;
    const w = c.width, h = c.height, p = this.host.player();
    const range = 46, s = w / (range * 2);
    g.clearRect(0, 0, w, h);
    g.save();
    g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 2, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#1b2a1f'; g.fillRect(0, 0, w, h);
    if (this.host.isIndoor()) {
      // simple floor plan of the flat
      const rs = w / 16;
      g.translate(w / 2 - p.x * rs, h / 2 - p.z * rs);
      g.fillStyle = '#d9d2c3'; g.fillRect(-5.5 * rs, -4.5 * rs, 11 * rs, 9 * rs);
      g.strokeStyle = '#6b4a2b'; g.lineWidth = 3; g.strokeRect(-5.5 * rs, -4.5 * rs, 11 * rs, 9 * rs);
      g.font = '12px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('🚪', 0, 4.3 * rs); g.fillText('👗', -4.4 * rs, -3.2 * rs); g.fillText('🛋️', 0.5 * rs, -1.2 * rs); g.fillText('🛏️', -2.0 * rs, -3.3 * rs);
      g.restore();
      g.save(); g.translate(w / 2, h / 2); g.rotate(Math.PI - p.yaw);
      g.fillStyle = '#a5ff38'; g.beginPath(); g.moveTo(0, -7); g.lineTo(5, 6); g.lineTo(0, 3); g.lineTo(-5, 6); g.closePath(); g.fill(); g.restore();
      return;
    }
    g.translate(w / 2 - p.x * s, h / 2 - p.z * s);
    this.paintCity(g, s, false);
    const tgt = this.host.jobTarget();
    if (tgt) { g.fillStyle = '#f5c242'; g.beginPath(); g.arc(tgt.x * s, tgt.z * s, 4, 0, Math.PI * 2); g.fill(); }
    for (const r of this.host.remotes()) { g.fillStyle = '#5ad1ff'; g.beginPath(); g.arc(r.x * s, r.z * s, 3, 0, Math.PI * 2); g.fill(); }
    g.restore();
    // player arrow (north-up map; yaw 0 faces +z which is "down")
    g.save(); g.translate(w / 2, h / 2); g.rotate(Math.PI - p.yaw);
    g.fillStyle = '#a5ff38'; g.beginPath(); g.moveTo(0, -7); g.lineTo(5, 6); g.lineTo(0, 3); g.lineTo(-5, 6); g.closePath(); g.fill(); g.restore();
    if (tgt) { // edge arrow towards the target when it's off-map
      const dx = tgt.x - p.x, dz = tgt.z - p.z, d = Math.hypot(dx, dz);
      if (d * s > w / 2 - 10) { const a = Math.atan2(dz, dx); g.save(); g.translate(w / 2 + Math.cos(a) * (w / 2 - 10), h / 2 + Math.sin(a) * (h / 2 - 10)); g.rotate(a); g.fillStyle = '#f5c242'; g.beginPath(); g.moveTo(6, 0); g.lineTo(-4, -5); g.lineTo(-4, 5); g.closePath(); g.fill(); g.restore(); }
    }
  }
  drawBigMap() {
    const c = this.big, g = c.getContext('2d'); if (!g) return;
    const w = c.width, p = this.host.player();
    const s = w / 170;
    g.fillStyle = '#1b2a1f'; g.fillRect(0, 0, w, w);
    g.save(); g.translate(w / 2, w / 2);
    this.paintCity(g, s, true);
    const tgt = this.host.jobTarget();
    if (tgt) { g.fillStyle = '#f5c242'; g.beginPath(); g.arc(tgt.x * s, tgt.z * s, 7, 0, Math.PI * 2); g.fill(); g.fillStyle = '#fff'; g.font = 'bold 12px sans-serif'; g.fillText(tgt.label, tgt.x * s + 10, tgt.z * s + 4); }
    for (const r of this.host.remotes()) { g.fillStyle = '#5ad1ff'; g.beginPath(); g.arc(r.x * s, r.z * s, 5, 0, Math.PI * 2); g.fill(); g.fillStyle = '#cfefff'; g.font = '11px sans-serif'; g.fillText(r.name, r.x * s + 8, r.z * s + 4); }
    g.save(); g.translate(p.x * s, p.z * s); g.rotate(Math.PI - p.yaw); g.fillStyle = '#a5ff38'; g.beginPath(); g.moveTo(0, -10); g.lineTo(7, 8); g.lineTo(0, 4); g.lineTo(-7, 8); g.closePath(); g.fill(); g.restore();
    g.restore();
    const seen = new Set<string>();
    const places = this.host.world.zones.filter((z) => z.id !== 'seat' && !seen.has(z.label) && seen.add(z.label));
    $('#mapLegend').innerHTML = places.map((z) => `<span>${z.icon} ${esc(z.label)}</span>`).join('') + `<span>🪑 Benches</span><span>🟢 you</span><span>🟡 hustle target</span><span>🔵 other players</span>` + COMING_SOON.map((c) => `<span class="soon">${c} · coming soon</span>`).join('');
  }
  private paintCity(g: CanvasRenderingContext2D, s: number, labels: boolean) {
    const world = this.host.world;
    g.fillStyle = '#3a4a3c';
    for (const r of world.roads) g.fillRect((r.x - r.w / 2) * s, (r.z - r.d / 2) * s, r.w * s, r.d * s);
    g.fillStyle = '#6f9d5a'; g.beginPath(); g.arc(0, 0, 7 * s, 0, Math.PI * 2); g.fill();
    for (const l of world.landmarks) { g.fillStyle = l.color; g.globalAlpha = 0.85; g.fillRect((l.x - l.w / 2) * s, (l.z - l.d / 2) * s, l.w * s, l.d * s); }
    g.globalAlpha = 1;
    if (labels) { g.fillStyle = '#0b0e0c'; g.font = `bold ${Math.max(9, 3 * s)}px sans-serif`; g.textAlign = 'center'; for (const l of world.landmarks) if (l.label) g.fillText(l.label, l.x * s, l.z * s + 3); g.textAlign = 'left'; }
    g.font = `${labels ? 16 : 11}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const z of world.zones) { if (z.id === 'seat' && !labels) continue; g.fillStyle = '#0b0e0ccc'; g.beginPath(); g.arc(z.x * s, z.z * s, labels ? (z.id === 'seat' ? 8 : 12) : 7, 0, Math.PI * 2); g.fill(); g.fillText(z.icon, z.x * s, z.z * s + 1); }
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  }
}
