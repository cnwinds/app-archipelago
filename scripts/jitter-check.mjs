import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => m.type() === 'error' && console.log('[error]', m.text(), m.location()?.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto('http://localhost:5317/', { waitUntil: 'networkidle2' });
await wait(5000);

for (let run = 0; run < 3; run++) {
  const stats = page.evaluate(
    () =>
      new Promise((res) => {
        const els = [...document.querySelectorAll('#labels > *')];
        let prev = els.map((e) => e.style.display);
        let flips = 0;
        let frames = 0;
        let maxVisible = 0;
        const t0 = performance.now();
        const f = () => {
          frames++;
          let vis = 0;
          els.forEach((e, i) => {
            const d = e.style.display;
            if (d !== prev[i]) flips++;
            prev[i] = d;
            if (d === 'flex' && +e.style.opacity > 0.05) vis++;
          });
          maxVisible = Math.max(maxVisible, vis);
          if (performance.now() - t0 < 3200) requestAnimationFrame(f);
          else res({ frames, flips, maxVisible, fps: (frames * 1000) / (performance.now() - t0) });
        };
        requestAnimationFrame(f);
      }),
  );
  await page.evaluate(() => document.querySelector('#btn-random').click());
  if (run === 0) {
    await wait(1100);
    await page.screenshot({ path: 'shots/6-teleport-mid.png' });
  }
  console.log(`run ${run}`, await stats);
  if (run === 0) await page.screenshot({ path: 'shots/7-teleport-end.png' });
  await wait(800);
}
await browser.close();
