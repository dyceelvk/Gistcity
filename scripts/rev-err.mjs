import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  args: [...chromium.args, '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
  headless: 'shell', protocolTimeout: 600000,
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.type(), m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.stack ?? e).slice(0, 900)));
await page.setViewport({ width: 1280, height: 800 });
await page.evaluateOnNewDocument(() => { localStorage.setItem('gist_onboarded', '1'); });
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__gist && window.__gist.avatar, { timeout: 90000 });
await new Promise(r => setTimeout(r, 3000));
const state = await page.evaluate(() => ({
  hasComposer: !!window.__gist.composer,
  passes: window.__gist.composer?.passes?.map((p) => p.constructor.name),
}));
console.log('STATE', JSON.stringify(state));
await browser.close();
