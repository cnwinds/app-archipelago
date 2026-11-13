import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] || 'http://localhost:5317/';
mkdirSync('shots', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on('console', (m) => {
  if (['error', 'warn'].includes(m.type())) console.log(`[${m.type()}]`, m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);

await page.goto(url, { waitUntil: 'networkidle2' });
await wait(5500);
await page.screenshot({ path: 'shots/1-overview.png' });

await page.evaluate(() => [...document.querySelectorAll('.island-label')][0]?.click());
await wait(3000);
await page.screenshot({ path: 'shots/2-island.png' });

await page.evaluate(() => document.querySelector('.app-label.tier-2')?.click());
await wait(3000);
await page.screenshot({ path: 'shots/3-app.png' });

await click('#btn-overview');
await wait(500);
await page.evaluate(() => document.querySelector('[data-tod="night"]').click());
await wait(2500);
await page.screenshot({ path: 'shots/4-night.png' });

await page.evaluate(() => document.querySelector('[data-tod="day"]').click());
await click('#btn-random');
await wait(4000);
await page.screenshot({ path: 'shots/5-random-day.png' });

const fps = await page.evaluate(
  () =>
    new Promise((res) => {
      let n = 0;
      const t0 = performance.now();
      const f = () => (++n, performance.now() - t0 < 2000 ? requestAnimationFrame(f) : res((n * 1000) / (performance.now() - t0)));
      requestAnimationFrame(f);
    }),
);
console.log('fps≈', fps.toFixed(1));
await browser.close();
