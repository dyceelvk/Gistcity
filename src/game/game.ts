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
import { NpcManager, type Npc } from './npc';
import { JobSystem, makeMarker, animateMarker, type JobId } from './jobs';
import { Store, defaultState, ACHIEVEMENTS, fmtG, type PlayerState } from './state';
import { CONSUMABLES, type Consumable } from './catalog';
import * as needs from './needs';
import { Hud, type HudHost, type Action } from '../ui/hud';
import { cloud, type RemoteState, type Area } from '../net/supabase';
import { Economy } from '../net/economy';
import { makeSprite } from './props';
import { buildInteriors } from './interiors';
import { DayCycle, fmtHour } from './daycycle';
import { VehicleManager, TrafficManager, handlingOf } from './vehicles';
import { trafficLoops } from './civic';
import { makeSociety, type Society, type VehicleView } from '../net/society';
import { SocietyPanels, AREA_LABEL, type SocietyHost } from '../ui/society-ui';
import { ActivityMachine } from './activity';
import { npcConversation, citizenConversation, type Conversation, type DialogueChoice } from './dialogue';
import { makeSocial, type Social } from '../net/social';
import { SocialUI } from '../ui/social-ui';
import { makeFamily, type Family } from '../net/family';
import { FamilyUI } from '../ui/family-ui';

const WALK = 3.3, RUN = 6.4, RADIUS = 0.38;

interface Remote { avatar: Character; state: RemoteState; tag: THREE.Sprite; appearanceKey: string; bubble?: THREE.Sprite; bubbleUntil?: number }

export interface Boot {
  state: PlayerState;
  /** The player must finish character creation before playing (first sign-in). */
  needsCharacter: boolean;
  /** Course ids of the certificates the server says we hold (empty offline). */
  certificates: string[];
  employment?: { position_id: string; title: string; employee_no: string } | null;
  church?: { slug: string; name: string; role: string } | null;
}

/** Door zone → which interior it opens. */
const DOORS: Record<string, Exclude<Area, 'city' | 'home'>> = { 'door-school': 'school', 'door-gov': 'gov', 'door-hospital': 'hospital', 'door-church': 'church', 'door-dealer': 'dealer' };
const AREA_TITLE: Record<Area, string> = { city: '', home: 'YOUR FLAT · GIST HEIGHTS', school: 'UNITY COLLEGE', gov: 'GOVERNMENT SECRETARIAT', hospital: 'GISTCITY GENERAL HOSPITAL', church: 'GRACE CHAPEL', dealer: 'ODOGWU MOTORS · SHOWROOM' };
const LESSON_S = 20;

export class Game implements HudHost, SocietyHost {
  store: Store;
  world: World;
  interior: Interior;
  economy: Economy;
  society: Society;
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
  // living society
  private scenes: Record<Exclude<Area, 'city'>, Interior>;
  private areaId: Area = 'city';
  private day: DayCycle;
  private vehicles: VehicleManager;
  private traffic: TrafficManager;
  private panels: SocietyPanels;
  private activityLabel = '';
  private lesson: { course: string; t: number } | null = null;
  private myVeh: VehicleView[] = [];
  private parkedVeh: VehicleView[] = [];
  private vehTimer = 0;
  private returnSpot: { x: number; z: number; yaw: number } | null = null;
  private bumpCool = 0;
  private lastClock = '';
  private churchSeat: number | null = null;
  // activity state machine + conversations
  private act = new ActivityMachine();
  private talking: {
    kind: 'npc' | 'player';
    id: string;
    name: string;
    npc?: Npc | null;
    remote?: Remote | null;
    convo: Conversation;
    roundChoices: DialogueChoice[];
  } | null = null;
  private myBubble: THREE.Sprite | null = null;
  private myBubbleUntil = 0;
  private lastChip = '';
  /** Public citizen pages + private DMs. */
  private social: Social;
  private socialUI: SocialUI;
  /** Marriage, family & ageing. */
  private family: Family;
  private familyUI: FamilyUI;
  /** Total simulated seconds (clamped dt) — debugging & tests; unlike Clock.elapsedTime it survives slow frames. */
  simSeconds = 0;

