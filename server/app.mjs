// The HTTP side. Three kinds of caller, three kinds of trust:
//
//   /api/submit, /api/submissions/*   visitors, through nginx
//   /api/admin/*                      the reviewer, through nginx (which asks for the password)
//   /internal/*                       the worker, with a token, on the private docker network
//
// Visitor and reviewer endpoints only answer requests that come from the nginx container, so
// even a compromised worker (a browser that opens strangers' pages) cannot call the admin api.
// nginx never forwards /internal/.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import dns from 'node:dns/promises';
import { extname, join, normalize } from 'node:path';
import { coverFile, embedFile } from './files.mjs';
import { UserError } from './urlcheck.mjs';

const PUBLIC_STATE = {
  queued: 'checking',
  analyzing: 'checking',
  pending_review: 'review',
  approved: 'live',
  rejected: 'declined',
  hidden: 'declined',
  failed: 'failed',
};
const MIME = { '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png' };
const ID = /^[a-z0-9-]{1,60}$/;

function compile(pattern) {
  const keys = [];
  const source = pattern.replace(/:([a-zA-Z]+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  });
  return { re: new RegExp(`^${source}/?$`), keys };
}

async function readJson(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new UserError('too_large', 'request body too large', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw new UserError('bad_json', 'body is not valid json');
  }
}

