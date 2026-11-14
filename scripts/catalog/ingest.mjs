// Health-check every candidate in catalog/sources.json with a real browser and collect
// what a reviewer needs: reachability, load time, whether it can be embedded in an
// iframe on our site, page metadata and a screenshot.
//
//   node scripts/catalog/ingest.mjs [--only id,id] [--limit N] [--concurrency 5] [--force]
//                                   [--late 20000] [--proxy http://host:port]
//
//   --late         take one more screenshot this many ms later, for works that load slowly
//   --embed-shots  directory to save a screenshot of each work running inside our iframe
//   --proxy        route the browser through a proxy, for machines that cannot reach the hosts
//
// Results go to catalog/drafts.json (keyed by id) and catalog/shots/<id>.webp. Nothing here
// reaches the site until publish.mjs runs.

import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { PATHS, readJson, writeJson, parseArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), { concurrency: 5, limit: 0, late: 0 });
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VIEW = { width: 1280, height: 800 };
// The embed test loads each work inside an iframe on a page served from this origin,
// so X-Frame-Options, CSP frame-ancestors and mixed-content rules apply as in production.
const EMBED_PARENT = 'https://isle.ai-news.top/__embed_test__';
const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-pointer-lock';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Browser calls can hang forever on some pages (a stuck screenshot also blocks every other
// tab, because the browser takes screenshots one at a time), so every step has a deadline.
function withTimeout(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const sources = readJson(PATHS.sources, []);
const drafts = readJson(PATHS.drafts, {});
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
let queue = sources.filter((s) => (only ? only.has(s.id) : args.force || !drafts[s.id]));
if (args.limit) queue = queue.slice(0, args.limit);
if (!queue.length) {
  console.log('nothing to ingest (use --force to re-check everything)');
  process.exit(0);
}

mkdirSync(PATHS.shots, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 30000,
  args: [
    '--use-angle=d3d11',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--mute-audio',
    `--window-size=${VIEW.width},${VIEW.height}`,
    ...(typeof args.proxy === 'string' ? [`--proxy-server=${args.proxy}`] : []),
  ],
  defaultViewport: VIEW,
});

function headerVerdict(url, headers) {
  if (new URL(url).protocol === 'http:') return 'mixed-content';
  const xfo = (headers['x-frame-options'] || '').toLowerCase();
  if (/deny|sameorigin/.test(xfo)) return 'x-frame-options';
  const fa = /frame-ancestors([^;]*)/i.exec(headers['content-security-policy'] || '');
  if (fa && !/(\s|^)(\*|https:)(\s|$)/.test(fa[1])) return 'csp-frame-ancestors';
  return null;
}

async function embedTest(page, url) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return;
    if (req.url() === EMBED_PARENT) {
      req.respond({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><body style="margin:0"><iframe src="${url.replace(/"/g, '&quot;')}" sandbox="${IFRAME_SANDBOX}" allow="fullscreen; gamepad; autoplay" referrerpolicy="no-referrer" style="border:0;width:100vw;height:100vh"></iframe>`,
      });
    } else req.continue();
  });
  await page.goto(EMBED_PARENT, { waitUntil: 'domcontentloaded', timeout: 15000 });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const child = page.frames().find((f) => f.parentFrame() === page.mainFrame());
    const u = child?.url() || '';
    if (u.startsWith('chrome-error:')) return { ok: false, reason: 'blocked' };
    if (/^https?:/.test(u)) {
      const state = await child.evaluate(() => document.readyState).catch(() => null);
      if (state && state !== 'loading') return { ok: true, reason: null };
    }
    await wait(300);
  }
  return { ok: false, reason: 'timeout' };
}

