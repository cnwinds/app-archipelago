// The worker: asks the api for a job, opens the page in Chromium behind the egress proxy,
// reports what it saw, repeats. It holds no secrets except the token that lets it ask for jobs,
// and it can be run anywhere that can reach the api (the server, or a dev machine).

import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAnalyzer, withTimeout } from './analyze.mjs';
import { startEgressProxy } from './egress-proxy.mjs';

const API_URL = (process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.WORKER_TOKEN || '';
const WORKER_ID = process.env.WORKER_ID || `worker-${hostname()}`;
const POLL_MS = Number(process.env.POLL_MS || 5000);
// A page that outlives this is given up on, and the browser is replaced in case it is the one stuck.
const JOB_DEADLINE_MS = 4 * 60 * 1000;
// Chromium is the heavy part and the server is shared: when no job has come for this long, close it.
// The next job starts it again (a second or two).
const IDLE_CLOSE_MS = Number(process.env.IDLE_CLOSE_MS || 60 * 1000);

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

async function api(path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-token': TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// On a developer machine the proxy would refuse everything (local DNS answers with fake private
// addresses), so it can be switched off there. On the server it must stay on.
let proxyUrl;
if (process.env.EGRESS_PROXY !== '0') {
  await startEgressProxy({ port: 3128, log });
  proxyUrl = 'http://127.0.0.1:3128';
}
const analyzer = createAnalyzer({ proxy: proxyUrl });
log(`worker ${WORKER_ID} ready; api ${API_URL}; egress proxy ${proxyUrl ?? 'off'}`);

let stopping = false;
let lastJobAt = 0; // 0 = the browser is not running
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    stopping = true;
    await analyzer.close();
    process.exit(0);
  });
}

while (!stopping) {
  try {
    const { job } = await api('/internal/claim', { worker: WORKER_ID });
    if (!job) {
      if (lastJobAt && Date.now() - lastJobAt > IDLE_CLOSE_MS) {
        await analyzer.close();
        lastJobAt = 0;
        log('idle: browser closed');
      }
      await sleep(POLL_MS);
      continue;
    }
    log(`job ${job.id} ${job.kind} ${job.candidate.url}`);
    const started = Date.now();
    lastJobAt = started;
    let result;
    try {
      result = await withTimeout(analyzer.analyze(job.candidate.url, { late: job.lateMs }), JOB_DEADLINE_MS + job.lateMs, 'analysis');
    } catch (e) {
      result = { ok: false, error: String(e.message || e).slice(0, 200), errorKind: 'network', checkedAt: new Date().toISOString() };
      await analyzer.close();
    }
    const { cover, embedShot, ...rest } = result;
    await api(`/internal/jobs/${job.id}/result`, {
      result: rest,
      cover: cover?.toString('base64') ?? null,
      embedShot: embedShot?.toString('base64') ?? null,
    });
    lastJobAt = Date.now();
    log(`job ${job.id} done in ${Math.round((Date.now() - started) / 1000)}s: ${result.ok ? `ok reach=${result.reach} embed=${result.embed?.ok ? 'yes' : result.embed?.reason}` : `FAIL ${result.error}`}`);
  } catch (e) {
    log(`worker error: ${e.message}`);
    await sleep(POLL_MS * 3);
  }
}
