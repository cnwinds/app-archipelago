// Add candidates by hand (a submission, a tip, something you found yourself).
//
//   node scripts/catalog/add.mjs <url> [<url> ...]
//
// They go through the same ingest -> review -> publish steps as discovered ones. Hand-added
// works carry no posting date and no popularity signal, so they are never shown as "new"
// and start at the default score until a reviewer sets one in catalog/curation.json.

import { PATHS, readJson, writeJson, normalizeUrl, slugFor } from './lib.mjs';

const urls = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!urls.length) {
  console.error('usage: node scripts/catalog/add.mjs <url> [<url> ...]');
  process.exit(1);
}

const sources = readJson(PATHS.sources, []);
const ids = new Set(sources.map((s) => s.id));
const known = new Set(sources.map((s) => s.url));
for (const raw of urls) {
  const url = normalizeUrl(raw);
  const id = slugFor(url);
  if (known.has(url) || ids.has(id)) {
    console.log(`already a candidate: ${id}`);
    continue;
  }
  sources.push({ id, url, title: new URL(url).hostname.replace(/^www\./, '') });
  ids.add(id);
  known.add(url);
  console.log(`added ${id}`);
}
writeJson(PATHS.sources, sources);