export function createApp({ store, intake, discover, scheduler, config, log = console.log }) {
  const routes = [];
  const route = (method, pattern, auth, handler, { limit = 64 * 1024 } = {}) => routes.push({ method, ...compile(pattern), auth, handler, limit });

  // ---- who is asking ----------------------------------------------------------------------

  let edge = { at: 0, ips: new Set() };
  async function fromEdge(req) {
    if (!config.edgeHost) return true;
    if (Date.now() - edge.at > 30000) {
      try {
        const found = await dns.lookup(config.edgeHost, { all: true });
        edge = { at: Date.now(), ips: new Set(found.map((r) => r.address)) };
      } catch {
        // keep the last known addresses
      }
    }
    return edge.ips.has((req.socket.remoteAddress || '').replace(/^::ffff:/, ''));
  }

  function fromWorker(req) {
    if (!config.workerToken) return !config.production;
    const given = Buffer.from(String(req.headers['x-worker-token'] || ''));
    const want = Buffer.from(config.workerToken);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  // Visitors are only ever stored as a salted hash of their address.
  function visitor(req) {
    let salt = store.kvGet('ip_salt');
    if (!salt) store.kvSet('ip_salt', (salt = createHmac('sha256', String(Math.random())).update(String(Date.now())).digest('hex')));
    const ip = String(req.headers['x-client-ip'] || req.socket.remoteAddress || '').split(',')[0].trim();
    return createHmac('sha256', salt).update(ip).digest('hex').slice(0, 16);
  }

  // The reviewer's browser sends the password automatically, so a page on another site could try
  // to make it call us. A JSON content type cannot be sent cross-site without a CORS preflight
  // (which we never approve), and the Origin header, when present, must be ours.
  function guardBrowserWrite(req) {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new UserError('content_type', 'content-type must be application/json', 415);
    const origin = req.headers.origin;
    if (origin) {
      let host = null;
      try {
        host = new URL(origin).host;
      } catch {
        // falls through to the refusal below
      }
      if (host !== req.headers.host) throw new UserError('origin', 'cross-site request refused', 403);
    }
  }

  // ---- visitors ---------------------------------------------------------------------------

  route('GET', '/api/health', 'open', () => ({ ok: true, queued: store.queueLength() }));

  route('POST', '/api/submit', 'edge', async ({ body, req }) => {
    // A form field no person sees: bots fill it. Pretend it worked.
    if (body.hp) return { id: null, state: 'checking' };
    const submitter = visitor(req);
    intake.checkQuota(submitter);
    const r = await intake.submit({ url: body.url, note: body.note, submitter });
    return { id: r.id, created: r.created, state: PUBLIC_STATE[r.state] ?? 'checking' };
  });

  route('GET', '/api/submissions/:id', 'edge', ({ params }) => {
    const c = ID.test(params.id) ? store.get(params.id) : null;
    // Only things that came in through the submission page: this is not a way to browse the queue.
    if (!c || c.origin !== 'submit') throw new UserError('not_found', '没有找到这个投稿', 404);
    const a = c.analysis?.ok ? c.analysis : null;
    return {
      id: c.id,
      state: PUBLIC_STATE[c.state] ?? 'checking',
      title: a?.meta?.title || c.title,
      facts: a ? { loadMs: a.loadMs, embeddable: !!a.embed?.ok, slow: a.reach === 'slow' } : null,
    };
  });

  // ---- the reviewer -----------------------------------------------------------------------

  const admin = (method, pattern, handler, opts) => route(method, `/api/admin${pattern}`, 'edge', handler, opts);
  const need = (id) => {
    const c = ID.test(id) ? store.get(id) : null;
    if (!c) throw new UserError('not_found', '没有这个作品', 404);
    return c;
  };

  admin('GET', '/stats', () => intake.stats());

  admin('GET', '/candidates', ({ query }) => {
    const states = query.get('state')?.split(',').filter(Boolean);
    return store.list({
      states,
      origin: query.get('origin') || undefined,
      q: query.get('q') || undefined,
      limit: Math.min(200, Number(query.get('limit')) || 50),
      offset: Math.max(0, Number(query.get('offset')) || 0),
      order: query.get('order') || 'review',
    });
  });

  admin('GET', '/candidates/:id', ({ params }) => need(params.id));

  admin('POST', '/candidates', async ({ body }) => {
    const urls = (Array.isArray(body.urls) ? body.urls : String(body.urls ?? '').split(/\s+/)).filter(Boolean);
    if (!urls.length) throw new UserError('empty', '请贴一个或多个网址');
    return { results: await intake.addUrls(urls) };
  });

  admin('PATCH', '/candidates/:id', ({ params, body }) => {
    need(params.id);
    intake.edit(params.id, body);
    return store.get(params.id);
  });

  admin('POST', '/candidates/:id/approve', ({ params, body }) => {
    need(params.id);
    intake.approve(params.id, body);
    return store.get(params.id);
  });
  admin('POST', '/candidates/:id/reject', ({ params, body }) => {
    need(params.id);
    intake.reject(params.id, body.reason);
    return store.get(params.id);
  });
  admin('POST', '/candidates/:id/unpublish', ({ params }) => {
    need(params.id);
    intake.unpublish(params.id);
    return store.get(params.id);
  });
  admin('POST', '/candidates/:id/reanalyze', ({ params, body }) => {
    need(params.id);
    intake.reanalyze(params.id, { lateMs: body.lateMs });
    return store.get(params.id);
  });
  admin('POST', '/candidates/:id/redraft', async ({ params }) => {
    need(params.id);
    await intake.draft(params.id, { force: true });
    return store.get(params.id);
  });

  admin('POST', '/bulk', ({ body }) => {
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter((id) => ID.test(id)).slice(0, 200);
    if (!['reject', 'reanalyze'].includes(body.action)) throw new UserError('action', 'unknown action');
    for (const id of ids) {
      if (!store.get(id)) continue;
      if (body.action === 'reject') intake.reject(id, body.reason);
      else intake.reanalyze(id, {});
    }
    return { done: ids.length };
  });

  admin('POST', '/discover', async () => ({ stats: await discover.run() }));
  admin('POST', '/backup', () => {
    scheduler.backup();
    return { ok: true };
  });
  admin('GET', '/export', () => store.exportCuration());

  // Raw screenshots of candidates are private: only the reviewer sees them.
  admin('GET', '/cover/:id', ({ params, query }) => {
    if (!ID.test(params.id)) throw new UserError('not_found', 'not found', 404);
    const file = query.get('kind') === 'embed' ? embedFile(config.paths, params.id) : coverFile(config.paths, params.id);
    if (!existsSync(file)) throw new UserError('not_found', 'not found', 404);
    return { file, type: 'image/webp', cache: 'private, max-age=60' };
  });

  // ---- the worker -------------------------------------------------------------------------

  route('POST', '/internal/claim', 'worker', ({ body }) => ({ job: intake.claim(String(body.worker || 'worker').slice(0, 40)) }));
  route(
    'POST',
    '/internal/jobs/:id/result',
    'worker',
    ({ params, body }) => intake.handleResult(Number(params.id), body),
    { limit: 8 * 1024 * 1024 },
  );

  // ---- local development: no nginx, so serve the published catalog ourselves ---------------

  function staticCatalog(url) {
    let rel;
    try {
      rel = normalize(decodeURIComponent(url.pathname.slice('/catalog/'.length)));
    } catch {
      return null; // not valid percent-encoding
    }
    if (rel.startsWith('..') || rel.includes('\0')) return null;
    const file = join(config.paths.catalogDir, rel);
    return existsSync(file) && statSync(file).isFile() ? { file, type: MIME[extname(file)] ?? 'application/octet-stream', cache: 'no-cache' } : null;
  }

  // ---- plumbing ---------------------------------------------------------------------------

  const sendJson = (res, status, data) => {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  const sendFile = (res, { file, type, cache }) => {
    res.writeHead(200, { 'content-type': type, 'cache-control': cache, 'content-length': statSync(file).size });
    createReadStream(file).pipe(res);
  };

  async function handle(req, res) {
    // A request target nobody should send ("//[" is enough) makes URL throw. That must be a 400,
    // not an exception that takes the whole service down.
    let url;
    try {
      url = new URL(req.url, 'http://local');
    } catch {
      return sendJson(res, 400, { error: { code: 'bad_request', message: 'bad request address' } });
    }
    try {
      if (config.serveCatalog && req.method === 'GET' && url.pathname.startsWith('/catalog/')) {
        const found = staticCatalog(url);
        if (!found) throw new UserError('not_found', 'not found', 404);
        return sendFile(res, found);
      }
      const matched = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!matched) throw new UserError('not_found', 'not found', 404);
      if (matched.auth === 'edge' && !(await fromEdge(req))) throw new UserError('forbidden', 'forbidden', 403);
      if (matched.auth === 'worker' && !fromWorker(req)) throw new UserError('forbidden', 'forbidden', 403);
      const writes = req.method !== 'GET' && req.method !== 'HEAD';
      if (writes && matched.auth === 'edge') guardBrowserWrite(req);
      const m = matched.re.exec(url.pathname);
      let params;
      try {
        params = Object.fromEntries(matched.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      } catch {
        throw new UserError('bad_request', 'bad request address', 400);
      }
      const body = writes ? await readJson(req, matched.limit) : {};
      const result = await matched.handler({ req, params, query: url.searchParams, body });
      if (result?.file) return sendFile(res, result);
      sendJson(res, 200, result ?? { ok: true });
    } catch (e) {
      if (e instanceof UserError) return sendJson(res, e.status, { error: { code: e.code, message: e.message } });
      log(`${req.method} ${url.pathname} failed: ${e.stack || e}`);
      sendJson(res, 500, { error: { code: 'internal', message: 'internal error' } });
    }
  }

  // Last line of defence: whatever goes wrong while answering one request, the others go on.
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`${req.method} ${req.url} crashed the handler: ${e.stack || e}`);
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: { code: 'internal', message: 'internal error' } });
    });
  });
  server.requestTimeout = 60000;
  server.keepAliveTimeout = 5000;
  return { server, handle };
}