  constructor(host: HTMLElement, boot: Boot) {
    this.store = new Store(boot.state);
    this.economy = new Economy(this.store);
    this.society = makeSociety(this.store, boot.certificates ?? []);
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
    this.scenes = { home: this.interior, ...buildInteriors() };
    for (const k of Object.keys(this.scenes) as (keyof typeof this.scenes)[]) this.scene.add(this.scenes[k].group);
    this.scene.add(this.markers, this.jobLayer, this.remoteLayer);
    for (const z of this.world.zones) { if (z.id === 'seat') continue; const m = makeMarker(z.icon); m.position.set(z.x, 0, z.z); m.userData.phase = z.x; m.userData.area = 'city'; this.markers.add(m); }
    for (const k of Object.keys(this.scenes) as (keyof typeof this.scenes)[]) for (const z of this.scenes[k].zones) {
      if (z.id === 'seat' && z.data?.kind === 'wait') continue;
      const m = makeMarker(z.icon, '#f5c242'); m.position.set(z.x, 0, z.z); m.userData.phase = z.z; m.userData.area = k; m.visible = false; this.markers.add(m);
    }
    // vehicles + traffic + shared day/night
    this.vehicles = new VehicleManager(); this.scene.add(this.vehicles.group);
    this.traffic = new TrafficManager(trafficLoops(), touch ? 5 : 7); this.scene.add(this.traffic.group);
    const sky = this.scene.children.find((o) => o.userData.uniforms);
    this.day = new DayCycle(this.sun, this.hemi, sky ? (sky.userData.uniforms as any) : null, this.scene);

    // player
    this.avatar = makeCharacter(this.store.state.appearance, 'hi');
    this.avatar.root.position.copy(this.world.spawn);
    this.avatar.root.rotation.y = this.yaw;
    this.scene.add(this.avatar.root);
    this.rig.snapTo(this.avatar.root.position);

    this.npcs = new NpcManager(this.world.paths, touch ? 12 : 16); this.npcs.lodDist = touch ? 42 : 60;
    this.scene.add(this.npcs.group);

    // input + hud
    this.input = new Input(host, document.getElementById('joy')!, document.getElementById('joyKnob')!);
    this.hud = new Hud(this);
    this.panels = new SocietyPanels(this); this.hud.panels = this.panels;

    // citizen pages & private DMs
    this.social = makeSocial(this.store);
    this.socialUI = new SocialUI({
      social: this.social,
      myUsername: () => this.store.state.username || 'me',
      myName: () => this.store.state.name,
      myAge: () => this.family?.ageNow() ?? 25,
      openPanel: (id) => this.hud.open(id),
      closeAll: () => this.hud.closeAll(),
      toast: (msg, ms) => this.hud.toast(msg, ms),
      ask: (title, hint, placeholder, numeric) => this.hud.ask(title, hint, placeholder, numeric),
      confirm: (title) => window.confirm(title),
    });
    this.hud.social = this.socialUI;
    this.hud.socialOpen = (username) => this.socialUI.openProfile(username);
    this.social.onMessage = (thread) => { this.socialUI.onIncoming(thread); void this.socialUI.refreshBadge(); };
    void this.socialUI.refreshBadge();

    // marriage, family & ageing
    this.family = makeFamily(this.store);
    this.familyUI = new FamilyUI({
      family: this.family,
      openPanel: (id) => this.hud.open(id),
      toast: (msg, ms) => this.hud.toast(msg, ms),
      ask: (title, hint, placeholder, numeric) => this.hud.ask(title, hint, placeholder, numeric),
      confirm: (title) => window.confirm(title),
      onFamilyChanged: () => { /* age is computed live; panels re-render on open */ },
      familyRoom: () => void this.familyRoom(),
    });
    this.hud.family = this.familyUI;
    this.hud.setTouch(touch);
    this.hud.onAction = (i) => this.runAction(i);
    this.input.onInteract = () => {
      if (this.hud.dialogueOpen) return;
      if (!this.hud.isOpen) this.runAction(0);
    };
    this.input.onAction = (i) => {
      if (this.hud.dialogueOpen) { this.hud.pickDialogue(i); return; }
      if (!this.hud.isOpen) this.runAction(i);
    };
    // conversations: responses from the player, ending the chat, changing-room state
    this.hud.onDialogueChoice = (i) => this.pickDialogue(i);
    this.hud.onDialogueClose = () => this.endConversation();
    this.hud.onPanel = (id) => {
      if (id === 'style' && !this.creating && this.act.enter('CHANGING_CLOTHES')) { /* curtain shown by the HUD */ }
      else if (id === null && this.act.current === 'CHANGING_CLOTHES') this.act.endAll();
    };
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
    cloud.onSay = (from) => this.hearSay(from);
    if (cloud.signedIn) cloud.joinCity(() => ({ name: this.store.state.name, username: this.store.state.username, appearance: this.store.state.appearance }));
    cloud.onStatus = (st) => { this.hud.cloudStatus(st); if (st === 'guest') { this.hud.toast('Signed out'); setTimeout(() => location.reload(), 600); } };

    (window as any).__gist = this;
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('beforeunload', () => { this.store.state.needs.at = Date.now(); this.store.update(() => {}); });
    this.defaultObjective();
    this.hud.loaded();
    this.hud.needs(this.store.state.needs);
    void this.refreshVehicles();
    if (boot.employment) this.hud.toast(`Welcome back, ${boot.employment.title} ${boot.employment.employee_no}. Shifts are at the Secretariat.`, 4000);

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
    this.avatar.root.visible = !this.vehicles.driving;
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
  remotes() { return [...this.remotesMap.values()].filter((r) => r.state.area === 'city').map((r) => ({ x: r.avatar.root.position.x, z: r.avatar.root.position.z, name: r.state.name })); }
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
  exitVehicle() { this.leaveVehicle(); }

  /* --------------------------------------------------------- SocietyHost */

  toast(msg: string, ms?: number) { this.hud.toast(msg, ms); }
  ask(title: string, hint: string, placeholder: string, numeric = true) { return this.hud.ask(title, hint, placeholder, numeric); }
  closePanel() { this.hud.closeAll(); }
  area(): Area { return this.areaId; }
  activity() { return this.activityLabel; }
  health() { return this.store.state.needs.health; }
  churchSlug() { return 'grace-chapel'; }
  onlineCount() { return cloud.remote.size + (cloud.signedIn ? 1 : 0); }
  myVehicles() { return this.myVeh; }
  /** Reload my vehicles + everyone's parked cars and rebuild the street. Called on boot, after purchases and every 45 s. */
  async refreshVehicles() {
    try {
      const [mine, parked] = await Promise.all([this.society.myVehicles(), this.society.parkedVehicles()]);
      this.myVeh = mine; this.parkedVeh = parked;
      const byId = new Map<string, VehicleView>();
      for (const v of parked) byId.set(v.id, v);
      for (const v of mine) byId.set(v.id, { ...v, owner_name: v.owner_name ?? (v.mine ? this.store.state.name : undefined) });
      this.vehicles.setVehicles([...byId.values()]);
    } catch (e) { console.warn('[gist] vehicles', e); }
  }
  async buyVehicle(model: string, color: string) {
    if (this.busy) return;
    this.busy = true;
    // delivered to the Odogwu Motors forecourt, spread along the kerb
    const slot = (this.myVeh.length + this.parkedVeh.length) % 5;
    const x = 58.3, z = -33 + slot * 3.2 + (Math.random() - 0.5), yaw = 0;
    const r = await this.society.buyVehicle(model, color, x, z, yaw);
    this.busy = false;
    if (!r.ok) { this.hud.toast(r.message ?? 'Purchase failed'); return; }
    this.store.update((st) => { st.stats.xp += 80; st.stats.reputation += 5; });
    this.award('wheels');
    await this.refreshVehicles();
    this.hud.toast(`Congratulations! Your ${r.vehicle?.name ?? 'vehicle'} (${r.vehicle?.plate ?? ''}) is waiting on the forecourt outside 🔑`, 5000);
  }
  /** Government shift: a short desk minigame, then the server pays from the payroll account. */
  async workShift() {
    if (this.busy) return;
    this.hud.closeAll();
    this.activityLabel = 'on a government shift';
    this.act.enter('WORKING');
    this.pushActivityChip();
    const served = await this.runMinigame(5, 'Secretariat desk — tap in the green zone to serve each citizen', 'Served ✓', 'Form rejected — next!');
    this.activityLabel = '';
    if (this.act.current === 'WORKING') this.act.end();
    this.pushActivityChip();
    if (served < 3) { this.hud.toast(`${served}/5 citizens served. Serve at least 3 to be paid for the shift.`, 4000); this.hud.open('gov'); return; }
    const r = await this.society.govWorkShift();
    if (!r.ok) { this.hud.toast(r.message ?? 'The shift could not be recorded'); this.hud.open('gov'); return; }
    this.store.update((st) => { st.stats.xp += 30; st.stats.reputation += 2; st.jobsDone++; });
    this.hud.toast(`Shift ${r.shift ?? ''} complete · ${fmtG(r.paid ?? 0)} paid from the Government Payroll 💚`, 4500);
    this.hud.emote('🧾');
    this.hud.open('gov');
  }
  /** Reserve a seat for the live service, then sit on a pew (if we are in the chapel). */
  async attendService(serviceId: number) {
    const r = await this.society.churchAttend(serviceId);
    if (!r.ok) { this.hud.toast(r.message ?? 'Could not attend'); return; }
    this.churchSeat = r.seat_no ?? null;
    this.award('faithful');
    this.hud.closeAll();
    this.hud.toast(`Seat #${r.seat_no} reserved · service ends in ${Math.ceil((r.ends_in_s ?? 0) / 60)} min · ${r.seats_left} seats left 🙏`, 4500);
    this.store.update((st) => { st.stats.xp += 15; st.stats.reputation += 1; });
    if (this.areaId === 'church') {
      const pews = this.scenes.church.zones.find((z) => z.id === 'seat');
      const seat = pews ? this.freeSeat(pews) : null;
      if (seat) { this.sitOn(seat); this.activityLabel = 'at a church service'; }
    } else this.hud.toast('Head to Grace Chapel (south ring road) to take your seat.', 4000);
  }
  /** Hospital purchase: server-authorised, then the effects apply to your needs. */
  async treat(id: string) {
    if (id === 'svc-checkup') {
      const n = this.store.state.needs;
      this.hud.toast(`Nurse Chidinma: health ${Math.round(n.health)}% · hunger ${Math.round(n.hunger)}% · thirst ${Math.round(n.thirst)}% · energy ${Math.round(n.energy)}%. ${n.health < 40 ? 'See the doctor today.' : 'You are doing fine.'}`, 5000);
      return;
    }
    const c = CONSUMABLES.find((x) => x.id === id); if (!c) return;
    await this.consume(c);
  }

  /* ------------------------------------------------------------ helpers */

  private defaultObjective() {
    const s = this.store.state;
    if (this.areaId === 'home') this.hud.objective('Home sweet home', 'Sleep to recover energy, change your look at the wardrobe, or head back out.', false, '🏠');
    else if (this.indoor) this.hud.objective(AREA_TITLE[this.areaId], `You are in ${AREA_LABEL[this.areaId]}. Walk up to a desk, seat or display to interact.`, false, '🏛️');
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
    const civic = ['school', 'gov', 'hospital', 'church', 'dealer'];
    if (civic.every((z) => this.store.state.visited.includes(z))) this.award('citizen');
  }
  private get pose(): Pose { return this.sleeping ? 'sleep' : this.seated ? 'sit' : 'none'; }

  /* ------------------------------------------------------- interactions */

  /** The contextual menu for whatever the player is standing next to. Only actions that can really run are listed. */
  private actionsFor(z: Zone | null): Action[] {
    const s = this.store.state;
    const pos = this.avatar.root.position;
    if (this.sleeping) return [{ icon: '🌅', label: 'Wake up', run: () => this.stopSleeping(false) }];
    if (this.vehicles.driving) { const d = this.vehicles.driving; return [{ icon: '🅿️', label: 'Park & get out', disabled: Math.abs(d.speed) > 0.6 ? 'Stop the car first' : undefined, run: () => this.leaveVehicle() }]; }
    if (this.seated) return [{ icon: '🧍', label: this.lesson ? 'Leave the class' : 'Stand up', run: () => this.stopSitting() }];
    if (!z) return [];
    if (z.id in DOORS) { const k = DOORS[z.id]; return [{ icon: z.icon, label: z.prompt, run: () => this.enterBuilding(k, z) }]; }
    const order = (c: Consumable): Action => ({
      icon: c.icon, label: c.name, cost: c.price, disabled: s.cash < c.price ? "Can't afford" : undefined,
      run: () => void this.consume(c),
    });
    switch (z.id) {
      case 'npc': {
        const npc = this.npcs.nearest(pos, 2.4);
        if (!npc) return [];
        const un = npc.name.toLowerCase();
        return [
          { icon: '💬', label: `Gist with ${npc.name}`, run: () => this.startNpcTalk(npc) },
          { icon: '👤', label: `${npc.name}'s page`, run: () => void this.socialUI.openProfile(un) },
          { icon: '✉️', label: `Message ${npc.name}`, run: () => void this.socialUI.message(un) },
        ];
      }
      case 'player': {
        const r = z.data && (z.data as any).remote as Remote | undefined; if (!r) return [];
        const un = r.state.username || r.state.name.toLowerCase();
        return [
          { icon: '💬', label: `Talk to ${r.state.name}`, run: () => this.startPlayerTalk(r) },
          { icon: '👋', label: `Greet ${r.state.name}`, run: () => { cloud.wave(r.state.id, s.name); this.bubble(r, '👋'); this.hud.toast(`You waved at ${r.state.name}`); this.store.update((st) => { if (!this.greeted.has(r.state.id)) { this.greeted.add(r.state.id); st.stats.popularity += 1; st.stats.xp += 5; } }); } },
          { icon: '👤', label: `${r.state.name}'s page`, run: () => void this.socialUI.openProfile(un) },
          { icon: '✉️', label: `Message ${r.state.name}`, run: () => void this.socialUI.message(un) },
          { icon: '💸', label: 'Send G', run: () => void this.sendGift(r) },
        ];
      }
      case 'store': return [
        { icon: '👕', label: 'Browse GIST Fits', run: () => { this.visit('store'); this.hud.open('store'); } },
        { icon: '👗', label: 'Use the changing room', run: () => { this.visit('store'); this.hud.open('style'); } },
      ];
      case 'vehicle': {
        const v = (z.data as any)?.vehicle as VehicleView | undefined; if (!v) return [];
        const canDrive = v.mine || v.keys.includes(this.store.state.username);
        const lic = this.society.hasCertificate('drivers-licence');
        const list: Action[] = [{ icon: '🔍', label: `Inspect ${v.name}`, run: () => this.hud.toast(`${v.name} · plate ${v.plate} · owner ${v.owner_name ?? (v.mine ? 'you' : 'a citizen')}${v.mine ? '' : canDrive ? ' · you hold the keys' : ''}`, 4000) }];
        if (canDrive) list.unshift({ icon: '🚗', label: `Drive the ${v.name}`, disabled: !lic ? 'You need a driver\'s licence (Unity College)' : undefined, run: () => this.enterVehicle(v.id) });
        if (v.mine) list.push({ icon: '🔑', label: 'Share keys', run: () => this.hud.open('vehicles') });
        return list;
      }
      case 'gym': { const c = CONSUMABLES.find((x) => x.id === 'svc-gym')!; return [{ icon: '🏋️', label: 'Train (health +8, energy −10)', cost: c.price, disabled: s.cash < c.price ? "Can't afford" : s.needs.energy < 15 ? 'Too tired to train' : undefined, run: () => void this.consume(c) }]; }
      case 'school-desk': return [{ icon: '🎓', label: 'Admissions: courses & certificates', run: () => this.hud.open('school') }];
      case 'gov-employment': return [{ icon: '🏛️', label: 'Employment desk', run: () => this.hud.open('gov') }];
      case 'gov-registry': return [
        { icon: '💍', label: 'Marriage & family desk', run: () => { this.visit('gov'); this.hud.open('registry'); } },
        { icon: '👶', label: 'Birth registry (today)', run: () => { this.visit('gov'); this.hud.open('registry'); } },
      ];
      case 'gov-revenue': return [{ icon: '🧾', label: 'Revenue desk', disabled: 'Business permits — coming soon', run: () => {} }];
      case 'hospital-desk': case 'pharmacy': {
        const acts = [{ icon: z.id === 'pharmacy' ? '💊' : '🏥', label: z.id === 'pharmacy' ? 'Pharmacy counter' : 'Reception: see the doctor', run: () => this.hud.open('hospital') }];
        if (z.id === 'hospital-desk') acts.push({ icon: '👶', label: 'Maternity room: start a family', run: () => void this.familyRoom() } as any);
        return acts;
      }
      case 'church-board': case 'church-greeter': return [{ icon: '⛪', label: z.id === 'church-board' ? 'Church notice board' : 'Ask about services & membership', run: () => this.hud.open('church') }];
      case 'church-basket': return [{ icon: '🧺', label: 'Give an offering', run: () => void this.offering() }];
      case 'dealer-car': { const model = z.data?.model ?? ''; return [{ icon: '🚗', label: `Inspect the ${z.label}`, run: () => { this.hud.toast(`${z.label}: see the price list and buy at the sales desk.`); this.hud.open('dealer'); } }, { icon: '💳', label: 'Buy this model', run: () => this.hud.open('dealer') }].filter(() => !!model); }
      case 'dealer-desk': return [{ icon: '🔑', label: 'Sales desk: buy a vehicle', run: () => this.hud.open('dealer') }, { icon: '🚗', label: 'My vehicles', run: () => this.hud.open('vehicles') }];
      case 'jobs': return [{ icon: '💼', label: 'Check the job board', run: () => { this.visit('jobs'); this.hud.open('jobs'); } }];
      case 'home': return [{ icon: '🏠', label: 'Go inside', run: () => { this.visit('home'); this.enterApartment(); } }];
      case 'exit': return [{ icon: '🚪', label: 'Step outside', run: () => this.exitApartment() }];
      case 'wardrobe': return [{ icon: '👗', label: 'Open wardrobe (private changing)', run: () => this.hud.open('style') }];
      case 'decor': return [{ icon: '🛋️', label: 'Decorate your space', run: () => this.hud.open('home') }];
      case 'suya': this.visit('suya'); return CONSUMABLES.filter((c) => c.vendor === 'suya').map(order);
      case 'buka': this.visit('buka'); return CONSUMABLES.filter((c) => c.vendor === 'buka').map(order);
      case 'lounge': this.visit('lounge'); return CONSUMABLES.filter((c) => c.vendor === 'lounge').map(order);
      case 'pos': return this.jobs.active?.id === 'pos' ? [] : [{ icon: '💳', label: 'Work the POS stand', run: () => this.jobs.start('pos', pos) }];
      case 'pitch': return [{ icon: '⚽', label: 'Penalty shootout', run: () => this.playPitch() }];
      case 'seat': {
        const free = this.freeSeat(z); if (!free) return [{ icon: '🪑', label: `${z.label} full`, disabled: 'All seats taken', run: () => {} }];
        if (z.data?.kind === 'class') return [{ icon: '📚', label: `Attend class (${LESSON_S} s lesson)`, run: () => this.startLesson(free) }, { icon: '🎓', label: 'Courses & certificates', run: () => this.hud.open('school') }];
        if (z.data?.kind === 'pew') return [{ icon: '🙏', label: 'Take a seat in the pews', run: () => { this.sitOn(free); this.activityLabel = 'at Grace Chapel'; } }, { icon: '⛪', label: 'Services & membership', run: () => this.hud.open('church') }];
        return [{ icon: '🪑', label: `Sit on the ${z.label.toLowerCase()}`, run: () => this.sitOn(free) }];
      }
      case 'bed': return [
        { icon: '😴', label: s.needs.energy >= 99 ? 'Lie down' : `Sleep (energy ${Math.round(s.needs.energy)}%)`, run: () => this.sleepOn(z.data?.bedTop ?? 0.3, z) },
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
    if (this.talking) { this.hud.actions(null, []); return; }
    this.currentActions = this.actionsFor(this.currentZone);
    this.hud.actions(this.currentZone, this.currentActions);
  }
  /** Order and consume: a real EATING / DRINKING sequence with visible effects over time. */
  private async consume(c: Consumable) {
    if (this.busy) return;
    this.busy = true;
    const r = await this.economy.buy(c.id);
    if (!r.ok) { this.busy = false; this.hud.toast(r.message ?? 'Could not order'); this.refreshActions(); return; }
    const fx = (r.effects ?? c.effects) as Record<string, number>;
    const isDrink = c.kind === 'drink', isService = c.kind === 'service';
    const dur = isService ? 1.6 : isDrink ? 2.8 : 3.6;
    const state = isService ? 'INTERACTING' : isDrink ? 'DRINKING' : 'EATING';
    this.activityLabel = c.name.toLowerCase();
    this.act.enter(state, dur);
    this.pushActivityChip();
    this.hud.toast(`${c.icon} ${isService ? 'Enjoying' : isDrink ? 'Drinking' : 'Eating'} ${c.name}…`, Math.round(dur * 1000));
    this.hud.emote(isService ? '🪩' : isDrink ? '🥤' : '😋');
    // needs recover through the sequence, so the bars move while you eat / drink
    const steps = 3;
    for (let i = 0; i < steps; i++) {
      await new Promise((res) => setTimeout(res, (dur * 1000) / steps));
      this.store.update((s) => {
        needs.apply(s.needs, {
          hunger: (fx.hunger ?? 0) / steps, thirst: (fx.thirst ?? 0) / steps,
          energy: (fx.energy ?? 0) / steps, health: (fx.health ?? 0) / steps,
        });
      });
      this.hud.needs(this.store.state.needs);
    }
    this.store.update((s) => {
      s.stats.popularity += fx.popularity ?? 0; s.stats.reputation += fx.reputation ?? 0; s.stats.xp += fx.xp ?? 0;
    });
    if (this.act.current === state) this.act.end();
    this.activityLabel = '';
    this.pushActivityChip();
    this.hud.toast(`${c.line}${fx.hunger ? ` · hunger +${fx.hunger}` : ''}${fx.thirst ? ` · thirst +${fx.thirst}` : ''}${fx.popularity ? ` · +${fx.popularity} popularity` : ''}`, 3500);
    if (!isService) this.award('well-fed');
    this.busy = false;
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
  /* ------------------------------------------------------ conversations */

  /** Talk to an NPC: a real conversation where every prompt has a response. */
  private startNpcTalk(npc: Npc) {
    if (this.talking) return;
    this.hud.closeAll();
    const convo = npcConversation(npc.name);
    this.npcs.faceTowards(npc, this.avatar.root.position);
    this.npcs.say(npc, convo.opening, 10);
    this.talking = { kind: 'npc', id: npc.name, name: npc.name, npc, convo, roundChoices: convo.choices };
    this.act.enter('TALKING');
    this.hud.actions(null, []);
    this.hud.showDialogue(convo.name, convo.role, convo.opening, convo.choices);
    this.pushActivityChip();
  }

  /** Talk to another player in the city — they answer for themselves, in real time. */
  private startPlayerTalk(r: Remote, firstLine?: string) {
    if (this.talking && !(this.talking.kind === 'player' && this.talking.id === r.state.id)) this.endConversation();
    this.hud.closeAll();
    const convo = citizenConversation(r.state.name, firstLine);
    this.talking = { kind: 'player', id: r.state.id, name: r.state.name, remote: r, convo, roundChoices: convo.choices };
    this.act.enter('TALKING');
    this.hud.actions(null, []);
    this.hud.showDialogue(convo.name, convo.role, convo.opening, convo.choices);
    this.pushActivityChip();
  }

  /** A spoken line from another player arrives (their response — or a new conversation). */
  private hearSay(from: { id: string; name: string; text: string }) {
    const r = this.remotesMap.get(from.id);
    if (r) this.bubble(r, from.text);
    this.hud.toast(`${from.name}: “${from.text}”`, 5500);
    if (this.talking?.kind === 'player' && this.talking.id === from.id) {
      this.hud.dialogueLine(`“${from.text}”`);
      this.hud.dialogueChoices(this.talking.roundChoices);
    } else if (r) {
      this.startPlayerTalk(r, from.text);
    }
  }

  /** The player picked a conversation response. */
  private pickDialogue(i: number) {
    const t = this.talking;
    if (!t) return;
    const c = t.roundChoices[i];
    if (!c) { this.endConversation(); return; }
    this.sayBubble(c.say);
    if (t.kind === 'npc' && t.npc) {
      this.npcs.faceTowards(t.npc, this.avatar.root.position);
      if (!this.greeted.has(t.id)) {
        this.greeted.add(t.id);
        this.store.update((st) => { st.stats.popularity += 1; st.stats.xp += 5; });
        if (this.greeted.size >= 10) this.award('socialite');
      }
      if (c.effect) {
        const pop = c.effect.popularity ?? 0, xp = c.effect.xp ?? 0;
        if (pop || xp) this.store.update((st) => { st.stats.popularity += pop; st.stats.xp += xp; });
        if (c.effect.tip) this.hud.toast(c.effect.tip, 5500);
      }
      if (c.close) { this.npcs.say(t.npc, c.response || 'No wahala.', 3); this.endConversation(); return; }
      const line = c.then?.line ? `${c.response} ${c.then.line}` : (c.response || 'No wahala.');
      this.npcs.say(t.npc, line, 10);
      this.hud.dialogueLine(line);
      t.roundChoices = c.then?.choices ?? [{ icon: '🚶', label: 'Walk away', say: 'Take care!', response: '', close: true }];
      this.hud.dialogueChoices(t.roundChoices);
    } else {
      // player ↔ player: broadcast my line; their reply comes back over the realtime channel
      if (t.remote) {
        cloud.say(t.remote.state.id, this.store.state.name, c.say);
        if (c.close) { this.endConversation(); return; }
        this.hud.dialogueLine('You said it — waiting for their reply (they answer on their side).');
      } else if (c.close) { this.endConversation(); return; }
      t.roundChoices = t.convo.choices;
      this.hud.dialogueChoices(t.roundChoices);
    }
  }

  /** End the running conversation (walked away, ×, or it finished). */
  private endConversation() {
    if (!this.talking && !this.hud.dialogueOpen) return;
    this.talking = null;
    if (this.act.current === 'TALKING') this.act.endAll();
    this.hud.closeDialogue(false);
    this.pushActivityChip();
    this.refreshActions();
  }

  /** A speech bubble over my own character. */
  private sayBubble(text: string) {
    if (this.myBubble) this.avatar.root.remove(this.myBubble);
    this.myBubble = makeSprite(text, { scale: 0.8, bg: 'rgba(165,255,56,0.92)', fg: '#0b0e0c' });
    this.myBubble.position.y = 2.55;
    this.avatar.root.add(this.myBubble);
    this.myBubbleUntil = performance.now() + 3200;
  }

  /** Combined activity string for the HUD chip and the presence broadcast. */
  private activityString(): string {
    const base = this.act.label();
    if (!base) return this.activityLabel;
    return this.activityLabel ? `${base} ${this.activityLabel}` : base;
  }
  private chipIcon(): string {
    switch (this.act.current) {
      case 'EATING': return '🍛';
      case 'DRINKING': return '🥤';
      case 'SLEEPING': return '😴';
      case 'DRIVING': return '🚗';
      case 'TALKING': return '💬';
      case 'SITTING': return '🪑';
      case 'CHANGING_CLOTHES': return '👗';
      case 'WORKING': return '💼';
      default: return '✦';
    }
  }
  private pushActivityChip() {
    // the chip shows real activity states; bare location notes only go to presence
    const s = this.act.label() ? this.activityString() : '';
    if (s === this.lastChip) return;
    this.lastChip = s;
    if (s) this.hud.activityChip(s, this.chipIcon());
    else this.hud.activityChipClear();
  }

  /* ------------------------------------------------------- family room */

  /** The character's current age (accelerated city calendar). */
  myAge(): number { return this.family.ageNow(); }

  /**
   * The family room at GistCity General: a married couple enters, the scene
   * fades to black (abstract, non-explicit by design — the brief's own safety
   * rules), and the newborn is registered to both parents in today's registry.
   */
  private async familyRoom() {
    if (this.busy) return;
    const m = await this.familyUI.activeMarriage();
    if (!m) { this.hud.toast('The family room is for married couples. The Civil Registry can help with that.'); return; }
    const name = await this.hud.ask(
      'The family room',
      `You and ${m.partner} are expected at the maternity room. What name would you like for the baby?`,
      "Baby's name", false);
    if (name === null || !name.trim()) return;
    this.hud.closeAll();
    const fade = document.getElementById('fade');
    const msg = document.getElementById('fadeMsg');
    if (msg) msg.textContent = 'A new chapter for your family…';
    fade?.classList.add('on');
    this.busy = true;
    await new Promise((r) => setTimeout(r, 2600));
    const r = await this.family.childbirth(m.id, name.trim());
    await new Promise((r2) => setTimeout(r2, 900));
    fade?.classList.remove('on');
    this.busy = false;
    if (r.ok) {
      this.hud.emote('👶');
      this.hud.toast(`👶 ${r.name ?? name.trim()} was born today — matched to you and ${m.partner} in the registry.`, 6500);
      this.store.update((s) => { s.stats.popularity += 5; s.stats.xp += 50; });
    } else {
      this.hud.toast(r.message ?? 'Could not register the birth', 4500);
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
    if (!this.act.enter('SITTING')) { this.hud.toast('Finish what you are doing first.'); return; }
    this.seated = seat;
    this.velocity.set(0, 0, 0);
    this.avatar.root.position.set(seat.x, 0, seat.z);
    this.yaw = seat.yaw; this.avatar.root.rotation.y = seat.yaw;
    this.avatar.setPose?.('sit');
    this.rootY = seat.h - (this.avatar.hipHeight ?? 0.86);
    this.pushActivityChip();
    this.hud.toast('Taking a seat. Push the stick or press 1 to stand up.');
  }
  private stopSitting() {
    if (!this.seated) return;
    const seat = this.seated; this.seated = null;
    this.velocity.set(0, 0, 0);
    if (this.lesson) { this.lesson = null; this.hud.toast('You left before the lesson ended — it does not count.'); this.defaultObjective(); }
    if (this.activityLabel.startsWith('at ') || this.activityLabel === 'in class') this.activityLabel = '';
    this.act.endAll();
    this.pushActivityChip();
    this.avatar.setPose?.('none');
    this.rootY = 0;
    // step forward off the seat so we don't stand inside the bench collider
    this.avatar.root.position.set(seat.x + Math.sin(seat.yaw) * 0.55, 0, seat.z + Math.cos(seat.yaw) * 0.55);
    this.refreshActions();
  }
  private bedExit = { x: BED_SPOT.x, z: BED_SPOT.z + 1.5 };
  private sleepOn(bedTop: number, z?: Zone) {
    if (this.jobs.active) { this.hud.toast('Finish or cancel your hustle first.'); return; }
    if (!this.act.enter('SLEEPING')) { this.hud.toast('Finish what you are doing first.'); return; }
    this.sleeping = { bedTop };
    this.velocity.set(0, 0, 0);
    if (z?.data?.bedX !== undefined && z.data.bedZ !== undefined) {
      // ward bed: the bed's head is at local -z, feet at +z (after bedYaw)
      const by = z.data.bedYaw ?? 0;
      this.avatar.root.position.set(z.data.bedX + Math.sin(by) * 0.85, 0, z.data.bedZ + Math.cos(by) * 0.85);
      this.yaw = by; this.bedExit = { x: z.x, z: z.z };
      this.activityLabel = 'in the hospital ward';
    } else {
      this.avatar.root.position.set(BED_SPOT.x, 0, BED_SPOT.z + 0.85); // root = feet; body extends toward the wall
      // face up: yaw 0 (+z) then −90° about X puts the face toward +y and the head toward the wall (−z)
      this.yaw = 0; this.bedExit = { x: BED_SPOT.x, z: BED_SPOT.z + 1.5 };
    }
    this.avatar.root.rotation.y = this.yaw;
    this.avatar.setPose?.('sleep');
    // frame the bed from inside the room
    this.rig.yaw = this.yaw; this.rig.pitch = 0.6; this.rig.dist = Math.min(this.rig.dist, 5);
    this.hud.sleep(true, this.store.state.needs.energy);
    this.hud.toast('Sleeping… energy recovers while you rest 😴');
  }
  private stopSleeping(auto: boolean) {
    if (!this.sleeping) return;
    this.sleeping = null;
    this.velocity.set(0, 0, 0);
    this.act.endAll();
    this.pushActivityChip();
    this.avatar.setPose?.('none');
    this.avatar.root.rotation.x = 0; this.avatar.root.position.y = 0; this.rootY = 0;
    this.avatar.root.position.set(this.bedExit.x, 0, this.bedExit.z);
    if (this.activityLabel.startsWith('resting')) this.activityLabel = '';
    this.hud.sleep(false, this.store.state.needs.energy);
    if (auto) { this.hud.toast('Fully rested! Energy 100% ☀️'); this.award('rested'); }
    else this.hud.toast(`You got up. Energy ${Math.round(this.store.state.needs.energy)}%`);
    this.refreshActions();
  }

  private enterApartment() {
    this.returnSpot = { x: 14.6, z: -24, yaw: -Math.PI / 2 };
    this.enterScene('home');
    this.refreshFurniture();
    this.hud.toast('Welcome home 🏠');
  }
  private exitApartment() { this.exitScene(); }
  /** Walk through a civic door: remember where to come back out, then load that interior. */
  private enterBuilding(k: Exclude<Area, 'city' | 'home'>, door: Zone) {
    if (this.vehicles.driving) { this.hud.toast('Park the car first.'); return; }
    // step back out facing away from the building (door zones sit just outside the façade)
    const away = Math.atan2(-door.x, -door.z); // towards the city centre
    this.returnSpot = { x: door.x + Math.sin(away) * 1.2, z: door.z + Math.cos(away) * 1.2, yaw: away };
    this.visit(k);
    this.enterScene(k);
    const welcome: Record<string, string> = { school: 'Unity College. Admissions desk on your left, classroom ahead 🎓', gov: 'Government Secretariat. Take a number — the employment desk is on the left 🏛️', hospital: 'GistCity General Hospital. Reception ahead, ward on the right 🏥', church: 'Welcome to Grace Chapel. Everyone is welcome ⛪', dealer: 'Odogwu Motors. Look, touch, buy — licence holders only 🚗' };
    this.hud.toast(welcome[k], 4000);
    if (k === 'church') this.activityLabel = 'at Grace Chapel';
  }
  private enterScene(k: Exclude<Area, 'city'>) {
    const sc = this.scenes[k];
    this.indoor = true; this.areaId = k;
    this.world.group.visible = false; this.npcs.group.visible = false; this.jobLayer.visible = false; this.vehicles.group.visible = false; this.traffic.group.visible = false;
    for (const key of Object.keys(this.scenes) as (keyof typeof this.scenes)[]) this.scenes[key].group.visible = key === k;
    for (const m of this.markers.children) m.visible = m.userData.area === k;
    this.avatar.root.position.copy(sc.spawn);
    this.yaw = sc.spawnYaw; this.avatar.root.rotation.y = this.yaw; this.rig.yaw = this.yaw; this.rig.pitch = 0.28;
    this.rig.snapTo(this.avatar.root.position);
    this.sun.intensity = 0.9; this.sun.color.set('#ffe2b8'); this.hemi.intensity = 1.6; this.hemi.color.set('#dff1ff'); this.hemi.groundColor.set('#5c6b4e'); sc.light.intensity = k === 'home' ? 16 : 30;
    this.scene.fog = null;
    this.hud.district(AREA_TITLE[k]);
    this.defaultObjective();
  }
  private exitScene() {
    const from = this.areaId;
    if (this.seated) this.stopSitting();
    this.indoor = false; this.areaId = 'city'; this.activityLabel = '';
    this.world.group.visible = true; this.npcs.group.visible = true; this.jobLayer.visible = true; this.vehicles.group.visible = true; this.traffic.group.visible = true;
    for (const key of Object.keys(this.scenes) as (keyof typeof this.scenes)[]) { this.scenes[key].group.visible = false; this.scenes[key].light.intensity = 0; }
    for (const m of this.markers.children) m.visible = m.userData.area === 'city';
    const r = this.returnSpot ?? { x: 14.6, z: -24, yaw: -Math.PI / 2 };
    this.avatar.root.position.set(r.x, 0, r.z);
    this.yaw = r.yaw; this.avatar.root.rotation.y = this.yaw; this.rig.yaw = this.yaw;
    this.rig.snapTo(this.avatar.root.position);
    this.scene.fog = new THREE.Fog('#e9dcc3', 70, 200);
    if (from === 'dealer' || from === 'church') void this.refreshVehicles();
    if (this.jobs.active) this.hud.objective('Hustle in progress', 'Follow the yellow marker.', true, '💼'); else this.defaultObjective();
  }

  /* ------------------------------------------------------ school lesson */

  private startLesson(seat: Seat) {
    const enrolled = this.enrolledCourse();
    if (!enrolled) { this.hud.toast('Enrol at the admissions desk first — then come back and sit down.'); this.hud.open('school'); return; }
    this.sitOn(seat);
    this.lesson = { course: enrolled, t: 0 };
    this.activityLabel = 'in class';
    this.hud.objective('In class', `Mr Okonkwo is teaching. Stay seated for ${LESSON_S} seconds and the class is recorded.`, true, '📚');
  }
  private enrolledCourse(): string | null {
    const edu = (this.panels as any).edu as { courses: { id: string; status: string | null; classes_attended: number; classes_required: number }[] } | null;
    const c = edu?.courses.find((x) => x.status === 'enrolled' && x.classes_attended < x.classes_required) ?? edu?.courses.find((x) => x.status === 'enrolled');
    return c?.id ?? null;
  }
  private async finishLesson() {
    const l = this.lesson; if (!l) return;
    this.lesson = null; this.activityLabel = '';
    const r = await this.society.attendClass(l.course);
    if (!r.ok) { this.hud.toast(r.message ?? 'The class was not recorded'); if (r.error === 'GC_COOLDOWN') this.hud.toast(`Next class opens in ${r.retry_in ?? 0}s`); }
    else {
      this.store.update((st) => { st.stats.xp += 20; });
      this.hud.toast(r.ready ? `Class ${r.classes_attended}/${r.classes_required} done — you are ready for the exam! See admissions 🎓` : `Class ${r.classes_attended}/${r.classes_required} recorded ✓ Next one opens shortly.`, 5000);
      this.hud.emote('📚');
    }
    this.defaultObjective();
    this.refreshActions();
  }
  private async offering() {
    const amt = await this.hud.ask('Offering basket', 'Voluntary. The amount goes to the Grace Chapel account through the ledger.', 'Amount in G');
    if (!amt) return;
    const n = Number(amt.replace(/[^\d]/g, ''));
    const r = await this.society.churchOffer('grace-chapel', n);
    this.hud.toast(r.ok ? `You gave ${fmtG(n)} 🙏` : (r.message ?? 'Offering failed'));
    if (r.ok) { this.hud.emote('🙏'); this.store.update((st) => { st.stats.reputation += 1; }); }
  }

  /* ------------------------------------------------------------ driving */

  private enterVehicle(id: string) {
    if (this.jobs.active) { this.hud.toast('Finish or cancel your hustle first.'); return; }
    const d = this.vehicles.enter(id); if (!d) { this.hud.toast('That car is not here any more.'); return; }
    if (!this.act.enter('DRIVING')) { this.vehicles.exit(); this.hud.toast('Finish what you are doing first.'); return; }
    this.endConversation();
    this.avatar.root.visible = false;
    this.velocity.set(0, 0, 0);
    this.rig.dist = 9; this.rig.pitch = 0.32;
    this.activityLabel = `a ${d.view.name}`;
    this.pushActivityChip();
    this.hud.drive(true, 0, d.view.name);
    this.hud.toast('Push forward to drive, sideways to steer. Stop and press E (or PARK) to get out.', 4000);
    this.award('driver');
    this.refreshActions();
  }
  private leaveVehicle() {
    const d = this.vehicles.driving; if (!d) return;
    if (Math.abs(d.speed) > 0.6) { this.hud.toast('Stop the car first.'); return; }
    const out = this.vehicles.exit(); if (!out) return;
    this.act.endAll();
    this.activityLabel = '';
    this.pushActivityChip();
    this.avatar.root.visible = true;
    this.avatar.root.position.set(out.x, 0, out.z);
    this.yaw = out.yaw; this.avatar.root.rotation.y = this.yaw;
    this.activityLabel = '';
    this.hud.drive(false);
    void this.society.parkVehicle(out.view.id, out.view.x, out.view.z, out.view.yaw, 'city');
    const mine = this.myVeh.find((v) => v.id === out.view.id); if (mine) { mine.x = out.view.x; mine.z = out.view.z; mine.yaw = out.view.yaw; }
    this.hud.toast(`Parked. ${out.view.plate}`);
    this.refreshActions();
  }

  /* ------------------------------------------------------------- remotes */

  private syncRemotes(players: Map<string, RemoteState>) {
    for (const [id, st] of players) {
      let r = this.remotesMap.get(id);
      const key = JSON.stringify(st.appearance);
      if (!r) {
        const avatar = makeCharacter(st.appearance, 'hi');
        avatar.root.position.set(st.x, 0, st.z); avatar.root.visible = false;
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
    for (const r of this.remotesMap.values()) { if (r.state.area !== this.areaId || r.state.vehicle) continue; const d = r.avatar.root.position.distanceTo(pos); if (d < bd) { bd = d; best = r; } }
    return best;
  }
  /** Other players (and their cars) that NPC traffic must not drive into. */
  private remoteBlockers() {
    const out: { x: number; z: number; r: number }[] = [];
    for (const r of this.remotesMap.values()) if (r.state.area === 'city') out.push({ x: r.state.x, z: r.state.z, r: r.state.vehicle ? 2.2 : 0.6 });
    return out;
  }
  /** Smooth other citizens towards their last broadcast; show them only in the area we are in. */
  private updateRemotes(dt: number) {
    const now = performance.now();
    const cars: { id: string; model: string; color: string; x: number; z: number; yaw: number }[] = [];
    for (const r of this.remotesMap.values()) {
      const st = r.state;
      const sameArea = st.area === this.areaId;
      r.avatar.root.visible = sameArea && !st.vehicle;
      const target = new THREE.Vector3(st.x, st.pose === 'sit' ? 0.48 - (r.avatar.hipHeight ?? 0.86) : 0, st.z);
      const d = Math.hypot(r.avatar.root.position.x - target.x, r.avatar.root.position.z - target.z);
      if (d > 25) r.avatar.root.position.copy(target); else r.avatar.root.position.lerp(target, Math.min(1, dt * 8));
      let diff = st.yaw - r.avatar.root.rotation.y; while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
      r.avatar.root.rotation.y += diff * Math.min(1, dt * 10);
      r.avatar.setPose?.(st.pose === 'sit' ? 'sit' : 'none');
      r.avatar.animate(dt, d > 0.15 && st.pose === 'none' ? st.speed || 1 : 0);
      if (r.bubble && r.bubbleUntil && now > r.bubbleUntil) { r.avatar.root.remove(r.bubble); r.bubble = undefined; }
      if (st.vehicle && st.area === 'city' && this.areaId === 'city') cars.push({ id: st.id, model: st.vehicle.model, color: st.vehicle.color, x: r.avatar.root.position.x, z: r.avatar.root.position.z, yaw: r.avatar.root.rotation.y });
    }
    this.vehicles.syncRemote(cars);
  }

  /* --------------------------------------------------------------- loop */

  private resize() {
    this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  private frame() {
    // Real-time simulation down to ~4 fps: keep dt honest and substep the
    // physics instead of clamping into slow motion (that is what made walk /
    // drive feel wrong on slower devices).
    const dt = Math.min(this.clock.getDelta(), 0.25);
    const substeps = Math.max(1, Math.min(5, Math.ceil(dt / 0.05)));
    const subDt = dt / substeps;
    this.simSeconds += dt;
    const t = this.clock.elapsedTime;
    const pos = this.avatar.root.position;
    const scene = this.indoor ? this.scenes[this.areaId as Exclude<Area, 'city'>] : null;
    const colliders = scene ? scene.colliders : this.world.colliders.concat(this.vehicles.colliders(), this.traffic.colliders());
    const s = this.store.state;
    const driving = this.vehicles.driving;

    // needs
    if (needs.tick(s.needs, dt, !!this.sleeping)) this.hud.needs(s.needs);
    this.needsTimer += dt;
    if (this.needsTimer > 20) { this.needsTimer = 0; this.store.dirty = true; }
    if (this.sleeping) { this.hud.sleep(true, s.needs.energy); if (s.needs.energy >= 100) this.stopSleeping(true); }

    // activity state machine: timed sequences end themselves; hustles run as a WORKING overlay
    this.act.update();
    if (this.jobs.active && this.act.current !== 'WORKING' && this.act.canEnter('WORKING')) this.act.enter('WORKING');
    else if (!this.jobs.active && this.act.current === 'WORKING') this.act.end();
    this.pushActivityChip();
    if (this.myBubble && this.myBubbleUntil && performance.now() > this.myBubbleUntil) {
      this.avatar.root.remove(this.myBubble);
      this.myBubble = null;
    }

    // shared day/night + clock
    if (this.day.update(this.indoor)) { const c = fmtHour(this.day.state.hour); if (c !== this.lastClock) { this.lastClock = c; this.hud.clock(c, this.day.state.night); } }
    else if (!this.lastClock) { this.lastClock = fmtHour(this.day.state.hour); this.hud.clock(this.lastClock, this.day.state.night); }

    // lesson timer (classroom)
    if (this.lesson && this.seated) { this.lesson.t += dt; if (this.lesson.t >= LESSON_S) void this.finishLesson(); else if (Math.floor(this.lesson.t) !== Math.floor(this.lesson.t - dt)) this.hud.objective('In class', `Lesson in progress… ${Math.ceil(LESSON_S - this.lesson.t)} s`, true, '📚'); }

    // periodic refresh of the streets (other citizens' cars) — 45 s, never per-frame
    this.vehTimer += dt;
    if (this.vehTimer > 45 && !this.indoor) { this.vehTimer = 0; void this.refreshVehicles(); }

    // driving replaces walking
    if (driving) {
      const frozenD = this.hud.isOpen || this.busy;
      const ax = frozenD ? { x: 0, y: 0 } : this.input.axis();
      const statics = this.world.colliders.concat(this.vehicles.colliders());
      const others = this.traffic.circles().concat(this.vehicles.remoteCircles());
      let bumped = false;
      for (let i = 0; i < substeps; i++) {
        const r = this.vehicles.drive(subDt, ax, statics, this.world.bounds, others);
        if (r.bumped) bumped = true;
      }
      this.bumpCool -= dt;
      if (bumped && this.bumpCool <= 0) { this.bumpCool = 2; this.hud.toast('Oya, careful! 🚗💥'); this.store.update((st) => { st.stats.reputation = Math.max(0, st.stats.reputation - 1); }); }
      pos.set(driving.x, 0, driving.z); this.yaw = driving.yaw;
      this.hud.drive(true, Math.abs(driving.speed) * 3.6);
      const look = this.input.consumeLook(); this.rig.rotate(look.dx, look.dy); if (look.zoom) this.rig.zoom(look.zoom);
      this.traffic.update(dt, [{ x: driving.x, z: driving.z, r: handlingOf(driving.view.model_id).radius + 0.6 }, ...this.remoteBlockers()]);
      this.npcs.update(dt, pos);
      for (const fn of this.world.animated) fn(dt, t);
      this.hud.district(this.districtName(pos.x, pos.z));
      this.updateRemotes(dt);
      if (cloud.signedIn) cloud.broadcastPos(pos.x, pos.z, this.yaw, Math.abs(driving.speed) > 0.5 ? 2 : 0, false, 'none', 'city', { model: driving.view.model_id, color: driving.view.color }, this.activityString());
      if (this.store.dirty) { this.store.dirty = false; void cloud.save(this.store.state); this.pushPresence(); }
      if (this.currentActions.length !== 1) this.refreshActions();
      const so = this.day.sunOffset(); this.sun.position.set(pos.x + so.x, so.y, pos.z + so.z); this.sun.target.position.copy(pos); this.sun.target.updateMatrixWorld();
      for (const m of this.markers.children) if (m.visible) animateMarker(m as THREE.Group, t, m.userData.phase);
      this.rig.update(dt, pos, this.yaw, [], false);
      this.renderer.render(this.scene, this.camera);
      this.miniTimer += dt; if (this.miniTimer > 0.12) { this.miniTimer = 0; this.hud.drawMinimap(); }
      return;
    }

    // camera look
    const look = this.input.consumeLook();
    if (!this.rig.portrait) { this.rig.rotate(look.dx, look.dy); if (look.zoom) this.rig.zoom(look.zoom); }
    if (this.input.touch) this.hud.setTouch(true);

    // movement (camera-relative), frozen while a panel, a minigame, a seat or a bed holds the player
    const frozen = this.hud.isOpen || this.busy || this.sleeping || this.act.freezeMovement;
    const axis = frozen ? { x: 0, y: 0, mag: 0 } : this.input.axis();
    // walking away ends a conversation
    if (this.talking && axis.mag > 0.35) this.endConversation();
    if (this.seated && axis.mag > 0.4) this.stopSitting();
    const running = this.input.running && axis.mag > 0.6;
    const targetSpeed = this.seated ? 0 : axis.mag > 0.05 ? (running ? RUN : WALK) * Math.min(1, axis.mag * 1.2) * needs.speedFactor(s.needs) : 0;
    const fwd = this.rig.forward(), right = this.rig.right();
    const dir = new THREE.Vector3().addScaledVector(fwd, axis.y).addScaledVector(right, axis.x);
    if (dir.lengthSq() > 0) dir.normalize();
    const desired = dir.multiplyScalar(targetSpeed);
    if (!this.seated && !this.sleeping && (targetSpeed > 0.05 || this.velocity.lengthSq() > 0.002)) {
      const before = pos.clone();
      for (let i = 0; i < substeps; i++) {
        this.velocity.lerp(desired, Math.min(1, subDt * 10));
        pos.addScaledVector(this.velocity, subDt);
        if (!this.indoor) { pos.x = THREE.MathUtils.clamp(pos.x, -this.world.bounds, this.world.bounds); pos.z = THREE.MathUtils.clamp(pos.z, -this.world.bounds, this.world.bounds); }
        resolveCircle(pos, RADIUS, colliders);
      }
      this.walked += pos.distanceTo(before);
      if (this.walked > 12) this.award('first-steps');
      const targetYaw = Math.atan2(this.velocity.x, this.velocity.z);
      let diff = targetYaw - this.yaw; while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
      this.yaw += diff * Math.min(1, dt * 12);
      this.avatar.root.rotation.y = this.yaw;
    }
    const speed = this.seated || this.sleeping ? 0 : this.velocity.length();
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
    this.act.locomotion(speed, speed > (WALK + RUN) / 2);

    // zones → contextual actions
    const zones = scene ? scene.zones : this.world.zones;
    let best: Zone | null = null, bd = Infinity;
    for (const z of zones) { const d = Math.hypot(pos.x - z.x, pos.z - z.z); if (d < z.radius && d < bd) { bd = d; best = z; } }
    if (!this.indoor) {
      const rp = this.nearestRemote(pos, 2.4);
      const veh = this.vehicles.nearest(pos.x, pos.z, 3.4);
      if (rp && (!best || bd > 1.2)) best = { id: 'player', label: rp.state.name, icon: '🧑', x: rp.avatar.root.position.x, z: rp.avatar.root.position.z, radius: 2.4, prompt: `Greet ${rp.state.name}`, data: { remote: rp } as any };
      else if (veh && (!best || bd > 1.5)) best = { id: 'vehicle', label: `${veh.name} · ${veh.plate}`, icon: '🚗', x: veh.x, z: veh.z, radius: 3.4, prompt: veh.mine ? 'Your car' : `${veh.owner_name ?? 'A citizen'}'s car`, data: { vehicle: veh } as any };
      else if (!best) { const npc = this.npcs.nearest(pos, 2.2); if (npc) best = { id: 'npc', label: npc.name, icon: '💬', x: npc.avatar.root.position.x, z: npc.avatar.root.position.z, radius: 2.2, prompt: `Gist with ${npc.name}` }; }
    }
    if (best !== this.currentZone && (best?.id !== this.currentZone?.id || best?.label !== this.currentZone?.label || best?.x !== this.currentZone?.x)) { this.currentZone = best; this.refreshActions(); }
    else if (this.seated || this.sleeping) { if (this.currentActions.length !== 1) this.refreshActions(); }

    // world life
    if (!this.indoor) {
      this.npcs.update(dt, pos);
      void this.jobs.update(dt, pos, t);
      for (const fn of this.world.animated) fn(dt, t);
      this.traffic.update(dt, [{ x: pos.x, z: pos.z, r: 0.6 }, ...this.remoteBlockers()]);
      this.hud.district(this.districtName(pos.x, pos.z));
    } else if (scene?.animated) for (const fn of scene.animated) fn(dt, t);
    for (const m of this.markers.children) if (m.visible) animateMarker(m as THREE.Group, t, m.userData.phase);

    // remote players
    this.updateRemotes(dt);
    if (cloud.signedIn) cloud.broadcastPos(pos.x, pos.z, this.yaw, speed < 0.1 ? 0 : speed > (WALK + RUN) / 2 ? 2 : 1, this.indoor, this.pose, this.areaId, null, this.activityString());
    if (this.store.dirty) { this.store.dirty = false; void cloud.save(this.store.state); this.pushPresence(); }

    // sun follows the player so the shadow map stays sharp; direction from the shared clock
    const so = this.day.sunOffset();
    this.sun.position.set(pos.x + so.x, so.y, pos.z + so.z);
    this.sun.target.position.copy(pos); this.sun.target.updateMatrixWorld();

    // camera
    this.rig.update(dt, pos, this.yaw, colliders, this.indoor);
    this.renderer.render(this.scene, this.camera);

    this.miniTimer += dt;
    if (this.miniTimer > 0.12) { this.miniTimer = 0; this.hud.drawMinimap(); }
  }

  private districtName(x: number, z: number) {
    if (Math.hypot(x, z) < 10) return 'GISTCITY · ROUNDABOUT';
    if (z < -56) return x < 0 ? 'CIVIC RING · SECRETARIAT' : 'CIVIC RING · HOSPITAL';
    if (z > 56) return x < 0 ? 'CIVIC RING · GRACE CHAPEL' : 'CIVIC RING · UNITY PARK';
    if (x < -56) return z < 0 ? 'CIVIC RING · UNITY COLLEGE' : 'CIVIC RING · IRON TEMPLE';
    if (x > 56) return z < 0 ? 'CIVIC RING · ODOGWU MOTORS' : 'CIVIC RING · BANK (SOON)';
    if (x < 0 && z < 0) return 'GISTCITY · MARKET';
    if (x >= 0 && z < 0) return 'GIST HEIGHTS · RESIDENTIAL';
    if (x < 0 && z >= 0) return 'OLD ROAD · FOOD & NIGHTLIFE';
    return 'THE PITCH · SOUTH-EAST';
  }
}
