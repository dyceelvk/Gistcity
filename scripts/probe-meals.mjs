/** Meal probe: order suya, then pure water — report busy/act + any page errors. */
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  args: [...chromium.args, '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
  headless: 'shell', protocolTimeout: 600000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.stack ?? e).slice(0, 900)));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });
await page.setViewport({ width: 1280, height: 800 });
await page.evaluateOnNewDocument(() => { localStorage.setItem('gist_onboarded', '1'); });
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__gist && window.__gist.avatar, { timeout: 90000 });
await new Promise((r) => setTimeout(r, 3000));
const out = await page.evaluate(async () => {
  const g = window.__gist;
  const snap = () => ({ busy: g.busy, act: g.act.current, hunger: +g.store.state.needs.hunger.toFixed(1), thirst: +g.store.state.needs.thirst.toFixed(1) });
  const until = async (fn, ms) => {
    const t0 = performance.now();
    while (!fn() && performance.now() - t0 < ms) await new Promise((r) => setTimeout(r, 120));
    return fn();
  };
  const zone = g.world.zones.find((z) => z.id === 'suya');
  g.avatar.root.position.set(zone.x + 1, 0, zone.z + 1);
  g.currentZone = zone;
  g.refreshActions();
  const food = g.currentActions.find((a) => /suya|meat|shawarma/i.test(a.label) && !a.disabled);
  const before = snap();
  food.run();
  await until(() => g.act.current === 'EATING', 15000);
  const eatDuring = g.act.current;
  await until(() => g.act.current === 'IDLE', 15000);
  await new Promise((r) => setTimeout(r, 800));
  const afterEat = snap();
  const drink = g.currentActions.find((a) => /water|zobo|drink|malt|juice/i.test(a.label) && !a.disabled);
  drink.run();
  await until(() => g.act.current === 'DRINKING', 15000);
  const drinkDuring = g.act.current;
  await until(() => g.act.current === 'IDLE', 15000);
  await new Promise((r) => setTimeout(r, 800));
  return { before, eatDuring, afterEat, drinkDuring, afterDrink: snap(), labels: g.currentActions.map((a) => a.label) };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