async function ingest(src) {
  const draft = { id: src.id, url: src.url, checkedAt: new Date().toISOString(), ok: false };
  const page = await browser.newPage();
  let mainResp = null;
  let jsErrors = 0;
  // Error text seen while the work runs on its own vs. inside our iframe.
  const errors = { solo: new Set(), embedded: new Set() };
  let phase = 'solo';
  const noteError = (text) => {
    if (!/Failed to load resource|sandbox attribute can escape/.test(text)) errors[phase].add(text.split('\n')[0].slice(0, 140));
  };
  const watch = (p) => {
    p.on('pageerror', (e) => {
      if (phase === 'solo') jsErrors++;
      noteError(String(e.message || e));
    });
    p.on('console', (m) => {
      if (m.type() === 'error') noteError(m.text());
    });
    p.on('dialog', (d) => d.dismiss().catch(() => {}));
  };
  page.on('response', (r) => {
    if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) mainResp = r;
  });
  watch(page);
  // The embedded run gets its own tab: reusing the tab that just showed the work on its own
  // sometimes produced a blank frame for a work that embeds fine.
  let framePage = null;
  try {
    const t0 = Date.now();
    try {
      await page.goto(src.url, { waitUntil: 'load', timeout: 25000 });
      draft.loadMs = Date.now() - t0;
    } catch (e) {
      // A page that rendered but never fired `load` (long-polling, huge assets) is still usable.
      if (e.name !== 'TimeoutError' || !mainResp) throw e;
      draft.loadMs = null;
      draft.loadTimedOut = true;
    }
    draft.httpStatus = mainResp?.status() ?? null;
    draft.finalUrl = page.url();
    if (!draft.httpStatus || draft.httpStatus >= 400) throw new Error(`HTTP ${draft.httpStatus}`);
    const headers = mainResp.headers();

    // Games and canvases often start on a loader; keep the most detailed of several frames.
    // Canvas pages get two extra late frames because engines can take a while to download.
    // Tabs take turns at screenshots, so a single frame can time out while another tab holds
    // the browser. Each frame fails on its own; the work only fails if no frame was captured.
    let best = null;
    let shotError = null;
    const snap = async (delay) => {
      await wait(delay);
      const shot = page.screenshot({ type: 'webp', quality: 80, clip: { x: 0, y: 0, ...VIEW, scale: 0.5 } });
      try {
        const buf = await withTimeout(shot, 12000, 'screenshot');
        if (!best || buf.length > best.length) best = buf;
      } catch (e) {
        shotError = e;
      }
    };
    const hasCanvas = await withTimeout(page.evaluate(() => document.querySelectorAll('canvas').length > 0), 8000, 'page check');
    for (const delay of hasCanvas ? [1500, 2500, 3000, 5000, 6000] : [1500, 2500, 3000]) await snap(delay);
    if (args.late) await snap(args.late);
    if (!best) throw shotError;
    if (shotError) draft.shotNote = shotError.message;
    draft.meta = await withTimeout(page.evaluate(() => {
      const m = (sel) => document.querySelector(sel)?.getAttribute('content')?.trim() || null;
      return {
        title: document.title.trim(),
        description: m('meta[name="description"]') || m('meta[property="og:description"]'),
        siteName: m('meta[property="og:site_name"]'),
        author: m('meta[name="author"]'),
        lang: document.documentElement.lang || null,
        hasViewportMeta: !!document.querySelector('meta[name="viewport"]'),
        canvasCount: document.querySelectorAll('canvas').length,
        text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600),
      };
    }), 8000, 'metadata read');
    draft.jsErrors = jsErrors;
    draft.shot = `${src.id}.webp`;
    // A re-check on a slow day must not replace a good cover with a loading screen. File size
    // stands in for detail; delete the file by hand to force a fresh cover.
    const shotPath = `${PATHS.shots}/${draft.shot}`;
    const previous = existsSync(shotPath) ? statSync(shotPath).size : 0;
    if (best.length >= previous * 0.5) {
      writeFileSync(shotPath, best);
      draft.shotBytes = best.length;
    } else {
      draft.shotBytes = previous;
      draft.shotNote = `kept the previous cover: the new capture had ${Math.round((best.length / previous) * 100)}% of its detail`;
    }

    // Works that rely on cross-origin isolation (SharedArrayBuffer: many WASM game ports)
    // load fine in an iframe but cannot run there, because our page is not isolated.
    const isolated = await withTimeout(page.evaluate(() => self.crossOriginIsolated === true), 8000, 'isolation check');
    const verdict = headerVerdict(draft.finalUrl, headers);
    await withTimeout(page.close(), 8000, 'page close').catch(() => {});
    phase = 'embedded';
    if (!isolated) {
      framePage = await browser.newPage();
      watch(framePage);
    }
    const live = isolated
      ? { ok: false, reason: 'needs-cross-origin-isolation' }
      : await withTimeout(embedTest(framePage, draft.finalUrl), 35000, 'embed test').catch((e) => ({
          ok: false,
          reason: 'error: ' + e.message.slice(0, 80),
        }));
    draft.embed = { ok: live.ok, reason: live.ok ? null : isolated ? live.reason : verdict || live.reason };

    // Loading is not the same as working. These soft signals go to the reviewer.
    if (live.ok) {
      const warnings = [];
      // The second load is often slower than the first (no cache while requests are being
      // intercepted), so keep looking for up to 28s before calling the embedded view empty.
      let framed = null;
      for (const pause of [4000, 5000, 7000, 12000]) {
        await wait(pause);
        const frame = await withTimeout(
          framePage.screenshot({ type: 'webp', quality: 80, clip: { x: 0, y: 0, ...VIEW, scale: 0.5 } }),
          12000,
          'embedded screenshot',
        ).catch(() => null);
        if (frame && (!framed || frame.length > framed.length)) framed = frame;
        if (framed && framed.length / best.length >= 0.4) break;
      }
      if (framed) {
        if (typeof args['embed-shots'] === 'string') {
          mkdirSync(args['embed-shots'], { recursive: true });
          writeFileSync(`${args['embed-shots']}/${src.id}.webp`, framed);
        }
        const ratio = framed.length / best.length;
        if (ratio < 0.4) warnings.push(`embedded view has ${Math.round(ratio * 100)}% of the detail of the standalone view after 28s`);
      }
      for (const text of errors.embedded) if (!errors.solo.has(text)) warnings.push(`error only when embedded: ${text}`);
      if (warnings.length) draft.embed.warnings = warnings.slice(0, 4);
    }
    draft.ok = true;
  } catch (e) {
    draft.error = String(e.message || e).split('\n')[0].slice(0, 200);
  } finally {
    for (const p of [page, framePage]) {
      if (p && !p.isClosed()) await withTimeout(p.close(), 8000, 'page close').catch(() => {});
    }
  }
  return draft;
}

let done = 0;
async function worker() {
  for (;;) {
    const src = queue.shift();
    if (!src) return;
    const draft = await ingest(src);
    drafts[src.id] = draft;
    writeJson(PATHS.drafts, drafts);
    done++;
    const tag = !draft.ok ? `FAIL ${draft.error}` : `${draft.loadMs ?? '>25000'}ms embed=${draft.embed.ok ? 'yes' : draft.embed.reason}`;
    console.log(`[${done}] ${src.id}  ${tag}`);
  }
}
const total = queue.length;
await Promise.all(Array.from({ length: Math.min(args.concurrency, total) }, worker));
await browser.close();

const all = Object.values(drafts);
const ok = all.filter((d) => d.ok);
console.log(
  `\ningested ${total}; drafts total ${all.length}: reachable ${ok.length}, embeddable ${ok.filter((d) => d.embed.ok).length}, failed ${all.length - ok.length}`,
);
