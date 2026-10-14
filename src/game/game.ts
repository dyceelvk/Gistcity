/**
 * The game: renderer, world, player controller, interactions, jobs, NPCs,
 * apartment, cloud sync and the HUD glue.
 */
import * as THREE from 'three';
import { Avatar } from './avatar';
import { CameraRig } from './camera';
import { Input } from './input';
import { resolveCircle } from './physics';
import { buildWorld, buildSky, type World, type Zone } from './world';
import { buildInterior, type Interior } from './interior';
import { NpcManager, GIST_LINES } from './npc';
import { JobSystem, makeMarker, animateMarker, type JobId } from './jobs';
import { Store, loadLocal, defaultState, ACHIEVEMENTS, type PlayerState } from './state';
import { Hud, type HudHost } from '../ui/hud';
import { cloud, type RemoteState } from '../net/supabase';
import { makeSprite } from './props';

const WALK = 3.3, RUN = 6.4, RADIUS = 0.38;

interface Remote { avatar: Avatar; state: RemoteState; tag: THREE.Sprite; appearanceKey: string }

export class Game implements HudHost {
  store: Store;
  world: World;
  interior: Interior;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private rig: CameraRig;
  private input: Input;
  private hud: Hud;
  private clock = new THREE.Clock();
  private avatar: Avatar;
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
  private walked = 0;
  private greeted = new Set<string>();
  private remotesMap = new Map<string, Remote>();
  private remoteLayer = new THREE.Group();
  private miniTimer = 0;
  private camPreset = 1;
  private lastPresence = '';
  private busy = false;

