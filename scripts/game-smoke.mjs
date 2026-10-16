/**
 * GISTCITY gameplay smoke test — headless Chromium.
 *
 * Boots the game in practice mode and drives real gameplay flows:
 * movement & animation, collisions, sitting, eating/drinking sequences,
 * sleeping, vehicle enter/drive/park, NPC conversations with responses,
 * the changing room, activity-state invariants, citizen pages with media,
 * and private DMs with real replies.
 *
 * Run:  node scripts/game-smoke.mjs [baseUrl]
 * Needs: puppeteer-core + @sparticuz/chromium (dev-only, not shipped):
 *        npm i --no-save puppeteer-core @sparticuz/chromium
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173/';
const SHOTS = process.env.SHOTS ?? '/home/user/gist-shots';

/**
 * Headless chromium needs libnss3/libnspr4, which minimal containers lack.
 * @sparticuz/chromium ships those in al2023.tar.br — extract them and preload
 * via LD_LIBRARY_PATH so the test runs without system packages.
 */
function ensureNssLibs() {
  try {
    execSync('ldconfig -p 2>/dev/null | grep -q libnss3.so', { stdio: 'ignore' });
    return; // system NSS is present
  } catch { /* fall through */ }
  const require = createRequire(import.meta.url);
  // the package's exports map hides package.json — walk up from the main entry
  let dir = join(require.resolve('@sparticuz/chromium'), '..');
  let archive = join(dir, 'bin', 'al2023.tar.br');
  while (dir !== '/' && !existsSync(archive)) { dir = join(dir, '..'); archive = join(dir, 'bin', 'al2023.tar.br'); }
  const out = join(tmpdir(), 'gist-nss-libs');
  const probe = join(out, 'lib', 'libnss3.so');
  if (!existsSync(probe)) {
    mkdirSync(out, { recursive: true });
    const tar = zlib.brotliDecompressSync(require('fs').readFileSync(archive));
    const tarPath = join(out, 'al2023.tar');
    writeFileSync(tarPath, tar);
    execSync(`tar -xf ${tarPath} -C ${out}`, { stdio: 'ignore' });
  }
  process.env.LD_LIBRARY_PATH = `${join(out, 'lib')}${process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''}`;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  ensureNssLibs();
  const puppeteer = (await import('puppeteer-core')).default;
  const chromiumMod = await import('@sparticuz/chromium');
  const chromium = chromiumMod.default ?? chromiumMod;

  const browser = await puppeteer.launch({
    executablePath: await chromium.executablePath(),
    args: [...chromium.args, '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console.error:', m.text()); });
  page.on('dialog', (d) => void d.accept()); // confirm() dialogs in the game (block, delete…)

  // Fresh practice profile: onboarded, a named citizen, driver's licence in the local society save.
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('gist_onboarded', '1');
    localStorage.setItem('gist_save_v1', JSON.stringify({
      name: 'Testero', username: 'testero', cash: 500000, createdAt: Date.now(),
      appearance: undefined, // defaults
    }));
    localStorage.setItem('gist_society_v1', JSON.stringify({
      certificates: [{ id: 'c1', course_id: 'drivers-licence', title: "GistCity Driver's Licence", grade: 'A', score: 90, serial: 'GC-TEST', issued_at: new Date().toISOString() }],
    }));
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__gist && window.__gist.avatar, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 2500)); // let the world settle

  const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
  /** Wait until the game's simulated clock advances by `seconds` (robust at any frame rate). */
  const sim = (seconds) => page.evaluate((s) => new Promise((resolve) => {
    const g = window.__gist;
    const t0 = g.simSeconds;
    const start = performance.now();
    const tick = () => {
      const done = g.simSeconds - t0 >= s || performance.now() - start > 120000;
      if (done) resolve(g.simSeconds - t0);
      else requestAnimationFrame(tick);
    };
    tick();
  }), seconds).then(() => undefined);

  /* ---------------------------------------------------------- boot */
  const boot = await page.evaluate(() => ({
    avatar: window.__gist.avatar.constructor.name,
    hasWebGL: !!document.querySelector('canvas'),
    cash: window.__gist.store.state.cash,
    name: window.__gist.store.state.name,
  }));
  check('game boots with a 3D avatar', boot.avatar === 'Human' || boot.avatar === 'Avatar', `renderer=${boot.avatar}`);
  check('realistic MakeHuman character loaded', boot.avatar === 'Human', `avatar class ${boot.avatar}`);
  check('practice wallet seeded', boot.cash === 500000, `cash=${boot.cash}`);

  /* ------------------------------------------------------ walking */
  const p0 = await page.evaluate(() => { const p = window.__gist.avatar.root.position; return { x: p.x, z: p.z }; });
  await page.keyboard.down('KeyW');
  await sim(1.2);
  const walk = await page.evaluate(() => {
    const g = window.__gist, p = g.avatar.root.position;
    return {
      x: p.x, z: p.z,
      act: g.act.current,
      vel: g.velocity.length(),
      walkWeight: g.avatar.weights ? g.avatar.weights.walk : -1,
      idleWeight: g.avatar.weights ? g.avatar.weights.idle : -1,
    };
  });
  await page.keyboard.up('KeyW');
  const moved = Math.hypot(walk.x - p0.x, walk.z - p0.z);
  check('character walks at human pace when W is held', moved > 1.5 && walk.vel > 2.5, `moved ${moved.toFixed(2)} m, speed ${walk.vel.toFixed(2)} m/s in 1.2 sim-s`);
  check('walking sets WALKING state', walk.act === 'WALKING', `state=${walk.act}`);
  check('walk animation plays while moving', walk.walkWeight > 0.4, `walk weight=${walk.walkWeight.toFixed(2)}`);
  await shot('01-walking');

  /* ------------------------------------------------------ running */
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await sim(1.4);
  const run = await page.evaluate(() => {
    const g = window.__gist;
    return { act: g.act.current, runWeight: g.avatar.weights ? g.avatar.weights.run : -1 };
  });
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  check('shift+W runs', run.act === 'RUNNING', `state=${run.act}`);
  check('run animation plays', run.runWeight > 0.4, `run weight=${run.runWeight.toFixed(2)}`);
  await shot('02-running');

  /* -------------------------------------------------- stop & idle */
  await sim(1.2);
  const idle = await page.evaluate(() => {
    const g = window.__gist;
    return { act: g.act.current, idleWeight: g.avatar.weights ? g.avatar.weights.idle : -1, speed: g.velocity ? g.velocity.length() : -1 };
  });
  check('character stops and returns to IDLE', idle.act === 'IDLE' && idle.speed < 0.15, `state=${idle.act} v=${idle.speed.toFixed(2)}`);
  check('idle animation plays when still', idle.idleWeight > 0.7, `idle weight=${idle.idleWeight.toFixed(2)}`);

  /* --------------------------------------------------- collisions */
  const overlap = await page.evaluate(async () => {
    const g = window.__gist;
    const R = 0.38;
    const cols = g.world.colliders;
    const overlaps = (p) => cols.some((b) => {
      const nx = Math.max(b.minX, Math.min(p.x, b.maxX)), nz = Math.max(b.minZ, Math.min(p.z, b.maxZ));
      return (p.x - nx) ** 2 + (p.z - nz) ** 2 < R * R * 0.9;
    });
    // walk straight at the GIST monument / roundabout furniture for 4 s of frames
    const start = g.avatar.root.position.clone();
    let worst = 0, saw = 0;
    for (let i = 0; i < 60; i++) {
      g.avatar.root.position.z -= 0.12; // push into the city centre colliders
      g.avatar.root.position.x += 0.02;
      const p = g.avatar.root.position;
      if (overlaps(p)) saw++;
      worst = Math.max(worst, p.distanceTo(start));
    }
    g.avatar.root.position.copy(start);
    return { overlapFrames: saw };
  });
  check('characters do not pass through solid objects', overlap.overlapFrames === 0, `overlap frames=${overlap.overlapFrames}`);

  /* ------------------------------------------------- sit & stand */
  const sit = await page.evaluate(async () => {
    const g = window.__gist;
    const zone = g.world.zones.find((z) => z.id === 'seat' && z.data?.seats?.length);
    if (!zone) return { err: 'no seat zone' };
    g.avatar.root.position.set(zone.x + 1.2, 0, zone.z + 1.2);
    g.currentZone = zone;
    g.refreshActions();
    const acts = g.currentActions;
    const sitAct = acts.find((a) => /sit/i.test(a.label) && !a.disabled);
    if (!sitAct) return { err: 'no sit action', labels: acts.map((a) => a.label) };
    sitAct.run();
    await new Promise((r) => setTimeout(r, 700));
    const seated = { act: g.act.current, pose: g.pose, seated: !!g.seated };
    g.stopSitting();
    await new Promise((r) => setTimeout(r, 400));
    return { ...seated, after: g.act.current };
  });
  check('sit action seats the character (SITTING)', sit.act === 'SITTING' && !!sit.seated, JSON.stringify(sit));
  check('sitting applies the sit pose', sit.pose === 'sit', `pose=${sit.pose}`);
  check('standing up returns to IDLE', sit.after === 'IDLE', `after=${sit.after}`);

  /* --------------------------------------------------- eating */
  const eat = await page.evaluate(async () => {
    const g = window.__gist;
    const zone = g.world.zones.find((z) => z.id === 'suya');
    if (!zone) return { err: 'no suya zone' };
    g.avatar.root.position.set(zone.x + 1.0, 0, zone.z + 1.0);
    g.currentZone = zone;
    g.refreshActions();
    const order = g.currentActions.find((a) => /suya|meat|shawarma/i.test(a.label) && !a.disabled);
    if (!order) return { err: 'no order', labels: g.currentActions.map((a) => a.label) };
    const cashBefore = g.store.state.cash, hungerBefore = g.store.state.needs.hunger;
    order.run();
    await new Promise((r) => setTimeout(r, 900));
    const during = g.act.current;
    await new Promise((r) => setTimeout(r, 3600));
    return {
      during,
      after: g.act.current,
      cashBefore, cashAfter: g.store.state.cash,
      hungerBefore, hungerAfter: g.store.state.needs.hunger,
    };
  });
  check('eating runs an EATING sequence', eat.during === 'EATING', `during=${eat.during}`);
  check('eating finishes back to IDLE', eat.after === 'IDLE' || eat.after === 'SITTING', `after=${eat.after}`);
  check('food costs money (server rules)', eat.cashAfter < eat.cashBefore, `cash ${eat.cashBefore}→${eat.cashAfter}`);
  check('food restores hunger', eat.hungerAfter > eat.hungerBefore, `hunger ${eat.hungerBefore?.toFixed(0)}→${eat.hungerAfter?.toFixed(0)}`);

  /* -------------------------------------------------- drinking */
  const drink = await page.evaluate(async () => {
    const g = window.__gist;
    const zone = g.world.zones.find((z) => z.id === 'suya' || z.id === 'buka' || z.id === 'lounge');
    g.avatar.root.position.set(zone.x + 1.0, 0, zone.z + 1.0);
    g.currentZone = zone;
    g.refreshActions();
    const order = g.currentActions.find((a) => /water|zobo|drink|malt|juice/i.test(a.label) && !a.disabled);
    if (!order) return { err: 'no drink', labels: g.currentActions.map((a) => a.label) };
    order.run();
    await new Promise((r) => setTimeout(r, 700));
    const during = g.act.current;
    await new Promise((r) => setTimeout(r, 3000));
    return { during, after: g.act.current };
  });
  check('drinking runs a DRINKING sequence', drink.during === 'DRINKING', `during=${drink.during} err=${drink.err ?? ''}`);
  await shot('03-eating');

  /* ---------------------------------------------------- sleeping */
  const sleep = await page.evaluate(async () => {
    const g = window.__gist;
    const simWait = (s) => new Promise((res) => {
      const t0 = g.simSeconds, st = performance.now();
      const tick = () => (g.simSeconds - t0 >= s || performance.now() - st > 120000) ? res() : requestAnimationFrame(tick);
      tick();
    });
    g.enterApartment();
    await simWait(0.3);
    const zone = g.scenes.home.zones.find((z) => z.id === 'bed');
    if (!zone) return { err: 'no bed' };
    g.avatar.root.position.set(zone.x + 0.8, 0, zone.z + 1.2);
    g.currentZone = zone;
    g.refreshActions();
    const act = g.currentActions.find((a) => /sleep|lie/i.test(a.label));
    if (!act) return { err: 'no sleep action', labels: g.currentActions.map((a) => a.label) };
    g.store.state.needs.energy = 40;
    act.run();
    await simWait(0.5);
    const during = { act: g.act.current, pose: g.pose, sleeping: !!g.sleeping };
    const e0 = g.store.state.needs.energy;
    await simWait(2);
    const e1 = g.store.state.needs.energy;
    // try to walk while asleep — must not move
    const p0 = { x: g.avatar.root.position.x, z: g.avatar.root.position.z };
    g.velocity.set(0, 5, 0);
    await simWait(0.4);
    const p1 = { x: g.avatar.root.position.x, z: g.avatar.root.position.z };
    g.stopSleeping(false);
    await simWait(0.3);
    return { ...during, e0, e1, moved: Math.hypot(p1.x - p0.x, p1.z - p0.z), after: g.act.current };
  });
  check('bed action puts the character to sleep', sleep.act === 'SLEEPING' && !!sleep.sleeping, JSON.stringify({ act: sleep.act, sleeping: sleep.sleeping }));
  check('lying pose while asleep', sleep.pose === 'sleep', `pose=${sleep.pose}`);
  check('energy recovers while sleeping', sleep.e1 > sleep.e0, `energy ${sleep.e0?.toFixed(0)}→${sleep.e1?.toFixed(0)}`);
  check('no walking while sleeping', sleep.moved < 0.01, `moved ${sleep.moved}`);
  check('waking returns to IDLE', sleep.after === 'IDLE', `after=${sleep.after}`);
  await shot('04-sleeping');

  /* --------------------------------------------------- vehicle */
  const car = await page.evaluate(async () => {
    const g = window.__gist;
    g.exitApartment();
    await new Promise((r) => setTimeout(r, 300));
    const hadStarter = g.myVeh.length;
    const buy = await g.society.buyVehicle('toks-corolla', '#2c3e50', 58, -33, 0);
    if (!buy.ok) return { err: buy.message ?? 'buy failed' };
    await g.refreshVehicles();
    const v = g.myVeh.find((q) => q.id === buy.vehicle?.id) ?? g.myVeh[g.myVeh.length - 1];
    if (!v) return { err: 'vehicle not in garage' };
    g.enterVehicle(v.id);
    await new Promise((r) => setTimeout(r, 500));
    const driving = { act: g.act.current, driving: !!g.vehicles.driving, avatarHidden: !g.avatar.root.visible };
    // drive forward
    g.input.keys.add('w');
    const simWait = (s) => new Promise((res) => {
      const t0 = g.simSeconds, st = performance.now();
      const tick = () => (g.simSeconds - t0 >= s || performance.now() - st > 120000) ? res() : requestAnimationFrame(tick);
      tick();
    });
    await simWait(2);
    const d = g.vehicles.driving;
    const moved = d ? Math.hypot(d.x - 58, d.z + 33) : 0;
    const speed = d?.speed ?? 0;
    g.input.keys.delete('w');
    await simWait(2.5); // roll to a stop
    const stopped = Math.abs(g.vehicles.driving?.speed ?? 99) < 0.6;
    const vId = g.vehicles.driving.view.id;
    g.leaveVehicle();
    await simWait(0.3);
    const p = g.vehicles.parked.get(vId)?.view;
    return {
      ...driving, moved, speed, stopped, hadStarter,
      after: g.act.current,
      stillMine: g.myVeh.some((q) => q.id === v.id),
      parked: p ? { x: p.x, z: p.z } : null,
      movedFromBuy: p ? Math.hypot(p.x - 58, p.z + 33) : 0,
    };
  });
  check('starter car granted on arrival (one test car)', car.hadStarter >= 1, `myVeh before buying=${car.hadStarter}`);
  check('buying a vehicle places it in the garage', !!car.stillMine && !car.err, car.err ?? `vehicles=${car.stillMine}`);
  check('entering a vehicle sets DRIVING', car.act === 'DRIVING' && !!car.driving, `act=${car.act}`);
  check('avatar is hidden while driving (sitting in the car)', car.avatarHidden === true, `hidden=${car.avatarHidden}`);
  check('throttle accelerates the car', car.speed > 1.2, `speed=${car.speed?.toFixed(2)} m/s, moved ${car.moved?.toFixed(1)} m`);
  check('car must stop before exit', car.stopped === true, `stopped=${car.stopped}`);
  check('parking persists the vehicle where it stopped', car.after === 'IDLE' && car.movedFromBuy > 1, JSON.stringify(car.parked));
  await shot('05-driving');

  /* ------------------------------------- QuickCash POS (the real flow) + map */
  const extra = await page.evaluate(async () => {
    const g = window.__gist;
    const out = {};
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    // apply → pending
    g.posApply();
    out.applied = g.store.state.posApp?.status ?? null;
    // approval (normally the stand answers after ~20 s)
    g.store.update((s) => { s.posApp = { status: 'approved', at: Date.now() }; });
    out.approved = g.store.state.posApp?.status ?? null;
    // start a shift: the shop camera takes over and the player steps behind the counter
    g.startPosShift();
    await wait(500);
    out.shiftActive = !!g.pos?.active;
    out.shopCam = !!g.rig.fixed;
    out.serveSpot = Math.hypot(g.avatar.root.position.x - (-20.9), g.avatar.root.position.z - (-10.1)) < 1.6;
    const waitForChoice = async (ms) => {
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        if (document.querySelector('#dlgChoices .dlgChoice')) return true;
        await new Promise((r) => setTimeout(r, 150));
      }
      return false;
    };
    // customer walks up and names their amount
    out.gotAsk1 = await waitForChoice(22000);
    const cash0 = g.store.state.cash;
    if (out.gotAsk1) {
      g.hud.onDialogueChoice(0); // "Ask: withdraw or transfer?"
      await wait(300);
      out.gotAsk2 = await waitForChoice(8000);
      if (out.gotAsk2) {
        g.hud.onDialogueChoice(0); // "Count cash & approve · take the fee"
        await wait(1800); // terminal processing beat
      }
    }
    out.served = g.pos ? g.pos.served : -1;
    out.fee = g.store.state.cash - cash0;
    out.methodLine = (document.querySelector('#dlgLine')?.textContent ?? '').includes('Thank');
    g.endPosShift();
    out.camReleased = !g.rig.fixed;
    out.shiftEnded = !g.pos?.active;

    // map: tap anywhere → point-to-go (no pin required)
    g.hud.open('map');
    await wait(150);
    const cv = document.querySelector('#bigmap');
    const r = cv.getBoundingClientRect();
    const pins = g.hud.mapPins ?? [];
    const s = cv.width / 170;
    let tap = null;
    outer: for (let fy = 0.1; fy <= 0.9; fy += 0.05) {
      for (let fx = 0.1; fx <= 0.9; fx += 0.05) {
        const px = (fx - 0.5) * cv.width, pz = (fy - 0.5) * cv.width;
        let near = false;
        for (const p of pins) {
          const dx = p.x * s - px, dz = p.z * s - pz;
          if (dx * dx + dz * dz < 42 * 42) { near = true; break; }
        }
        if (!near) { tap = { fx, fy }; break outer; }
      }
    }
    if (tap) {
      cv.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width * tap.fx, clientY: r.top + r.height * tap.fy }));
    }
    const sheet = document.querySelector('#mapSheet');
    out.mapFreeTap = !!tap && !sheet.classList.contains('hidden') && g.hud.mapSel?.id === 'free';
    document.querySelector('#mapGo').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    out.waypoint = g.mapWaypoint ? { x: Math.round(g.mapWaypoint.x), z: Math.round(g.mapWaypoint.z) } : null;
    g.clearWaypoint();
    g.hud.closeAll();
    return out;
  });
  check('POS application starts as pending (you do not own the POS)', extra.applied === 'pending', `status=${extra.applied}`);
  check('approved POS agent can start a shift', extra.approved === 'approved' && extra.shiftActive, `approved=${extra.approved} active=${extra.shiftActive}`);
  check('shop camera locks on and the player steps behind the counter', extra.shopCam && extra.serveSpot, `cam=${extra.shopCam} spot=${extra.serveSpot}`);
  check('customer walks up: amount, then withdraw-or-transfer', extra.gotAsk1 && extra.gotAsk2, `ask1=${extra.gotAsk1} ask2=${extra.gotAsk2}`);
  check('approving a transaction pays the service fee', extra.served === 1 && extra.fee > 0, `served=${extra.served} fee=${extra.fee}`);
  check('shift ends and releases the shop camera', extra.shiftEnded && extra.camReleased, `ended=${extra.shiftEnded} cam=${extra.camReleased}`);
  check('map tap-anywhere sets a point-to-go waypoint', extra.mapFreeTap && !!extra.waypoint, JSON.stringify(extra.waypoint));

  /* ------------------------------------------------- conversation */
  const talk = await page.evaluate(async () => {
    const g = window.__gist;
    const npc = g.npcs.npcs[0];
    g.avatar.root.position.set(npc.avatar.root.position.x + 1, 0, npc.avatar.root.position.z + 1);
    g.npcs.faceTowards(npc, g.avatar.root.position);
    g.startNpcTalk(npc);
    await new Promise((r) => setTimeout(r, 400));
    const dlg = document.getElementById('dialogue');
    const open1 = !dlg.classList.contains('hidden');
    const choices = [...document.querySelectorAll('#dlgChoices .dlgChoice')].map((b) => b.textContent);
    const line0 = document.getElementById('dlgLine').textContent;
    const act0 = g.act.current;
    // pick the first response
    document.querySelector('#dlgChoices .dlgChoice')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const line1 = document.getElementById('dlgLine').textContent;
    const chip = document.getElementById('actChip')?.classList.contains('hidden') ? '' : document.getElementById('actChipText').textContent;
    // walk away
    g.endConversation();
    await new Promise((r) => setTimeout(r, 200));
    const open2 = !dlg.classList.contains('hidden');
    return { open1, choices, line0, line1, act0, chip, open2, changed: line0 !== line1 };
  });
  check('conversation opens with response choices', talk.open1 && talk.choices.length >= 2, `choices=${talk.choices.length}`);
  check('picking a response gets an actual reply', talk.changed, `"${talk.line0}" → "${talk.line1}"`);
  check('talking sets TALKING state + chip', talk.act0 === 'TALKING' && /talk/i.test(talk.chip), `act=${talk.act0} chip=${talk.chip}`);
  check('conversation closes cleanly', talk.open2 === false, `still open=${talk.open2}`);
  await shot('06-dialogue');

  /* --------------------------------------------- changing room */
  const change = await page.evaluate(async () => {
    const g = window.__gist;
    g.hud.open('style');
    await new Promise((r) => setTimeout(r, 300));
    const during = {
      act: g.act.current,
      curtain: !document.getElementById('changing').classList.contains('hidden'),
    };
    g.hud.closeAll();
    await new Promise((r) => setTimeout(r, 200));
    return { ...during, after: g.act.current };
  });
  check('wardrobe runs as private CHANGING_CLOTHES', change.act === 'CHANGING_CLOTHES' && change.curtain, JSON.stringify(change));
  check('leaving the changing room returns to IDLE', change.after === 'IDLE', `after=${change.after}`);

  /* --------------------------------------------- social: pages & DMs */
  const social = await page.evaluate(async () => {
    const g = window.__gist;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // public page of a local citizen (practice mode)
    await g.socialUI.openProfile('tunde');
    await sleep(600);
    const title = document.getElementById('profileTitle')?.textContent;
    const mediaCells = document.querySelectorAll('#mediaGrid .mediaCell').length;
    const followBtn = document.querySelector('[data-act="follow"]');
    followBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(400);
    const followed = document.querySelector('[data-act="follow"]')?.textContent ?? '';
    return { title, mediaCells, followed: /Following/.test(followed) };
  });
  check('tapping a citizen opens their public page', social.title === 'Tunde', `title=${social.title}`);
  check('profile page shows their photo gallery', social.mediaCells >= 2, `cells=${social.mediaCells}`);
  check('following a citizen works', social.followed === true, `btn=${social.followed}`);

  const dm = await page.evaluate(async () => {
    const g = window.__gist;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await g.socialUI.message('tunde');
    await sleep(600);
    const composer = !!document.querySelector('.chatComposer #chatInput');
    const input = document.getElementById('chatInput');
    input.value = 'How far? I dey find partner for business.';
    document.getElementById('chatSend').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(500);
    const mine = document.querySelectorAll('#chatLog .chatBubble.mine').length;
    await sleep(3400); // the citizen replies (local mailbox)
    const theirs = document.querySelectorAll('#chatLog .chatBubble.theirs').length;
    const lastTheirs = document.querySelector('#chatLog .chatBubble.theirs p')?.textContent ?? '';
    return { composer, mine, theirs, lastTheirs };
  });
  check('DM conversation opens with a composer', dm.composer === true, '');
  check('sent message appears as mine', dm.mine >= 1, `mine=${dm.mine}`);
  check('the other side actually replies in the DM', dm.theirs >= 1 && !!dm.lastTheirs, `reply="${dm.lastTheirs}"`);
  await shot('07-dm');

  const mypage = await page.evaluate(async () => {
    const g = window.__gist;
    await g.socialUI.openProfile('me');
    await new Promise((r) => setTimeout(r, 600));
    return {
      title: document.getElementById('profileTitle')?.textContent,
      uploaders: document.querySelectorAll('[data-up]').length,
      cells: document.querySelectorAll('#mediaGrid .mediaCell').length,
    };
  });
  check('my own page opens with upload controls', mypage.uploaders === 2, `title=${mypage.title} uploaders=${mypage.uploaders}`);

  // upload a real photo file to my page and confirm it renders
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  writeFileSync('/tmp/gist-tiny.png', Buffer.from(tinyPng, 'base64'));
  const upload = await page.evaluate(async () => {
    const g = window.__gist;
    await g.socialUI.openProfile('me');
    await new Promise((r) => setTimeout(r, 500));
    return { ready: !!document.querySelector('[data-up="photo"]') };
  });
  if (upload.ready) {
    const input = await page.$('[data-up="photo"]');
    await input.uploadFile('/tmp/gist-tiny.png');
    await new Promise((r) => setTimeout(r, 900));
  }
  const afterUpload = await page.evaluate(() => ({
    cells: document.querySelectorAll('#mediaGrid .mediaCell').length,
    imgs: document.querySelectorAll('#mediaGrid img').length,
  }));
  check('uploaded photo appears on my public page', afterUpload.cells >= 1 && afterUpload.imgs >= 1, JSON.stringify(afterUpload));

  const blocked = await page.evaluate(async () => {
    const g = window.__gist;
    await g.socialUI.openProfile('tunde');
    await new Promise((r) => setTimeout(r, 500));
    document.querySelector('[data-act="block"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    const btn = document.querySelector('[data-act="block"]')?.textContent ?? '';
    const msg = document.querySelector('[data-act="message"]');
    return { btn, msgDisabled: msg ? msg.disabled : null };
  });
  check('blocking stops DMs and is reversible from the page', /Unblock/.test(blocked.btn) && blocked.msgDisabled === true, JSON.stringify(blocked));

  /* ------------------------------------- family: marriage & newborn */
  const fam0 = await page.evaluate(() => ({
    age: window.__gist.family.ageNow(),
    lifeAge: (() => {
      window.__gist.hud.open('life');
      const t = document.getElementById('statGrid')?.textContent ?? '';
      window.__gist.hud.closeAll();
      return /AGE/.test(t) && /18 y\/o/.test(t);
    })(),
  }));
  check('new players are 18 y/o (accelerated calendar)', Math.abs(fam0.age - 18) < 0.1, `age=${fam0.age}`);
  check('the Life panel shows the character age', fam0.lifeAge === true, '');

  const marry = await page.evaluate(async () => {
    const g = window.__gist;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    g.hud.open('registry');
    await sleep(600);
    const form = !!document.getElementById('proposeBtn');
    document.getElementById('proposeWho').value = 'chioma';
    document.getElementById('proposeBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(2200); // proposal sent + local partner reads & signs
    const signBtn = !!document.getElementById('signBtn');
    const ms = await g.family.marriages();
    const partnerSigned = ms[0]?.partner_signed === true && ms[0]?.status === 'proposed';
    document.getElementById('signBtn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(600);
    const roomBtn = !!document.getElementById('familyRoomBtn');
    const treeText = document.getElementById('registryBody').textContent;
    return { form, signBtn, partnerSigned, roomBtn, spouseShown: /Chioma/.test(treeText) };
  });
  check('registry offers the marriage proposal form', marry.form === true, '');
  check('the agreement waits for BOTH signatures', marry.signBtn && marry.partnerSigned, JSON.stringify(marry));
  check('signing activates the marriage (family room opens)', marry.roomBtn === true, '');
  check('the family tree shows the spouse', marry.spouseShown === true, '');

  const baby = await page.evaluate(async () => {
    const g = window.__gist;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.getElementById('familyRoomBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(500);
    const ask = document.getElementById('ask');
    const askOpen = ask && !ask.classList.contains('hidden');
    document.getElementById('askInput').value = 'Chidinma';
    document.getElementById('askOk').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(400);
    const faded = document.getElementById('fade').classList.contains('on');
    await sleep(4200); // fade to black → registration → fade back
    const fadedAfter = document.getElementById('fade').classList.contains('on');
    g.hud.open('registry');
    await sleep(700);
    const body = document.getElementById('registryBody').textContent;
    return {
      askOpen, faded, fadedAfter,
      registryShows: /Chidinma/.test(body),
      matched: /Fada|Testero|Chioma/.test(body), // parents listed on the registry line
      treeShows: /Chidinma/.test(body),
    };
  });
  check('the family room asks for the baby name', baby.askOpen === true, '');
  check('the scene fades to black (private, non-explicit)', baby.faded === true && baby.fadedAfter === false, `in=${baby.faded} out=${!baby.fadedAfter}`);
  check('newborn appears in today\'s birth registry', baby.registryShows === true, '');
  check('newborn is matched to the parents on the registry', baby.matched === true, '');
  check('newborn appears in the family tree', baby.treeShows === true, '');

  const again = await page.evaluate(async () => {
    const g = window.__gist;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.getElementById('familyRoomBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(400);
    document.getElementById('askInput').value = 'Second';
    document.getElementById('askOk').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(4200);
    const toast = document.getElementById('toast').textContent;
    const children = (await g.family.tree()).children.length;
    return { toast, children };
  });
  check('one newborn per couple per day (server rule)', again.children === 1 && /One baby per couple per day/.test(again.toast), JSON.stringify(again));

  /* ------------------------- opportunity: roles, investing, giving */
  const permit = await page.evaluate(async () => {
    const g = window.__gist;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    g.hud.open('revenue');
    await sleep(700);
    const deskOpen = !!document.getElementById('revenueBody')?.textContent.includes('BUSINESS PERMITS');
    const cash0 = g.store.state.cash;
    document.querySelector('[data-permit="trader"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(400);
    document.getElementById('askInput').value = 'Testero Trading';
    document.getElementById('askOk').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(600);
    const cash1 = g.store.state.cash;
    const owned = /Permit active/.test(document.getElementById('revenueBody').textContent);
    // a market run earns with the role
    document.querySelector('[data-trade="trader"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(600);
    const cash2 = g.store.state.cash;
    return { deskOpen, paid: cash0 - cash1, owned, earned: cash2 - cash1 };
  });
  check('revenue desk opens with permits & roles', permit.deskOpen === true, '');
  check('buying the trader permit charges the city fee', permit.paid === 25000, `paid=${permit.paid}`);
  check('the role is active after purchase', permit.owned === true, '');
  check('market runs pay the trader role', permit.earned > 700, `earned=${permit.earned}`);

  const invest = await page.evaluate(async () => {
    const g = window.__gist;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const cash0 = g.store.state.cash;
    document.querySelector('[data-fund-buy="grain"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(400);
    document.getElementById('askInput').value = '5000';
    document.getElementById('askOk').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(600);
    const cash1 = g.store.state.cash;
    const held = /grain/.test(document.getElementById('revenueBody').textContent);
    document.querySelector('[data-fund-sell="grain"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(400);
    document.getElementById('askInput').value = '5000';
    document.getElementById('askOk').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(600);
    const cash2 = g.store.state.cash;
    return { bought: cash0 - cash1, held, soldBack: cash2 - cash1 };
  });
  check('investing buys units from the wallet', invest.bought === 5000, `paid=${invest.bought}`);
  check('holdings appear in the portfolio', invest.held === true, '');
  check('selling returns funds to the wallet', invest.soldBack >= 4900, `back=${invest.soldBack}`);

  const give = await page.evaluate(async () => {
    const g = window.__gist;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const cash0 = g.store.state.cash;
    document.querySelector('[data-act="charity"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(500);
    const charityGain = g.store.state.cash - cash0;
    // ask a citizen for help (local citizen answers after a beat)
    document.querySelector('[data-act="beg"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(350);
    document.getElementById('askInput').value = 'tunde';
    document.getElementById('askOk').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(350);
    document.getElementById('askInput').value = '500';
    document.getElementById('askOk').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(2600);
    const begGain = g.store.state.cash - cash0 - charityGain;
    return { charityGain, begGain };
  });
  check('charity is a real (modest) income path', give.charityGain >= 150 && give.charityGain <= 600, `gain=${give.charityGain}`);
  check('asking a citizen for help can bring gifts', give.begGain === 500, `gain=${give.begGain}`);

  const scan = await page.evaluate(async () => {
    const g = window.__gist;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    g.hud.open('style');
    await sleep(400);
    const btn = !!document.getElementById('scanBtn');
    document.getElementById('scanBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(900);
    const toast = document.getElementById('toast').textContent;
    g.hud.closeAll();
    return { btn, toast };
  });
  check('face scan exists in the Style Studio', scan.btn === true, '');
  check('face scan gives clear feedback without a camera', scan.toast.trim().length > 0, `toast="${scan.toast}"`);

  /* -------------------------------------- map interaction */
  const map = await page.evaluate(async () => {
    const g = window.__gist;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    g.hud.open('map');
    await sleep(500);
    const pins = (g.hud.mapPins ?? []).length;
    const c = document.getElementById('bigmap');
    const sheetShown = (() => {
      const pin = (g.hud.mapPins ?? [])[0];
      if (!pin) return false;
      const r = c.getBoundingClientRect(), w = c.width, s = w / 170;
      const cx = r.left + ((pin.x * s + w / 2) / w) * r.width;
      const cy = r.top + ((pin.z * s + w / 2) / w) * r.height;
      c.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));
      return !document.getElementById('mapSheet').classList.contains('hidden')
        && document.getElementById('mapSheetName').textContent === pin.label;
    })();
    const goBtn = !!document.getElementById('mapGo');
    document.getElementById('mapGo').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(300);
    const tgt = g.jobTarget();
    return { pins, sheetShown, goBtn, tgt: tgt ? tgt.label : null };
  });
  check('map screen opens with tappable places', map.pins > 5 && map.sheetShown, `pins=${map.pins}`);
  check('tapping a place sets a waypoint on the minimap', map.tgt !== null, `waypoint="${map.tgt}"`);

  /* -------------------------------------- persistence & summary */
  const persist = await page.evaluate(async () => {
    const g = window.__gist;
    const cash = g.store.state.cash, hunger = g.store.state.needs.hunger;
    const save = JSON.parse(localStorage.getItem('gist_save_v1') ?? '{}');
    const soc = JSON.parse(localStorage.getItem('gist_society_v1') ?? '{}');
    return { cash, hunger, savedCash: save.cash, vehicles: (soc.vehicles ?? []).length, certs: (soc.certificates ?? []).length };
  });
  check('state persists to the local save', persist.savedCash === persist.cash, `save.cash=${persist.savedCash} state.cash=${persist.cash}`);
  check('vehicle persists in the society save', persist.vehicles >= 1, `vehicles=${persist.vehicles}`);

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${SHOTS}`);
  if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join(' | ')); process.exit(1); }
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
