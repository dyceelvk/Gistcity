/**
 * The game: renderer, world, player controller, contextual interactions,
 * needs, furniture use (sit / sleep), jobs, NPCs, apartment, the G economy,
 * cloud sync, other players and the HUD glue.
 */
import * as THREE from 'three';
import { makeCharacter, type Character, type Pose } from './character';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CameraRig } from './camera';
import { Input } from './input';
import { resolveCircle } from './physics';
import { buildWorld, buildSky, type World, type Zone, type Seat } from './world';
import { buildInterior, BED_SPOT, type Interior } from './interior';
import { NpcManager, GIST_LINES } from './npc';
import { JobSystem, makeMarker, animateMarker, type JobId } from './jobs';
import { Store, defaultState, ACHIEVEMENTS, fmtG, type PlayerState } from './state';
import { CONSUMABLES, type Consumable } from './catalog';
import * as needs from './needs';
import { Hud, type HudHost, type Action } from '../ui/hud';
import { cloud, type RemoteState } from '../net/supabase';
import { Economy } from '../net/economy';
import { makeSprite } from './props';

const WALK = 3.3, RUN = 6.4, RADIUS = 0.38;

interface Remote { avatar: Character; state: RemoteState; tag: THREE.Sprite; appearanceKey: string; bubble?: THREE.Sprite; bubbleUntil?: number }

export interface Boot {
  state: PlayerState;
  /** The player must finish character creation before playing (first sign-in). */
  needsCharacter: boolean;
}

export class Game implements HudHost {
  store: Store;
  world: World;
  interior: Interior;
  economy: Economy;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private rig: CameraRig;
  private input: Input;
  private hud: Hud;
  private clock = new THREE.Clock();
  private avatar: Character;
  private npcs: NpcManager;
  private jobs: JobSystem;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private markers = new THREE.Group();
  private jobLayer = new THREE.Group();
  private indoor = false;
  private velocity = new THREE.Vector3();
  private yaw = Math.PI;
  private currentZone: Zone | null = null;
  private currentActions: Action[] = [];
  private walked = 0;
  private greeted = new Set<string>();
  private remotesMap = new Map<string, Remote>();
  private remoteLayer = new THREE.Group();
  private miniTimer = 0;
  private camPreset = 1;
  private lastPresence = '';
  private busy = false;
  // furniture use
  private seated: Seat | null = null;
  private sleeping: { bedTop: number } | null = null;
  private rootY = 0;
  private needsTimer = 0;
  private creating = false;

