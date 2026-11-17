// Who may call what. The api answers visitors and the reviewer only when the request comes from
// the nginx container, the worker only with its token, and a browser write only from our own
// pages. These tests drive the real HTTP server on a loopback port.

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../server/app.mjs';
import { b64, good, setup, tick, webp } from './helpers.mjs';

const JSON_HEADERS = { 'content-type': 'application/json' };

// A raw request: fetch() refuses to send some of the odd things these tests need (a hostile
// request target, a chosen Host header).
function call(base, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const data = body === undefined ? null : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const req = http.request(
      { host: u.hostname, port: u.port, method, path, headers: { host: u.host, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(raw.toString('utf8'));
          } catch {
            // not json: an image, for one
          }
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// `edgeHost: 'localhost'` makes the loopback test client count as "the nginx container";
// a name that does not resolve makes it a stranger.
async function serve(t, ctx, over = {}) {
  const config = { ...ctx.config, production: true, workerToken: 'sekret-token-123', edgeHost: 'localhost', serveCatalog: false, ...over };
  const { server } = createApp({ store: ctx.store, intake: ctx.intake, discover: { run: async () => ({}) }, scheduler: { backup() {} }, config, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => (server.closeAllConnections(), server.close(r))));
  return `http://127.0.0.1:${server.address().port}`;
}

// ---- the worker ---------------------------------------------------------------------------

test('worker endpoints need the token', async (t) => {
  const base = await serve(t, setup(t));
  const claim = (headers) => call(base, 'POST', '/internal/claim', { headers: { ...JSON_HEADERS, ...headers }, body: {} });
  assert.equal((await claim({})).status, 403);
  assert.equal((await claim({ 'x-worker-token': 'wrong' })).status, 403);
  assert.equal((await claim({ 'x-worker-token': 'sekret-token-124' })).status, 403, 'same length, one character off');
  const ok = await claim({ 'x-worker-token': 'sekret-token-123' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { job: null });
});

test('in production without a configured token the worker door stays shut; in development it is open', async (t) => {
  const ctx = setup(t);
  const prod = await serve(t, ctx, { workerToken: '' });
  assert.equal((await call(prod, 'POST', '/internal/claim', { headers: JSON_HEADERS, body: {} })).status, 403);
  assert.equal((await call(prod, 'POST', '/internal/claim', { headers: { ...JSON_HEADERS, 'x-worker-token': '' }, body: {} })).status, 403);
  const dev = await serve(t, ctx, { workerToken: '', production: false });
  assert.equal((await call(dev, 'POST', '/internal/claim', { headers: JSON_HEADERS, body: {} })).status, 200);
});

test('the worker can claim a job and report on it, and only that', async (t) => {
  const ctx = setup(t);
  const base = await serve(t, ctx);
  const worker = { ...JSON_HEADERS, 'x-worker-token': 'sekret-token-123' };
  const { id } = await ctx.intake.submit({ url: 'https://play.example.com/' });
  const claimed = await call(base, 'POST', '/internal/claim', { headers: worker, body: { worker: 'w1' } });
  assert.equal(claimed.json.job.candidate.url, 'https://play.example.com/');
  const done = await call(base, 'POST', `/internal/jobs/${claimed.json.job.id}/result`, { headers: worker, body: { result: good(), cover: b64(webp(2000)) } });
  assert.equal(done.status, 200);
  await tick();
  assert.equal(ctx.store.get(id).state, 'pending_review');
  // the worker's token does not open the reviewer's or the visitors' doors from a stranger's address
  const stranger = await serve(t, ctx, { edgeHost: 'edge.invalid' });
  assert.equal((await call(stranger, 'GET', '/api/admin/stats', { headers: worker })).status, 403);
});

// ---- who may reach the reviewer's and the visitors' endpoints -----------------------------

test('visitor and reviewer endpoints answer only requests that come through nginx', async (t) => {
  const ctx = setup(t);
  const stranger = await serve(t, ctx, { edgeHost: 'edge.invalid' });
  const edge = await serve(t, ctx);

  for (const [method, path] of [['GET', '/api/admin/stats'], ['GET', '/api/admin/candidates'], ['GET', '/api/admin/export'], ['GET', '/api/admin/cover/anything'], ['GET', '/api/submissions/anything']]) {
    assert.equal((await call(stranger, method, path)).status, 403, `${method} ${path} from a stranger`);
  }
  for (const path of ['/api/submit', '/api/admin/candidates', '/api/admin/discover', '/api/admin/bulk']) {
    assert.equal((await call(stranger, 'POST', path, { headers: JSON_HEADERS, body: {} })).status, 403, `POST ${path} from a stranger`);
  }
  assert.equal((await call(stranger, 'GET', '/api/health')).status, 200, 'health is open (the container healthcheck uses it)');
  assert.equal((await call(edge, 'GET', '/api/admin/stats')).status, 200);
});

// ---- a page on another site cannot drive the reviewer's browser ---------------------------

test('browser writes must be json and must come from our own pages', async (t) => {
  const ctx = setup(t);
  const base = await serve(t, ctx);
  const host = new URL(base).host;
  const add = (headers) => call(base, 'POST', '/api/admin/candidates', { headers, body: { urls: ['https://csrf.example.com/'] } });

  assert.equal((await add({ 'content-type': 'text/plain' })).status, 415, 'a plain form post');
  assert.equal((await add({ 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await add({ ...JSON_HEADERS, origin: 'https://evil.example.net' })).status, 403, 'json from another site');
  assert.equal((await add({ ...JSON_HEADERS, origin: 'null' })).status, 403, 'a sandboxed frame');
  assert.equal((await add({ ...JSON_HEADERS, origin: `http://${host}.evil.example.net` })).status, 403);
  assert.equal(ctx.store.list({}).total, 0, 'none of that stored anything');

  assert.equal((await add({ ...JSON_HEADERS, origin: `http://${host}` })).status, 200, 'our own page');
  assert.equal((await add({ ...JSON_HEADERS })).status, 200, 'no Origin header: not a cross-site browser request');
  assert.equal(ctx.store.list({}).total, 1);
});

// ---- visitors -----------------------------------------------------------------------------

test('a submission: accepted, anonymised, and the status page shows only what a visitor may see', async (t) => {
  const ctx = setup(t, { limits: { submitPerIpPerDay: 5, submitPerDay: 50 } });
  const base = await serve(t, ctx);
  const send = (url, extra = {}) => call(base, 'POST', '/api/submit', { headers: { ...JSON_HEADERS, 'x-client-ip': '203.0.113.7' }, body: { url, ...extra } });

  const r = await send('https://play.example.com/', { note: '很好玩' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.created, r.json.state], [true, 'checking']);
  const stored = ctx.db.prepare('SELECT submitter, note FROM candidates').get();
  assert.match(stored.submitter, /^[0-9a-f]{16}$/, 'only a salted hash of the address is kept');
  assert.equal(stored.note, '很好玩');

  const status = await call(base, 'GET', `/api/submissions/${r.json.id}`);
  assert.deepEqual(Object.keys(status.json).sort(), ['facts', 'id', 'state', 'title']);
  assert.equal(status.json.state, 'checking');

  const bot = await send('https://bot.example.com/', { hp: 'http://spam' });
  assert.equal(bot.status, 200, 'a bot is told it worked');
  assert.equal(ctx.store.list({}).total, 1, 'but nothing was stored');

  assert.equal((await send('http://169.254.169.254/latest/meta-data/')).status, 400);
  assert.equal((await send('http://127.0.0.1:3000/api/admin/stats')).status, 400);
});

test('the status page is not a way to browse the queue', async (t) => {
  const ctx = setup(t);
  const base = await serve(t, ctx);
  const added = ctx.store.addCandidate({ url: 'https://hn.example.com/', origin: 'hn', source: { type: 'hn', points: 99 } });
  assert.equal((await call(base, 'GET', `/api/submissions/${added.id}`)).status, 404, 'not submitted by a visitor');
  assert.equal((await call(base, 'GET', '/api/submissions/does-not-exist')).status, 404);
  assert.equal((await call(base, 'GET', '/api/submissions/..%2f..%2fetc')).status, 404);
});

test('the same visitor is limited, a different one is not', async (t) => {
  const ctx = setup(t); // 2 per visitor, 3 per day
  const base = await serve(t, ctx);
  const send = (n, ip) => call(base, 'POST', '/api/submit', { headers: { ...JSON_HEADERS, 'x-client-ip': ip }, body: { url: `https://site${n}.example.com/` } });
  assert.equal((await send(1, '198.51.100.1')).status, 200);
  assert.equal((await send(2, '198.51.100.1')).status, 200);
  const third = await send(3, '198.51.100.1');
  assert.equal(third.status, 429);
  assert.equal(third.json.error.code, 'quota');
  assert.equal((await send(4, '198.51.100.2')).status, 200);
  assert.equal((await send(5, '198.51.100.3')).json.error.code, 'busy', 'and the whole site has a daily ceiling');
});

test('request bodies are limited', async (t) => {
  const base = await serve(t, setup(t));
  const r = await call(base, 'POST', '/api/submit', { headers: JSON_HEADERS, body: JSON.stringify({ url: 'https://a.example.com/', note: 'x'.repeat(120 * 1024) }) });
  assert.equal(r.status, 413);
  const bad = await call(base, 'POST', '/api/submit', { headers: JSON_HEADERS, body: '{not json' });
  assert.equal(bad.status, 400);
});

// ---- hostile request targets --------------------------------------------------------------

test('a malformed address is a 400, not a dead service', async (t) => {
  const ctx = setup(t);
  const base = await serve(t, ctx, { serveCatalog: true });
  // "//[" made `new URL` throw outside the handler and took the whole process down.
  assert.equal((await call(base, 'GET', '//[')).status, 400);
  assert.equal((await call(base, 'GET', '/api/admin/candidates/%E0%A4%A')).status, 400);
  assert.equal((await call(base, 'GET', '/catalog/%E0%A4%A')).status, 404);
  assert.equal((await call(base, 'GET', '/api/health')).status, 200, 'still alive');
});

test('route and file lookups cannot leave their directories', async (t) => {
  const ctx = setup(t);
  mkdirSync(ctx.paths.catalogDir, { recursive: true });
  writeFileSync(join(ctx.paths.catalogDir, 'published.json'), '[]');
  writeFileSync(join(ctx.paths.catalogDir, '..', 'secret.txt'), 'private');
  const base = await serve(t, ctx, { serveCatalog: true });

  const ok = await call(base, 'GET', '/catalog/published.json');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['cache-control'], 'no-cache');
  for (const path of ['/catalog/../secret.txt', '/catalog/..%2fsecret.txt', '/catalog/%2e%2e/secret.txt', '/catalog/shots/../../secret.txt', '/catalog/..%5csecret.txt']) {
    const r = await call(base, 'GET', path);
    assert.notEqual(r.status, 200, path);
    assert.ok(!r.raw.toString().includes('private'), path);
  }
  assert.equal((await call(await serve(t, ctx, { serveCatalog: false }), 'GET', '/catalog/published.json')).status, 404, 'in production nginx serves it, not us');
});

test('raw screenshots go to the reviewer only, by id only', async (t) => {
  const ctx = setup(t);
  const base = await serve(t, ctx);
  const { id } = await ctx.intake.submit({ url: 'https://play.example.com/' });
  ctx.intake.handleResult(ctx.intake.claim('w').id, { result: good(), cover: b64(webp(1500)) });
  const r = await call(base, 'GET', `/api/admin/cover/${id}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/webp');
  assert.match(r.headers['cache-control'], /^private/);
  assert.equal((await call(base, 'GET', `/api/admin/cover/${id}?kind=embed`)).status, 404, 'no embedded view was saved');
  for (const path of ['/api/admin/cover/..%2f..%2fapp', '/api/admin/cover/Not_An_Id', '/api/admin/cover/nope']) {
    assert.equal((await call(base, 'GET', path)).status, 404, path);
  }
  const stranger = await serve(t, ctx, { edgeHost: 'edge.invalid' });
  assert.equal((await call(stranger, 'GET', `/api/admin/cover/${id}`)).status, 403);
});

test('unknown routes and wrong methods are 404', async (t) => {
  const base = await serve(t, setup(t));
  assert.equal((await call(base, 'GET', '/nope')).status, 404);
  assert.equal((await call(base, 'DELETE', '/api/admin/candidates/x', { headers: JSON_HEADERS })).status, 404);
  assert.equal((await call(base, 'GET', '/internal/claim', { headers: { 'x-worker-token': 'sekret-token-123' } })).status, 404);
});
