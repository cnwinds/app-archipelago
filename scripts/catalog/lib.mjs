import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const PATHS = {
  sources: 'catalog/sources.json',
  drafts: 'catalog/drafts.json',
  curation: 'catalog/curation.json',
  published: 'catalog/published.json',
  // Every candidate's cover lives outside the site; publish copies the approved ones in.
  shots: 'catalog/shots',
  publicShots: 'public/catalog/shots',
};

export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

const TRANSIENT = new Set(['UNKNOWN', 'EBUSY', 'EPERM', 'EACCES']);

// Write beside the target, then swap it in, so a crash never leaves a half-written file.
// On Windows a file watcher or virus scanner can hold the target for a moment: retry briefly.
export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      if (!TRANSIENT.has(e.code) || attempt === 20) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

export function parseArgs(argv, defaults = {}) {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = typeof defaults[key] === 'number' ? Number(next) : next;
      i++;
    }
  }
  return out;
}

// Same work must always map to the same key, whatever tracking junk the link carries.
export function normalizeUrl(raw) {
  const u = new URL(raw);
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|ref_|source$|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname === '') u.pathname = '/';
  return u.toString();
}

export function slugFor(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, '');
  const path = u.pathname.replace(/\/(index\.html?)?$/, '');
  return (host + path)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
