// Pull recent Show HN posts that link to something a visitor can open in a browser,
// and merge them into catalog/sources.json as candidates.
//
//   node scripts/catalog/discover-hn.mjs [--days 45] [--min-points 30] [--limit 80]

import { PATHS, readJson, writeJson, parseArgs, normalizeUrl, slugFor } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), { days: 45, 'min-points': 30, limit: 80 });

// Links that are never "open and try it" — repos, stores, videos, documents, packages.
const SKIP_HOST =
  /(^|\.)(github\.com|gitlab\.com|codeberg\.org|sr\.ht|youtube\.com|youtu\.be|apps\.apple\.com|play\.google\.com|chromewebstore\.google\.com|chrome\.google\.com|addons\.mozilla\.org|npmjs\.com|pypi\.org|crates\.io|arxiv\.org|medium\.com|substack\.com|twitter\.com|x\.com|docs\.google\.com|marketplace\.visualstudio\.com|testflight\.apple\.com|huggingface\.co|news\.ycombinator\.com)$/i;
const SKIP_PATH = /\.(pdf|zip|dmg|exe|apk|mp4|tar\.gz)$|\/(blog|posts?|articles?|news)\//i;

const since = Math.floor(Date.now() / 1000) - args.days * 86400;
const hits = [];
for (let page = 0; page < 10; page++) {
  const api = new URL('https://hn.algolia.com/api/v1/search');
  api.searchParams.set('tags', 'show_hn');
  api.searchParams.set('numericFilters', `created_at_i>${since},points>=${args['min-points']}`);
  api.searchParams.set('hitsPerPage', '100');
  api.searchParams.set('page', String(page));
  const res = await fetch(api);
  if (!res.ok) throw new Error(`HN API ${res.status}`);
  const data = await res.json();
  hits.push(...data.hits);
  if (page + 1 >= data.nbPages) break;
}

const sources = readJson(PATHS.sources, []);
const known = new Set(sources.map((s) => s.url));
const stats = { fetched: hits.length, noUrl: 0, skipped: 0, duplicate: 0, added: 0 };

const candidates = [];
for (const h of hits) {
  if (!h.url) {
    stats.noUrl++;
    continue;
  }
  let url;
  try {
    url = normalizeUrl(h.url);
  } catch {
    stats.skipped++;
    continue;
  }
  const u = new URL(url);
  if (SKIP_HOST.test(u.hostname) || SKIP_PATH.test(u.pathname)) {
    stats.skipped++;
    continue;
  }
  candidates.push({
    id: slugFor(url),
    url,
    title: h.title.replace(/^Show HN:\s*/i, '').trim(),
    source: {
      type: 'hn',
      id: h.objectID,
      link: `https://news.ycombinator.com/item?id=${h.objectID}`,
      points: h.points,
      author: h.author,
      postedAt: h.created_at,
    },
  });
}

candidates.sort((a, b) => b.source.points - a.source.points);
const ids = new Set(sources.map((s) => s.id));
for (const c of candidates) {
  if (stats.added >= args.limit) break;
  if (known.has(c.url) || ids.has(c.id)) {
    stats.duplicate++;
    continue;
  }
  sources.push(c);
  ids.add(c.id);
  stats.added++;
}

writeJson(PATHS.sources, sources);
console.log(stats, `-> ${sources.length} sources in ${PATHS.sources}`);
