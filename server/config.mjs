// All settings come from environment variables, so the same image runs on the server and on a
// dev machine. Nothing secret has a default.

import { join, resolve } from 'node:path';

const env = process.env;
const int = (name, fallback) => (env[name] === undefined || env[name] === '' ? fallback : Number(env[name]));

const dataDir = resolve(env.DATA_DIR || './data');
const catalogDir = join(dataDir, 'public', 'catalog');

export const config = {
  production: env.NODE_ENV === 'production',
  host: env.HOST || '0.0.0.0',
  port: int('PORT', 3000),

  dataDir,
  paths: {
    db: join(dataDir, 'app.db'),
    // Cover and embedded-view screenshots of every candidate. Never served to the public:
    // they are somebody else's pages and most candidates are never published.
    shots: join(dataDir, 'shots'),
    // What nginx serves at /catalog/: published.json and the covers of published works only.
    catalogDir,
    publicShots: join(catalogDir, 'shots'),
    published: join(catalogDir, 'published.json'),
    backups: join(dataDir, 'backups'),
  },
  // The old file-based catalog (sources/drafts/curation/shots). Imported once into an empty database.
  seedDir: resolve(env.SEED_DIR || './catalog'),

  // The worker (a browser opening strangers' pages) is the least trusted part. It may only call
  // /internal/*, and only with this token.
  workerToken: env.WORKER_TOKEN || '',
  // Docker service name of the nginx in front of us. Public and admin endpoints are answered only
  // for requests that come from it, so a compromised worker cannot reach the admin api.
  // Empty = answer everyone (local development).
  edgeHost: env.EDGE_HOST || '',
  // Serve /catalog/* ourselves (local development, where there is no nginx).
  serveCatalog: env.SERVE_CATALOG ? env.SERVE_CATALOG === '1' : env.NODE_ENV !== 'production',

  // Look the name up when a work is submitted. Turn off only on a dev machine whose DNS answers
  // with fake addresses (a proxy's 198.18.x.x), where every site would look "internal".
  checkDns: env.CHECK_DNS !== '0',

  limits: {
    submitPerIpPerDay: int('SUBMIT_PER_IP_PER_DAY', 5),
    submitPerDay: int('SUBMIT_PER_DAY', 60),
    // Background analyses (discovery, rechecks) per hour; submissions are not counted.
    analysesPerHour: int('ANALYSES_PER_HOUR', 20),
  },

  discover: {
    enabled: env.DISCOVER !== '0',
    days: int('DISCOVER_DAYS', 7),
    minPoints: int('DISCOVER_MIN_POINTS', 30),
    limit: int('DISCOVER_LIMIT', 40),
  },

  // Any OpenAI-compatible chat completions endpoint. Without a key, drafts fall back to what
  // the page says about itself and the reviewer writes the rest.
  llm: {
    baseUrl: (env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, ''),
    apiKey: env.LLM_API_KEY || '',
    model: env.LLM_MODEL || 'qwen-plus',
  },

  // Daily "N works waiting for review" message. NOTIFY_FORMAT: feishu | wecom | json
  notify: { webhook: env.NOTIFY_WEBHOOK || '', format: env.NOTIFY_FORMAT || 'json', siteUrl: env.SITE_URL || 'https://isle.ai-news.top' },
};