  constructor(host: HTMLElement) {
    this.store = new Store(loadLocal());

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

    // world
    this.world = buildWorld();
    this.scene.add(this.world.group);
    buildSky(this.scene, this.world.animated);
    this.interior = buildInterior();
    this.scene.add(this.interior.group);
    this.scene.add(this.markers, this.jobLayer, this.remoteLayer);
    for (const z of this.world.zones) { const m = makeMarker(z.icon); m.position.set(z.x, 0, z.z); m.userData.phase = z.x; this.markers.add(m); }
    for (const z of this.interior.zones) { const m = makeMarker(z.icon, '#f5c242'); m.position.set(z.x, 0, z.z); m.userData.phase = z.z; m.userData.indoor = true; m.visible = false; this.markers.add(m); }

    // player
    this.avatar = new Avatar(this.store.state.appearance);
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
    this.hud.onInteract = () => this.interact();
    this.input.onInteract = () => { if (!this.hud.isOpen) this.interact(); };
    this.input.onEscape = () => this.hud.closeAll();
    this.input.onToggleRun = () => this.hud.setRun(this.input.runToggle);
    document.getElementById('runBtn')!.addEventListener('click', () => { this.input.runToggle = !this.input.runToggle; this.hud.setRun(this.input.runToggle); });

    this.jobs = new JobSystem(this.world, this.jobLayer, {
      toast: (m) => this.hud.toast(m),
      reward: (cash, xp, hustle) => this.reward(cash, xp, hustle),
      objective: (t, x) => this.hud.objective(t, x, true, '💼'),
      clearObjective: () => this.defaultObjective(),
      timing: (r, t, ok, fail) => this.runMinigame(r, t, ok, fail),
      changed: () => this.store.update(() => { /* re-render */ }),
    });

    // cloud
    cloud.onCloudState = (s) => { this.store.replace(s); this.applyAppearance(); this.refreshFurniture(); this.hud.toast('Progress loaded from the cloud ☁️'); };
    cloud.onRemote = (players) => this.syncRemotes(players);
    cloud.onStatus = ((orig) => (st) => { orig?.(st); if (st === 'signed-in') cloud.joinCity(() => ({ name: this.store.state.name, appearance: this.store.state.appearance })); })(cloud.onStatus);
    cloud.installBridge();
    void cloud.init(this.store.state);

    (window as any).__gist = this;
    window.addEventListener('resize', () => this.resize());
    this.defaultObjective();
    this.hud.loaded();

    if (!localStorage.getItem('gist_onboarded')) {
      localStorage.setItem('gist_onboarded', '1');
      setTimeout(() => { this.hud.open('style'); this.hud.toast('Welcome to GIST! Create your GistCitizen ✦', 4000); }, 600);
    }
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /* ----------------------------------------------------------- HudHost */

  applyAppearance() {
    const pos = this.avatar.root.position.clone(), rot = this.avatar.root.rotation.y;
    this.avatar.setAppearance(this.store.state.appearance);
    this.avatar.root.position.copy(pos); this.avatar.root.rotation.y = rot;
    this.pushPresence();
  }
  setPortrait(on: boolean) { this.rig.portrait = on; }
  player() { const p = this.avatar.root.position; return { x: p.x, z: p.z, yaw: this.yaw }; }
  jobTarget() { return this.indoor ? null : this.jobs.target(); }
  activeJob(): JobId | null { return this.jobs.active?.id ?? null; }
  startJob(id: JobId) { if (this.indoor) return; this.jobs.start(id, this.avatar.root.position); }
  cancelJob() { this.jobs.cancel(); }
  isIndoor() { return this.indoor; }
  refreshFurniture() { this.interior.setFurniture(this.store.state.apartment); }
  cycleCamera() { this.camPreset = (this.camPreset + 1) % 3; this.rig.dist = [4.5, 6.5, 9.5][this.camPreset]; this.hud.toast(['Close camera', 'Standard camera', 'Wide camera'][this.camPreset]); }
  resetSave() {
    localStorage.removeItem('gist_save_v1');
    this.store.replace(defaultState());
    this.applyAppearance(); this.refreshFurniture();
    void cloud.save(this.store.state, true);
    this.hud.closeAll(); this.hud.toast('Fresh start. Welcome back to Gist City.');
  }
  remotes() { return [...this.remotesMap.values()].filter((r) => !r.state.indoor).map((r) => ({ x: r.avatar.root.position.x, z: r.avatar.root.position.z, name: r.state.name })); }
  award(id: string) {
    const a = ACHIEVEMENTS[id]; if (!a || this.store.state.achievements.includes(id)) return;
    this.store.update((s) => { s.achievements.push(id); s.stats.xp += 25; });
    setTimeout(() => this.hud.toast(`🏅 Achievement: ${a.title}`, 3500), 900);
  }

  /* ------------------------------------------------------------ helpers */

  private defaultObjective() {
    const s = this.store.state;
    if (this.indoor) this.hud.objective('Home sweet home', 'Decorate, change your look at the wardrobe, or head back out.', false, '🏠');
    else if (s.jobsDone === 0) this.hud.objective('Make your first move', 'Find the Hustle Hub (💼, by the roundabout) and take a job to earn Gist Cash.', false, '✦');
    else if (s.inventory.length === 0) this.hud.objective('Dress the part', 'GIST Fits (👕, north-west of the roundabout) has fits for every vibe.', false, '✦');
    else this.hud.objective('Live your Gist Life', 'Hustle, shop, pull up at the lounge, decorate your flat, gist with people.', false, '✦');
  }
  private reward(cash: number, xp: number, hustle: number) {
    this.store.update((s) => { s.cash += cash; s.stats.xp += xp; s.stats.hustle += hustle; if (hustle > 0) s.jobsDone++; });
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
    void cloud.updatePresence(s.name, s.appearance);
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

  /* ------------------------------------------------------- interactions */

  private interact() {
    if (this.busy) return;
    const z = this.currentZone;
    const pos = this.avatar.root.position;
    if (!z) {
      // gist with a nearby person
      const npc = this.indoor ? null : this.npcs.nearest(pos, 2.2);
      if (npc) { this.gistWith(npc); return; }
      this.hud.toast('Walk up to a glowing marker or a person, then interact.');
      return;
    }
    const s = this.store.state;
    const spend = (amount: number, fn: (st: PlayerState) => void, msg: string) => {
      if (s.cash < amount) { this.hud.toast(`You need ${'₦' + amount.toLocaleString()} for that. Go hustle small!`); return; }
      this.store.update((st) => { st.cash -= amount; fn(st); }); this.hud.toast(msg);
    };
    switch (z.id) {
      case 'npc': { const npc = this.npcs.nearest(pos, 2.4); if (npc) this.gistWith(npc); break; }
      case 'store': this.visit('store'); this.hud.open('store'); break;
      case 'jobs': this.visit('jobs'); this.hud.open('jobs'); break;
      case 'home': this.visit('home'); this.enterApartment(); break;
      case 'exit': this.exitApartment(); break;
      case 'wardrobe': this.hud.open('style'); break;
      case 'decor': this.hud.open('home'); break;
      case 'suya': this.visit('suya'); spend(500, (st) => { st.stats.popularity += 2; st.stats.xp += 8; }, 'Suya with plenty pepper 🌶️ +2 popularity'); break;
      case 'buka': this.visit('buka'); spend(800, (st) => { st.stats.reputation += 1; st.stats.xp += 10; }, 'Jollof, plantain and a cold drink. +1 reputation'); break;
      case 'lounge': this.visit('lounge'); spend(1500, (st) => { st.stats.popularity += 5; st.stats.xp += 15; }, 'You pulled up and the DJ noticed 🪩 +5 popularity'); break;
      case 'pos': if (this.jobs.active?.id !== 'pos') this.jobs.start('pos', pos); break;
      case 'pitch': {
        this.visit('pitch');
        void this.runMinigame(5, 'Penalty shootout — tap in the green zone to score', 'GOAL! ⚽', 'Saved by the keeper 🧤').then((goals) => {
          this.store.update((st) => { st.stats.reputation += goals * 2; st.cash += goals * 200; st.stats.xp += goals * 10; });
          this.hud.toast(goals === 5 ? 'Five out of five! The whole pitch is screaming your name 🔥' : `${goals}/5 goals · +${goals * 2} reputation · ₦${(goals * 200).toLocaleString()} side bets`);
        });
        break;
      }
    }
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
        const avatar = new Avatar(st.appearance);
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
    for (const [id, r] of this.remotesMap) if (!players.has(id)) { this.remoteLayer.remove(r.avatar.root); this.remotesMap.delete(id); }
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

    // camera look
    const look = this.input.consumeLook();
    if (!this.rig.portrait) { this.rig.rotate(look.dx, look.dy); if (look.zoom) this.rig.zoom(look.zoom); }
    if (this.input.touch) this.hud.setTouch(true);

    // movement (camera-relative), frozen while a panel or minigame is up
    const axis = this.hud.isOpen || this.busy ? { x: 0, y: 0, mag: 0 } : this.input.axis();
    const running = this.input.running && axis.mag > 0.6;
    const targetSpeed = axis.mag > 0.05 ? (running ? RUN : WALK) * Math.min(1, axis.mag * 1.2) : 0;
    const fwd = this.rig.forward(), right = this.rig.right();
    const dir = new THREE.Vector3().addScaledVector(fwd, axis.y).addScaledVector(right, axis.x);
    if (dir.lengthSq() > 0) dir.normalize();
    const desired = dir.multiplyScalar(targetSpeed);
    this.velocity.lerp(desired, Math.min(1, dt * 10));
    const speed = this.velocity.length();
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
    this.avatar.animate(dt, speed < 0.1 ? 0 : speed > (WALK + RUN) / 2 ? 2 : 1);

    // zones
    const zones = this.indoor ? this.interior.zones : this.world.zones;
    let best: Zone | null = null, bd = Infinity;
    for (const z of zones) { const d = Math.hypot(pos.x - z.x, pos.z - z.z); if (d < z.radius && d < bd) { bd = d; best = z; } }
    if (!best && !this.indoor) {
      const npc = this.npcs.nearest(pos, 2.2);
      if (npc) best = { id: 'npc', label: npc.name, icon: '💬', x: npc.avatar.root.position.x, z: npc.avatar.root.position.z, radius: 2.2, prompt: `Gist with ${npc.name}` };
    }
    if (best?.id !== this.currentZone?.id || best?.label !== this.currentZone?.label) { this.currentZone = best; this.hud.zone(best); }

    // world life
    if (!this.indoor) {
      this.npcs.update(dt, pos);
      void this.jobs.update(dt, pos, t);
      for (const fn of this.world.animated) fn(dt, t);
      this.hud.district(this.districtName(pos.x, pos.z));
    }
    for (const m of this.markers.children) if (m.visible) animateMarker(m as THREE.Group, t, m.userData.phase);

    // remote players
    for (const r of this.remotesMap.values()) {
      const st = r.state;
      r.avatar.root.visible = !st.indoor && !this.indoor;
      const target = new THREE.Vector3(st.x, 0, st.z);
      const d = r.avatar.root.position.distanceTo(target);
      if (d > 25) r.avatar.root.position.copy(target); else r.avatar.root.position.lerp(target, Math.min(1, dt * 8));
      let diff = st.yaw - r.avatar.root.rotation.y; while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
      r.avatar.root.rotation.y += diff * Math.min(1, dt * 10);
      r.avatar.animate(dt, d > 0.15 ? st.speed || 1 : 0);
    }
    if (cloud.status === 'signed-in') cloud.broadcastPos(pos.x, pos.z, this.yaw, speed < 0.1 ? 0 : speed > (WALK + RUN) / 2 ? 2 : 1, this.indoor);
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
    if (Math.hypot(x, z) < 10) return 'GIST CITY · ROUNDABOUT';
    if (Math.abs(x) > 56 || Math.abs(z) > 56) return 'GIST CITY · OUTSKIRTS';
    if (x < 0 && z < 0) return 'GIST CITY · MARKET';
    if (x >= 0 && z < 0) return 'GIST HEIGHTS · RESIDENTIAL';
    if (x < 0 && z >= 0) return 'OLD ROAD · FOOD & NIGHTLIFE';
    return 'THE PITCH · SOUTH-EAST';
  }
}
