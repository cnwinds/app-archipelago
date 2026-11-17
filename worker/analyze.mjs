// Open a candidate in a real browser and collect what a reviewer needs: does it load, how
// fast, can it run inside an iframe on our site, what does the page say about itself and
// what does it look like.
//
// This is the old scripts/catalog/ingest.mjs `ingest()` turned into a function: it returns the
// result and the screenshots instead of writing files, and the api decides what to keep.
//
// Design points worth knowing before changing anything:
//  - The embed test really loads the work in an iframe, with the parent faked as our own origin
//    via request interception. X-Frame-Options, CSP frame-ancestors and mixed content then apply
//    exactly as in production. Reading response headers alone is not enough.
//  - Loading is not running: works that need cross-origin isolation (SharedArrayBuffer, many WASM
//    game ports) load in an iframe but cannot work there, because our page is not isolated.
//  - The embedded run gets a fresh tab. Reusing the tab that just showed the work on its own
//    sometimes produced a blank frame for a work that embeds fine.
//  - Screenshots are serialized browser-wide, so a single frame can time out while another tab
//    holds the browser. Every frame fails on its own; the work only fails if no frame was taken.

import puppeteer from 'puppeteer-core';

const VIEW = { width: 1280, height: 800 };
// The embed test loads each work inside an iframe on a page served from this origin.
const EMBED_PARENT = 'https://isle.ai-news.top/__embed_test__';
// Keep in sync with openPlay() in src/main.js.
const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-pointer-lock';
const NAV_TIMEOUT = 45000;
// Slower than this and visitors in China will notice.
const SLOW_MS = 15000;
// A canvas work whose best cover is smaller than this (webp bytes) is probably still on its
// loading screen, so it gets late frames.
const LOADER_BYTES = 15000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Browser calls can hang forever on some pages, so every step has a deadline.
export function withTimeout(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function headerVerdict(url, headers) {
  if (new URL(url).protocol === 'http:') return 'mixed-content';
  const xfo = (headers['x-frame-options'] || '').toLowerCase();
  if (/deny|sameorigin/.test(xfo)) return 'x-frame-options';
  const fa = /frame-ancestors([^;]*)/i.exec(headers['content-security-policy'] || '');
  if (fa && !/(\s|^)(\*|https:)(\s|$)/.test(fa[1])) return 'csp-frame-ancestors';
  return null;
}

// Retrying makes sense for network trouble, not for a certificate that is simply wrong.
function errorKind(error, httpStatus) {
  if (httpStatus && httpStatus >= 400) return httpStatus === 403 || httpStatus === 429 ? 'blocked' : 'http';
  const msg = String(error?.message || error);
  if (/net::ERR_CERT|net::ERR_SSL/.test(msg)) return 'cert';
  if (error?.name === 'TimeoutError' || /timed out|net::ERR_(NAME_NOT_RESOLVED|CONNECTION|TIMED_OUT|TUNNEL|PROXY|INTERNET|ADDRESS|EMPTY_RESPONSE|NETWORK)/.test(msg)) return 'network';
  return 'other';
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

// How Chromium gets a WebGL context. Without one, every 3D work screenshots as a blank page and
// the embed test cannot tell "broken" from "needs a GPU". Pick with CHROME_GPU.
const GPU_FLAGS = {
  // A developer machine with a real graphics card (Windows).
  desktop: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
  // Mesa's software renderer (llvmpipe) through ANGLE. This is what the docker image uses: Alpine's
  // Chromium ships no SwiftShader, so the flags below give "WebGL is disabled" there.
  mesa: ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist'],
  // The software renderer bundled with Chrome from Google (Windows, macOS, most Linux builds).
  swiftshader: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
};

function chromeArgs(proxy) {
  const gpu = GPU_FLAGS[process.env.CHROME_GPU] ?? GPU_FLAGS.swiftshader;
  return [
    ...gpu,
    '--mute-audio',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    `--window-size=${VIEW.width},${VIEW.height}`,
    // Chrome's own sandbox needs kernel features a container does not get. The container
    // itself is the sandbox: non-root, read-only, no capabilities, and the egress proxy below.
    ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    ...(proxy
      ? [
          `--proxy-server=${proxy}`,
          // By default Chrome skips the proxy for loopback and link-local; send those through it too.
          '--proxy-bypass-list=<-loopback>',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        ]
      : []),
  ];
}

async function runAnalysis(browser, userAgent, url, opts) {
  const result = { url, checkedAt: new Date().toISOString(), ok: false };
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
  await page.setUserAgent(userAgent);
  let framePage = null;
  try {
    const t0 = Date.now();
    try {
      await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
      result.loadMs = Date.now() - t0;
    } catch (e) {
      // A page that rendered but never fired `load` (long-polling, huge assets) is still usable.
      if (e.name !== 'TimeoutError' || !mainResp) throw e;
      result.loadMs = null;
      result.loadTimedOut = true;
    }
    result.reach = result.loadMs === null || result.loadMs > SLOW_MS ? 'slow' : 'ok';
    result.httpStatus = mainResp?.status() ?? null;
    result.finalUrl = page.url();
    if (!result.httpStatus || result.httpStatus >= 400) throw new Error(`HTTP ${result.httpStatus}`);
    const headers = mainResp.headers();

    // Games and canvases often start on a loader; keep the most detailed of several frames.
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
    // Engines can take a while to download: while the best frame still looks like a loader, keep waiting.
    if (hasCanvas) {
      for (const delay of [12000, 15000]) {
        if (best && best.length >= LOADER_BYTES) break;
        await snap(delay);
      }
    }
    if (opts.late) await snap(opts.late);
    if (!best) throw shotError;
    if (shotError) result.coverNote = shotError.message;
    result.meta = await withTimeout(
      page.evaluate(() => {
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
      }),
      8000,
      'metadata read',
    );
    result.jsErrors = jsErrors;
    result.cover = best;

    const isolated = await withTimeout(page.evaluate(() => self.crossOriginIsolated === true), 8000, 'isolation check');
    const verdict = headerVerdict(result.finalUrl, headers);
    await withTimeout(page.close(), 8000, 'page close').catch(() => {});
    phase = 'embedded';
    if (!isolated) {
      framePage = await browser.newPage();
      await framePage.setUserAgent(userAgent);
      watch(framePage);
    }
    const live = isolated
      ? { ok: false, reason: 'needs-cross-origin-isolation' }
      : await withTimeout(embedTest(framePage, result.finalUrl), 35000, 'embed test').catch((e) => ({
          ok: false,
          reason: 'error: ' + e.message.slice(0, 80),
        }));
    result.embed = { ok: live.ok, reason: live.ok ? null : isolated ? live.reason : verdict || live.reason };

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
        result.embedShot = framed;
        const ratio = framed.length / best.length;
        if (ratio < 0.4) warnings.push(`embedded view has ${Math.round(ratio * 100)}% of the detail of the standalone view after 28s`);
      }
      for (const text of errors.embedded) if (!errors.solo.has(text)) warnings.push(`error only when embedded: ${text}`);
      if (warnings.length) result.embed.warnings = warnings.slice(0, 4);
    }
    result.ok = true;
  } catch (e) {
    result.error = String(e.message || e).split('\n')[0].slice(0, 200);
    result.errorKind = errorKind(e, result.httpStatus);
  } finally {
    for (const p of [page, framePage]) {
      if (p && !p.isClosed()) await withTimeout(p.close(), 8000, 'page close').catch(() => {});
    }
  }
  return result;
}

