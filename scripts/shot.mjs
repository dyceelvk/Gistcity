/** Quick visual shots of the game's UI at phone + desktop size. Usage: node scripts/shot.mjs [baseUrl] [label] */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173/';
const LABEL = process.argv[3] ?? 'shot';
const SHOTS = process.env.SHOTS ?? '/home/user/gist-shots';

function ensureNssLibs() {
  try { execSync('ldconfig -p 2>/dev/null | grep -q libnss3.so', { stdio: 'ignore' }); return; } catch { /* */ }
  const require = createRequire(import.meta.url);
  let dir = join(require.resolve('@sparticuz/chromium'), '..');
  let archive = join(dir, 'bin', 'al2023.tar.br');
  while (dir !== '/' && !existsSync(archive)) { dir = join(dir, '..'); archive = join(dir, 'bin', 'al2023.tar.br'); }
  const out = join(tmpdir(), 'gist-nss-libs');
  if (!existsSync(join(out, 'lib', 'libnss3.so'))) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'al2023.tar'), zlib.brotliDecompressSync(require('fs').readFileSync(archive)));
    execSync(`tar -xf ${join(out, 'al2023.tar')} -C ${out}`, { stdio: 'ignore' });
  }
  process.env.LD_LIBRARY_PATH = `${join(out, 'lib')}${process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shootAll(puppeteer, chromium, width, height, tag, isPhone) {
  const browser = await puppeteer.launch({
    executablePath: await chromium.executablePath(),
    args: [...chromium.args, '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
    defaultViewport: { width, height, isMobile: isPhone, hasTouch: isPhone, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('gist_onboarded', '1');
    localStorage.setItem('gist_save_v1', JSON.stringify({ name: 'Ada', username: 'ada', cash: 500000, createdAt: Date.now() }));
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__gist && window.__gist.avatar, { timeout: 90000 });
  await sleep(3000);
  const shot = (name) => page.screenshot({ path: `${SHOTS}/${LABEL}-${tag}-${name}.png` });
  await shot('01-home');
  // open map
  await page.evaluate(() => window.__gist.hud?.open('map'));
  await sleep(700); await shot('02-map');
  await page.evaluate(() => window.__gist.hud?.closeAll());
  await sleep(300);
  // open style
  await page.evaluate(() => window.__gist.hud?.open('style'));
  await sleep(700); await shot('03-style');
  await page.evaluate(() => window.__gist.hud?.closeAll());
  await sleep(300);
  // open jobs
  await page.evaluate(() => window.__gist.hud?.open('jobs'));
  await sleep(700); await shot('04-jobs');
  await page.evaluate(() => window.__gist.hud?.closeAll());
  await sleep(300);
  // open life
  await page.evaluate(() => window.__gist.hud?.open('life'));
  await sleep(700); await shot('05-life');
  await page.evaluate(() => window.__gist.hud?.closeAll());
  await sleep(300);
  // drive HUD: buy + enter a car via society API if present
  const drove = await page.evaluate(async () => {
    const g = window.__gist;
    try {
      if (!g.vehicles?.length) await g.society?.buyVehicle?.('toks-corolla', '#1b2a4a', 40, -20, 0);
      const v = g.vehicles?.[0];
      if (!v) return false;
      g.enterVehicle?.(v); return true;
    } catch (e) { return String(e); }
  });
  await sleep(1200); await shot('06-drive');
  await page.evaluate(() => window.__gist.hud?.closeAll());
  await browser.close();
  console.log(tag, 'done', { drove });
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  ensureNssLibs();
  const puppeteer = (await import('puppeteer-core')).default;
  const chromiumMod = await import('@sparticuz/chromium');
  const chromium = chromiumMod.default ?? chromiumMod;
  await shootAll(puppeteer, chromium, 390, 844, 'phone', true);
  await shootAll(puppeteer, chromium, 1280, 800, 'desk', false);
  console.log('shots in', SHOTS);
}
main().catch((e) => { console.error(e); process.exit(1); });