  constructor(host: HTMLElement, boot: Boot) {
    this.store = new Store(boot.state);
    this.economy = new Economy(this.store);
    this.store.state.needs = needs.catchUp(this.store.state.needs);

    const touch = matchMedia('(pointer: coarse)').matches;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, touch ? 1.5 : 1.75));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 500);
    this.rig = new CameraRig(this.camera);

    // lights
    this.hemi = new THREE.HemisphereLight('#dff1ff', '#5c6b4e', 1.15);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#ffe2b8', 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(touch ? 1024 : 2048, touch ? 1024 : 2048);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 160;
    this.sun.shadow.bias = -0.0006; this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    this.scene.fog = new THREE.Fog('#e9dcc3', 70, 200);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    pmrem.dispose();

    // world
    this.world = buildWorld();
    this.scene.add(this.world.group);
    buildSky(this.scene, this.world.animated);
    this.interior = buildInterior();
    this.scene.add(this.interior.group);
    this.scene.add(this.markers, this.jobLayer, this.remoteLayer);
    for (const z of this.world.zones) { if (z.id === 'seat') continue; const m = makeMarker(z.icon); m.position.set(z.x, 0, z.z); m.userData.phase = z.x; this.markers.add(m); }
    for (const z of this.interior.zones) { const m = makeMarker(z.icon, '#f5c242'); m.position.set(z.x, 0, z.z); m.userData.phase = z.z; m.userData.indoor = true; m.visible = false; this.markers.add(m); }

    // player
    this.avatar = makeCharacter(this.store.state.appearance, 'hi');
    this.avatar.root.position.copy(this.world.spawn);
    this.avatar.root.rotation.y = this.yaw;
    this.scene.add(this.avatar.root);
    this.rig.snapTo(this.avatar.root.position);

    this.npcs = new NpcManager(this.world.paths, touch ? 12 : 16);
    this.scene.add(this.npcs.group);

    // input + hud
    this.input = new Input(host, document.getElementById('joy')!, document.getElementById('joyKnob')!);
    this.hud = new Hud(this);
    this.hud.setTouch(touch);
    this.hud.onAction = (i) => this.runAction(i);
    this.input.onInteract = () => { if (!this.hud.isOpen) this.runAction(0); };
    this.input.onAction = (i) => { if (!this.hud.isOpen) this.runAction(i); };
    this.input.onEscape = () => this.hud.closeAll();
    this.input.onToggleRun = () => this.hud.setRun(this.input.runToggle);
    document.getElementById('runBtn')!.addEventListener('click', () => { this.input.runToggle = !this.input.runToggle; this.hud.setRun(this.input.runToggle); });

    this.jobs = new JobSystem(this.world, this.jobLayer, {
      toast: (m) => this.hud.toast(m),
      reward: (jobId, xp, hustle) => void this.reward(jobId, xp, hustle),
      objective: (t, x) => this.hud.objective(t, x, true, '💼'),
      clearObjective: () => this.defaultObjective(),
      timing: (r, t, ok, fail) => this.runMinigame(r, t, ok, fail),
      changed: () => this.store.update(() => { /* re-render */ }),
    });

    // cloud: other players, greetings
    cloud.onRemote = (players) => this.syncRemotes(players);
    cloud.onWave = (from) => { this.hud.toast(`${from.name} waved at you 👋`); const r = this.remotesMap.get(from.id); if (r) this.bubble(r, '👋'); };
    if (cloud.signedIn) cloud.joinCity(() => ({ name: this.store.state.name, username: this.store.state.username, appearance: this.store.state.appearance }));
    cloud.onStatus = (st) => { this.hud.cloudStatus(st); if (st === 'guest') { this.hud.toast('Signed out'); setTimeout(() => location.reload(), 600); } };

    (window as any).__gist = this;
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('beforeunload', () => { this.store.state.needs.at = Date.now(); this.store.update(() => {}); });
    this.defaultObjective();
    this.hud.loaded();
    this.hud.needs(this.store.state.needs);

    if (boot.needsCharacter || (!cloud.enabled && !localStorage.getItem('gist_onboarded'))) {
      localStorage.setItem('gist_onboarded', '1');
      this.creating = true;
      setTimeout(() => { this.hud.open('style'); this.hud.toast('Welcome to GistCity! Create your character, then enter the city ✦', 4500); }, 500);
    }
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /* ----------------------------------------------------------- HudHost */

  applyAppearance() {
    const pos = this.avatar.root.position.clone(), rot = this.avatar.root.rotation.y;
    this.avatar.setAppearance(this.store.state.appearance);
    this.avatar.root.position.copy(pos); this.avatar.root.rotation.y = rot;
    if (this.seated) this.avatar.setPose?.('sit');
    this.pushPresence();
  }
  setPortrait(on: boolean) { this.rig.portrait = on; }
  player() { const p = this.avatar.root.position; return { x: p.x, z: p.z, yaw: this.yaw }; }
  jobTarget() { return this.indoor ? null : this.jobs.target(); }
  activeJob(): JobId | null { return this.jobs.active?.id ?? null; }
  startJob(id: JobId) { if (this.indoor || this.seated || this.sleeping) return; this.jobs.start(id, this.avatar.root.position); }
  cancelJob() { this.jobs.cancel(); }
  isIndoor() { return this.indoor; }
  isCreating() { return this.creating; }
  async finishCreation() {
    this.creating = false;
    try { if (cloud.signedIn) await cloud.setCharacterReady(); } catch (e: any) { this.hud.toast(e?.message ?? 'Could not save'); }
    void cloud.save(this.store.state, true);
    this.hud.closeAll();
    this.hud.toast(`Welcome to GistCity, ${this.store.state.name}! Walk up to anything glowing to interact ✦`, 4500);
  }
  refreshFurniture() { this.interior.setFurniture(this.store.state.apartment); }
  cycleCamera() { this.camPreset = (this.camPreset + 1) % 3; this.rig.dist = [4.5, 6.5, 9.5][this.camPreset]; this.hud.toast(['Close camera', 'Standard camera', 'Wide camera'][this.camPreset]); }
  resetSave() {
    if (cloud.signedIn) { this.hud.toast('Online progress is kept on the server; only the look was reset.'); this.store.update((s) => { s.appearance = defaultState().appearance; }); this.applyAppearance(); return; }
    localStorage.removeItem('gist_save_v1');
    this.store.replace(defaultState());
    this.applyAppearance(); this.refreshFurniture();
    this.hud.closeAll(); this.hud.toast('Fresh start. Welcome back to GistCity.');
  }
  remotes() { return [...this.remotesMap.values()].filter((r) => !r.state.indoor).map((r) => ({ x: r.avatar.root.position.x, z: r.avatar.root.position.z, name: r.state.name })); }
  award(id: string) {
    const a = ACHIEVEMENTS[id]; if (!a || this.store.state.achievements.includes(id)) return;
    this.store.update((s) => { s.achievements.push(id); s.stats.xp += 25; });
    setTimeout(() => this.hud.toast(`🏅 Achievement: ${a.title}`, 3500), 900);
  }
  /** Buy a wardrobe / furniture item (HUD store). */
  async buy(id: string) {
    const r = await this.economy.buy(id);
    if (!r.ok) { this.hud.toast(r.message ?? 'Purchase failed'); return false; }
    return true;
  }
  wakeUp() { this.stopSleeping(false); }
  standUp() { this.stopSitting(); }

  /* ------------------------------------------------------------ helpers */

  private defaultObjective() {
    const s = this.store.state;
    if (this.indoor) this.hud.objective('Home sweet home', 'Sleep to recover energy, change your look at the wardrobe, or head back out.', false, '🏠');
    else if (s.jobsDone === 0) this.hud.objective('Make your first move', 'Find the Hustle Hub (💼, by the roundabout) and take a job to earn G.', false, '✦');
    else if (s.inventory.length === 0) this.hud.objective('Dress the part', 'GIST Fits (👕, north-west of the roundabout) has fits for every vibe.', false, '✦');
    else this.hud.objective('Live your GistCity life', 'Hustle, eat well, shop, pull up at the lounge, rest at home, gist with people.', false, '✦');
  }
  private async reward(jobId: JobId | 'pitch', xp: number, hustle: number) {
    const r = await this.economy.hustle(jobId);
    if (!r.ok) { this.hud.toast(r.message ?? 'Pay failed'); return; }
    this.store.update((s) => { s.stats.xp += xp; s.stats.hustle += hustle; if (hustle > 0) s.jobsDone++; });
    if (r.paid) this.hud.toast(`Paid ${fmtG(r.paid)} into your wallet 💚`, 3200);
    const s = this.store.state;
    if (s.jobsDone >= 1) this.award('first-hustle');
    if (s.jobsDone >= 5) this.award('five-hustles');
    if (s.cash >= 50000) this.award('big-boy');
  }
  private pushPresence() {
    const s = this.store.state;
    const key = s.name + JSON.stringify(s.appearance);
    if (key === this.lastPresence) return;
    this.lastPresence = key;
    void cloud.updatePresence(s.name, s.username, s.appearance);
  }
  private async runMinigame(rounds: number, title: string, ok: string, fail: string) {
    this.busy = true; this.hud.closeAll();
    const r = await this.hud.timing(rounds, title, ok, fail);
    this.busy = false;
    return r;
  }
  private visit(id: string) {
    this.store.update((s) => { if (!s.visited.includes(id)) s.visited.push(id); });
    const all = ['store', 'suya', 'buka', 'lounge', 'pitch', 'jobs', 'home'];
    if (all.every((z) => this.store.state.visited.includes(z))) this.award('explorer');
  }
  private get pose(): Pose { return this.sleeping ? 'sleep' : this.seated ? 'sit' : 'none'; }

  /* ------------------------------------------------------- interactions */

  /** The contextual menu for whatever the player is standing next to. Only actions that can really run are listed. */
  private actionsFor(z: Zone | null): Action[] {
    const s = this.store.state;
    const pos = this.avatar.root.position;
    if (this.sleeping) return [{ icon: '🌅', label: 'Wake up', run: () => this.stopSleeping(false) }];
    if (this.seated) return [{ icon: '🧍', label: 'Stand up', run: () => this.stopSitting() }];
    if (!z) return [];
    const order = (c: Consumable): Action => ({
      icon: c.icon, label: c.name, cost: c.price, disabled: s.cash < c.price ? "Can't afford" : undefined,
      run: () => void this.consume(c),
    });
    switch (z.id) {
      case 'npc': { const npc = this.npcs.nearest(pos, 2.4); return npc ? [{ icon: '💬', label: `Gist with ${npc.name}`, run: () => this.gistWith(npc) }] : []; }
      case 'player': {
        const r = z.data && (z.data as any).remote as Remote | undefined; if (!r) return [];
        return [
          { icon: '👋', label: `Greet ${r.state.name}`, run: () => { cloud.wave(r.state.id, s.name); this.bubble(r, '👋'); this.hud.toast(`You waved at ${r.state.name}`); this.store.update((st) => { if (!this.greeted.has(r.state.id)) { this.greeted.add(r.state.id); st.stats.popularity += 1; st.stats.xp += 5; } }); } },
          { icon: '👤', label: 'View profile', run: () => void this.hud.showProfile(r.state.id, r.state.name) },
          { icon: '💸', label: 'Send G', run: () => void this.sendGift(r) },
        ];
      }
      case 'store': return [{ icon: '👕', label: 'Browse GIST Fits', run: () => { this.visit('store'); this.hud.open('store'); } }];
      case 'jobs': return [{ icon: '💼', label: 'Check the job board', run: () => { this.visit('jobs'); this.hud.open('jobs'); } }];
      case 'home': return [{ icon: '🏠', label: 'Go inside', run: () => { this.visit('home'); this.enterApartment(); } }];
      case 'exit': return [{ icon: '🚪', label: 'Step outside', run: () => this.exitApartment() }];
      case 'wardrobe': return [{ icon: '👗', label: 'Open wardrobe', run: () => this.hud.open('style') }];
      case 'decor': return [{ icon: '🛋️', label: 'Decorate your space', run: () => this.hud.open('home') }];
      case 'suya': this.visit('suya'); return CONSUMABLES.filter((c) => c.vendor === 'suya').map(order);
      case 'buka': this.visit('buka'); return CONSUMABLES.filter((c) => c.vendor === 'buka').map(order);
      case 'lounge': this.visit('lounge'); return CONSUMABLES.filter((c) => c.vendor === 'lounge').map(order);
      case 'pos': return this.jobs.active?.id === 'pos' ? [] : [{ icon: '💳', label: 'Work the POS stand', run: () => this.jobs.start('pos', pos) }];
      case 'pitch': return [{ icon: '⚽', label: 'Penalty shootout', run: () => this.playPitch() }];
      case 'seat': {
        const free = this.freeSeat(z); if (!free) return [{ icon: '🪑', label: 'Bench is full', disabled: 'All seats taken', run: () => {} }];
        return [{ icon: '🪑', label: `Sit on the ${z.label.toLowerCase()}`, run: () => this.sitOn(free) }];
      }
      case 'bed': return [
        { icon: '😴', label: s.needs.energy >= 99 ? 'Lie down' : `Sleep (energy ${Math.round(s.needs.energy)}%)`, run: () => this.sleepOn(z.data?.bedTop ?? 0.3) },
      ];
    }
    return [];
  }
  private runAction(i: number) {
    if (this.busy) return;
    const a = this.currentActions[i];
    if (!a) { if (i === 0) this.hud.toast('Walk up to a glowing marker, a bench or a person, then interact.'); return; }
    if (a.disabled) { this.hud.toast(a.disabled); return; }
    a.run();
    this.refreshActions();
  }
  private refreshActions() {
    this.currentActions = this.actionsFor(this.currentZone);
    this.hud.actions(this.currentZone, this.currentActions);
  }
  private async consume(c: Consumable) {
    if (this.busy) return;
    this.busy = true;
    const r = await this.economy.buy(c.id);
    this.busy = false;
    if (!r.ok) { this.hud.toast(r.message ?? 'Could not order'); this.refreshActions(); return; }
    const fx = (r.effects ?? c.effects) as Record<string, number>;
    this.store.update((s) => {
      needs.apply(s.needs, fx);
      s.stats.popularity += fx.popularity ?? 0; s.stats.reputation += fx.reputation ?? 0; s.stats.xp += fx.xp ?? 0;
    });
    this.hud.needs(this.store.state.needs);
    this.hud.toast(`${c.line}${fx.hunger ? ` · hunger +${fx.hunger}` : ''}${fx.thirst ? ` · thirst +${fx.thirst}` : ''}${fx.popularity ? ` · +${fx.popularity} popularity` : ''}`, 3500);
    this.hud.emote(c.kind === 'service' ? '🪩' : c.kind === 'drink' ? '🥤' : '😋');
    if (c.kind !== 'service') this.award('well-fed');
    this.refreshActions();
  }
  private playPitch() {
    this.visit('pitch');
    void this.runMinigame(5, 'Penalty shootout — tap in the green zone to score', 'GOAL! ⚽', 'Saved by the keeper 🧤').then((goals) => {
      this.store.update((st) => { st.stats.reputation += goals * 2; st.stats.xp += goals * 10; });
      if (goals >= 3) { void this.reward('pitch', 0, 0); this.hud.toast(goals === 5 ? 'Five out of five! The whole pitch is screaming your name 🔥' : `${goals}/5 goals · +${goals * 2} reputation · side bets paid`); }
      else this.hud.toast(`${goals}/5 goals · +${goals * 2} reputation. Score 3+ to win the side bets.`);
    });
  }
  private async sendGift(r: Remote) {
    const amount = await this.hud.ask(`Send G to ${r.state.name}`, `You have ${fmtG(this.store.state.cash)}. Gifts are voluntary and cannot be reversed.`, 'Amount in G');
    if (!amount) return;
    const n = Number(amount.replace(/[^\d]/g, ''));
    const res = await this.economy.gift(r.state.username, n, `gift from ${this.store.state.name}`);
    this.hud.toast(res.ok ? `Sent ${fmtG(n)} to ${r.state.name} 💸` : (res.message ?? 'Transfer failed'));
  }
  private gistWith(npc: NonNullable<ReturnType<NpcManager['nearest']>>) {
    const line = GIST_LINES[Math.floor(Math.random() * GIST_LINES.length)];
    this.npcs.faceTowards(npc, this.avatar.root.position);
    this.npcs.say(npc, line);
    if (!this.greeted.has(npc.name)) {
      this.greeted.add(npc.name);
      this.store.update((s) => { s.stats.popularity += 1; s.stats.xp += 5; });
      this.hud.toast(`You gisted with ${npc.name} · +1 popularity`);
      if (this.greeted.size >= 10) this.award('socialite');
    }
  }
  private bubble(r: Remote, text: string) {
    if (r.bubble) r.avatar.root.remove(r.bubble);
    r.bubble = makeSprite(text, { scale: 0.5, bg: 'rgba(255,255,255,0.9)', fg: '#111' }); r.bubble.position.y = 2.45; r.avatar.root.add(r.bubble);
    r.bubbleUntil = performance.now() + 2500;
  }

  /* ------------------------------------------------------- sit & sleep */

  private freeSeat(z: Zone): Seat | null {
    const seats = z.data?.seats ?? [];
    for (const seat of seats) {
      const taken = [...this.remotesMap.values()].some((r) => r.state.pose === 'sit' && Math.hypot(r.state.x - seat.x, r.state.z - seat.z) < 0.45);
      if (!taken) return seat;
    }
    return null;
  }
  private sitOn(seat: Seat) {
    if (this.jobs.active) { this.hud.toast('Finish or cancel your hustle first.'); return; }
    this.seated = seat;
    this.velocity.set(0, 0, 0);
    this.avatar.root.position.set(seat.x, 0, seat.z);
    this.yaw = seat.yaw; this.avatar.root.rotation.y = seat.yaw;
    this.avatar.setPose?.('sit');
    this.rootY = seat.h - (this.avatar.hipHeight ?? 0.86);
    this.hud.toast('Taking a seat. Push the stick or press 1 to stand up.');
  }
  private stopSitting() {
    if (!this.seated) return;
    const seat = this.seated; this.seated = null;
    this.avatar.setPose?.('none');
    this.rootY = 0;
    // step forward off the seat so we don't stand inside the bench collider
    this.avatar.root.position.set(seat.x + Math.sin(seat.yaw) * 0.55, 0, seat.z + Math.cos(seat.yaw) * 0.55);
    this.refreshActions();
  }
  private sleepOn(bedTop: number) {
    if (this.jobs.active) { this.hud.toast('Finish or cancel your hustle first.'); return; }
    this.sleeping = { bedTop };
    this.velocity.set(0, 0, 0);
    this.avatar.root.position.set(BED_SPOT.x, 0, BED_SPOT.z + 0.85); // root = feet; body extends toward the wall
    // face up: yaw 0 (+z) then −90° about X puts the face toward +y and the head toward the wall (−z)
    this.yaw = 0; this.avatar.root.rotation.y = this.yaw;
    this.avatar.setPose?.('sleep');
    // frame the bed from inside the room
    this.rig.yaw = 0; this.rig.pitch = 0.6; this.rig.dist = Math.min(this.rig.dist, 5);
    this.hud.sleep(true, this.store.state.needs.energy);
    this.hud.toast('Sleeping… energy recovers while you rest 😴');
  }
  private stopSleeping(auto: boolean) {
    if (!this.sleeping) return;
    this.sleeping = null;
    this.avatar.setPose?.('none');
    this.avatar.root.rotation.x = 0; this.avatar.root.position.y = 0; this.rootY = 0;
    this.avatar.root.position.set(BED_SPOT.x, 0, BED_SPOT.z + 1.5);
    this.hud.sleep(false, this.store.state.needs.energy);
    if (auto) { this.hud.toast('Fully rested! Energy 100% ☀️'); this.award('rested'); }
    else this.hud.toast(`You got up. Energy ${Math.round(this.store.state.needs.energy)}%`);
    this.refreshActions();
  }

  private enterApartment() {
    this.indoor = true;
    this.world.group.visible = false; this.npcs.group.visible = false; this.jobLayer.visible = false; this.remoteLayer.visible = false;
    this.interior.group.visible = true;
    this.refreshFurniture();
    for (const m of this.markers.children) m.visible = !!m.userData.indoor;
    this.avatar.root.position.copy(this.interior.spawn);
    this.yaw = this.interior.spawnYaw; this.avatar.root.rotation.y = this.yaw; this.rig.yaw = this.yaw; this.rig.pitch = 0.28;
    this.rig.snapTo(this.avatar.root.position);
    this.sun.intensity = 0.9; this.hemi.intensity = 1.6; this.interior.light.intensity = 16;
    this.scene.fog = null;
    this.hud.district('YOUR FLAT · GIST HEIGHTS');
    this.hud.toast('Welcome home 🏠');
    this.defaultObjective();
  }
  private exitApartment() {
    this.indoor = false;
    this.world.group.visible = true; this.npcs.group.visible = true; this.jobLayer.visible = true; this.remoteLayer.visible = true;
    this.interior.group.visible = false;
    for (const m of this.markers.children) m.visible = !m.userData.indoor;
    this.avatar.root.position.set(14.6, 0, -24);
    this.yaw = -Math.PI / 2; this.avatar.root.rotation.y = this.yaw; this.rig.yaw = this.yaw;
    this.rig.snapTo(this.avatar.root.position);
    this.sun.intensity = 2.6; this.hemi.intensity = 1.15; this.interior.light.intensity = 0;
    this.scene.fog = new THREE.Fog('#e9dcc3', 70, 200);
    if (this.jobs.active) this.hud.objective('Hustle in progress', 'Follow the yellow marker.', true, '💼'); else this.defaultObjective();
  }

  /* ------------------------------------------------------------- remotes */

  private syncRemotes(players: Map<string, RemoteState>) {
    for (const [id, st] of players) {
      let r = this.remotesMap.get(id);
      const key = JSON.stringify(st.appearance);
      if (!r) {
        const avatar = makeCharacter(st.appearance, 'hi');
        avatar.root.position.set(st.x, 0, st.z);
        const tag = makeSprite(st.name, { scale: 0.6, bg: 'rgba(20,60,90,0.7)', fg: '#dff4ff' }); tag.position.y = 2.1; avatar.root.add(tag);
        this.remoteLayer.add(avatar.root);
        r = { avatar, state: st, tag, appearanceKey: key };
        this.remotesMap.set(id, r);
        this.hud.toast(`${st.name} is in the city 👋`);
      } else if (r.appearanceKey !== key) {
        r.avatar.setAppearance(st.appearance); r.avatar.root.add(r.tag); r.appearanceKey = key;
      }
      r.state = st;
    }
    for (const [id, r] of this.remotesMap) if (!players.has(id)) { this.remoteLayer.remove(r.avatar.root); r.avatar.dispose?.(); this.remotesMap.delete(id); }
  }
  private nearestRemote(pos: THREE.Vector3, maxD: number): Remote | null {
    let best: Remote | null = null, bd = maxD;
    for (const r of this.remotesMap.values()) { if (r.state.indoor) continue; const d = r.avatar.root.position.distanceTo(pos); if (d < bd) { bd = d; best = r; } }
    return best;
  }

  /* --------------------------------------------------------------- loop */

  private resize() {
    this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  private frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    const pos = this.avatar.root.position;
    const colliders = this.indoor ? this.interior.colliders : this.world.colliders;
    const s = this.store.state;

    // needs
    if (needs.tick(s.needs, dt, !!this.sleeping)) this.hud.needs(s.needs);
    this.needsTimer += dt;
    if (this.needsTimer > 20) { this.needsTimer = 0; this.store.dirty = true; }
    if (this.sleeping) { this.hud.sleep(true, s.needs.energy); if (s.needs.energy >= 100) this.stopSleeping(true); }

    // camera look
    const look = this.input.consumeLook();
    if (!this.rig.portrait) { this.rig.rotate(look.dx, look.dy); if (look.zoom) this.rig.zoom(look.zoom); }
    if (this.input.touch) this.hud.setTouch(true);

    // movement (camera-relative), frozen while a panel, a minigame, a seat or a bed holds the player
    const frozen = this.hud.isOpen || this.busy || this.sleeping;
    const axis = frozen ? { x: 0, y: 0, mag: 0 } : this.input.axis();
    if (this.seated && axis.mag > 0.4) this.stopSitting();
    const running = this.input.running && axis.mag > 0.6;
    const targetSpeed = this.seated ? 0 : axis.mag > 0.05 ? (running ? RUN : WALK) * Math.min(1, axis.mag * 1.2) * needs.speedFactor(s.needs) : 0;
    const fwd = this.rig.forward(), right = this.rig.right();
    const dir = new THREE.Vector3().addScaledVector(fwd, axis.y).addScaledVector(right, axis.x);
    if (dir.lengthSq() > 0) dir.normalize();
    const desired = dir.multiplyScalar(targetSpeed);
    this.velocity.lerp(desired, Math.min(1, dt * 10));
    const speed = this.seated || this.sleeping ? 0 : this.velocity.length();
    if (speed > 0.05) {
      const before = pos.clone();
      pos.addScaledVector(this.velocity, dt);
      if (!this.indoor) { pos.x = THREE.MathUtils.clamp(pos.x, -this.world.bounds, this.world.bounds); pos.z = THREE.MathUtils.clamp(pos.z, -this.world.bounds, this.world.bounds); }
      resolveCircle(pos, RADIUS, colliders);
      this.walked += pos.distanceTo(before);
      if (this.walked > 12) this.award('first-steps');
      const targetYaw = Math.atan2(this.velocity.x, this.velocity.z);
      let diff = targetYaw - this.yaw; while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
      this.yaw += diff * Math.min(1, dt * 12);
      this.avatar.root.rotation.y = this.yaw;
    }
    // vertical placement for furniture: seat height / lying on the bed
    if (this.sleeping) {
      const ty = this.sleeping.bedTop + 0.1;
      pos.y += (ty - pos.y) * Math.min(1, dt * 6);
      this.avatar.root.rotation.x += (-Math.PI / 2 - this.avatar.root.rotation.x) * Math.min(1, dt * 6);
    } else {
      pos.y += (this.rootY - pos.y) * Math.min(1, dt * 7);
      if (this.avatar.root.rotation.x !== 0) this.avatar.root.rotation.x *= Math.max(0, 1 - dt * 8);
    }
    this.avatar.animate(dt, speed < 0.1 ? 0 : speed > (WALK + RUN) / 2 ? 2 : 1, speed);

    // zones → contextual actions
    const zones = this.indoor ? this.interior.zones : this.world.zones;
    let best: Zone | null = null, bd = Infinity;
    for (const z of zones) { const d = Math.hypot(pos.x - z.x, pos.z - z.z); if (d < z.radius && d < bd) { bd = d; best = z; } }
    if (!this.indoor) {
      const rp = this.nearestRemote(pos, 2.4);
      if (rp && (!best || bd > 1.2)) best = { id: 'player', label: rp.state.name, icon: '🧑', x: rp.avatar.root.position.x, z: rp.avatar.root.position.z, radius: 2.4, prompt: `Greet ${rp.state.name}`, data: { remote: rp } as any };
      else if (!best) { const npc = this.npcs.nearest(pos, 2.2); if (npc) best = { id: 'npc', label: npc.name, icon: '💬', x: npc.avatar.root.position.x, z: npc.avatar.root.position.z, radius: 2.2, prompt: `Gist with ${npc.name}` }; }
    }
    if (best !== this.currentZone && (best?.id !== this.currentZone?.id || best?.label !== this.currentZone?.label || best?.x !== this.currentZone?.x)) { this.currentZone = best; this.refreshActions(); }
    else if (this.seated || this.sleeping) { if (this.currentActions.length !== 1) this.refreshActions(); }

    // world life
    if (!this.indoor) {
      this.npcs.update(dt, pos);
      void this.jobs.update(dt, pos, t);
      for (const fn of this.world.animated) fn(dt, t);
      this.hud.district(this.districtName(pos.x, pos.z));
    }
    for (const m of this.markers.children) if (m.visible) animateMarker(m as THREE.Group, t, m.userData.phase);

    // remote players
    const now = performance.now();
    for (const r of this.remotesMap.values()) {
      const st = r.state;
      r.avatar.root.visible = !st.indoor && !this.indoor;
      const target = new THREE.Vector3(st.x, st.pose === 'sit' ? 0.48 - (r.avatar.hipHeight ?? 0.86) : 0, st.z);
      const d = Math.hypot(r.avatar.root.position.x - target.x, r.avatar.root.position.z - target.z);
      if (d > 25) r.avatar.root.position.copy(target); else r.avatar.root.position.lerp(target, Math.min(1, dt * 8));
      let diff = st.yaw - r.avatar.root.rotation.y; while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
      r.avatar.root.rotation.y += diff * Math.min(1, dt * 10);
      r.avatar.setPose?.(st.pose === 'sit' ? 'sit' : 'none');
      r.avatar.animate(dt, d > 0.15 && st.pose === 'none' ? st.speed || 1 : 0);
      if (r.bubble && r.bubbleUntil && now > r.bubbleUntil) { r.avatar.root.remove(r.bubble); r.bubble = undefined; }
    }
    if (cloud.signedIn) cloud.broadcastPos(pos.x, pos.z, this.yaw, speed < 0.1 ? 0 : speed > (WALK + RUN) / 2 ? 2 : 1, this.indoor, this.pose);
    if (this.store.dirty) { this.store.dirty = false; void cloud.save(this.store.state); this.pushPresence(); }

    // sun follows the player so the shadow map stays sharp
    this.sun.position.set(pos.x - 32, 52, pos.z + 22);
    this.sun.target.position.copy(pos); this.sun.target.updateMatrixWorld();

    // camera
    this.rig.update(dt, pos, this.yaw, colliders, this.indoor);
    this.renderer.render(this.scene, this.camera);

    this.miniTimer += dt;
    if (this.miniTimer > 0.12) { this.miniTimer = 0; this.hud.drawMinimap(); }
  }

  private districtName(x: number, z: number) {
    if (Math.hypot(x, z) < 10) return 'GISTCITY · ROUNDABOUT';
    if (Math.abs(x) > 56 || Math.abs(z) > 56) return 'GISTCITY · OUTSKIRTS';
    if (x < 0 && z < 0) return 'GISTCITY · MARKET';
    if (x >= 0 && z < 0) return 'GIST HEIGHTS · RESIDENTIAL';
    if (x < 0 && z >= 0) return 'OLD ROAD · FOOD & NIGHTLIFE';
    return 'THE PITCH · SOUTH-EAST';
  }
}