// One long-lived browser, replaced when it dies or has served enough pages to have grown fat.
export function createAnalyzer({ chromePath = process.env.CHROME_PATH, proxy, maxPerBrowser = 25 } = {}) {
  if (!chromePath) throw new Error('CHROME_PATH is not set');
  let browser = null;
  let userAgent = null;
  let served = 0;

  async function close() {
    const b = browser;
    browser = null;
    served = 0;
    if (b) await withTimeout(b.close(), 10000, 'browser close').catch(() => b.process()?.kill('SIGKILL'));
  }

  async function ensure() {
    if (browser && (!browser.connected || served >= maxPerBrowser)) await close();
    if (!browser) {
      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        // Page.navigate only answers once the server starts replying, which on a slow overseas
        // host can take longer than the 45s navigation budget. Every other call has its own deadline.
        protocolTimeout: 60000,
        args: chromeArgs(proxy),
        defaultViewport: VIEW,
      });
      userAgent = (await browser.userAgent()).replace('HeadlessChrome', 'Chrome');
    }
    return browser;
  }

  return {
    // opts.late: take one more screenshot this many ms later, for works that load slowly.
    async analyze(url, opts = {}) {
      const b = await ensure();
      served++;
      return runAnalysis(b, userAgent, url, opts);
    },
    close,
  };
}
