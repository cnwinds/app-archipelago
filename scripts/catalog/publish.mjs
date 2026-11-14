// Join candidates, health-check drafts and review decisions into the file the site loads.
//
//   node scripts/catalog/publish.mjs
//
// A work is published only if it was reachable at ingest time AND a reviewer approved it
// in catalog/curation.json.

import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { PATHS, readJson, writeJson } from './lib.mjs';

const CATEGORY_IDS = ['game', 'ai', 'creative', 'productivity', 'music', 'edu'];

// Initial quality score from the only real signal we have so far. Thresholds used by the
// site: >= 90 castle, >= 70 house, otherwise hut. A reviewer can override with `score`.
function scoreFromSignals(source) {
  if (source?.type === 'hn') return Math.round(Math.min(99, Math.max(40, 20 + 25.5 * Math.log10(source.points))));
  return 60;
}

const sources = readJson(PATHS.sources, []);
const drafts = readJson(PATHS.drafts, {});
const curation = readJson(PATHS.curation, {});

const stats = { candidates: sources.length, unreachable: 0, pending: 0, rejected: 0, published: 0, embeddable: 0 };
const problems = [];
const out = [];
for (const src of sources) {
  const d = drafts[src.id];
  const c = curation[src.id];
  if (!d?.ok) {
    stats.unreachable++;
    continue;
  }
  if (!c) {
    stats.pending++;
    continue;
  }
  if (c.status !== 'approved') {
    stats.rejected++;
    continue;
  }
  if (!CATEGORY_IDS.includes(c.category) || !c.blurb || !c.name) {
    problems.push(`${src.id}: approved but missing a valid category, name or blurb`);
    continue;
  }
  out.push({
    id: src.id,
    name: c.name,
    url: d.finalUrl,
    category: c.category,
    tags: c.tags ?? [],
    blurb: c.blurb,
    score: c.score ?? scoreFromSignals(src.source),
    author: src.source?.author ?? d.meta?.author ?? null,
    // Only a real posting date counts. Hand-added works have none and must not look new.
    postedAt: src.source?.postedAt ?? null,
    // A reviewer can force a new tab with `"embed": false`, e.g. for works that need the
    // microphone or camera, which our sandboxed iframe does not hand out.
    embed: d.embed.ok && c.embed !== false,
    shot: d.shot,
    source: src.source ? { type: src.source.type, link: src.source.link, points: src.source.points } : null,
  });
  stats.published++;
  if (out.at(-1).embed) stats.embeddable++;
}

for (const id of Object.keys(curation)) if (!sources.some((s) => s.id === id)) problems.push(`${id}: in curation.json but not in sources.json`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
writeJson(PATHS.published, out);

// The site only carries covers of published works: copy those in, drop everything else.
mkdirSync(PATHS.publicShots, { recursive: true });
const wanted = new Set(out.map((a) => a.shot));
for (const file of readdirSync(PATHS.publicShots)) if (!wanted.has(file)) rmSync(`${PATHS.publicShots}/${file}`);
for (const file of wanted) copyFileSync(`${PATHS.shots}/${file}`, `${PATHS.publicShots}/${file}`);

const perCat = Object.fromEntries(CATEGORY_IDS.map((id) => [id, out.filter((a) => a.category === id).length]));
console.log(stats, perCat);
