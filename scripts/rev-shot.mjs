import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
const label = process.argv[2] ?? 'rev';
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  args: [...chromium.args, '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
  headless: 'shell',
  protocolTimeout: 600000,
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.evaluateOnNewDocument(() => {
  localStorage.setItem('gist_onboarded', '1');
  globalThis.__gistHour = 10.2;
});
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__gist && window.__gist.avatar, { timeout: 90000 });
const [tx, tz, tyaw] = process.argv.slice(3).map(Number);
await new Promise(r => setTimeout(r, 3200));
if (!Number.isNaN(tx)) {
  await page.evaluate((x, z, yaw) => {
    const g = window.__gist;
    g.avatar.root.position.set(x, 0, z);
    if (!Number.isNaN(yaw)) g.yaw = yaw;
  }, tx, tz, tyaw);
  await new Promise(r => setTimeout(r, 1200));
}
await page.screenshot({ path: `/home/user/gist-shots/${label}.png` });
console.log('done');
await browser.close();
