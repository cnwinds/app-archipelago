// One-time import of the old file-based catalog (catalog/sources.json, drafts.json, curation.json
// and catalog/shots/) into an empty database, so nothing the reviewer already decided is lost.
// Re-running it on a database that already has candidates does nothing.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coverFile } from './files.mjs';
import { nowIso } from './store.mjs';

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);

export function seedFromCatalog({ store, intake, config, log = console.log }) {
  const dir = config.seedDir;
  if (!existsSync(join(dir, 'sources.json'))) return null;
  if (store.db.prepare('SELECT COUNT(*) n FROM candidates').get().n > 0) return null;

  const sources = readJson(join(dir, 'sources.json'), []);
  const drafts = readJson(join(dir, 'drafts.json'), {});
  const curation = readJson(join(dir, 'curation.json'), {});
  mkdirSync(config.paths.shots, { recursive: true });

  const stats = { imported: 0, approved: 0, rejected: 0, pending: 0, failed: 0, queued: 0, covers: 0 };
  store.tx(() => {
    for (const s of sources) {
      const d = drafts[s.id];
      const c = curation[s.id];
      const state = !d ? 'queued' : !d.ok ? 'failed' : !c ? 'pending_review' : c.status === 'approved' ? 'approved' : 'rejected';
      store.addCandidate({
        id: s.id,
        url: s.url,
        title: s.title ?? '',
        origin: s.source ? 'hn' : 'seed',
        source: s.source ?? null,
        state,
        createdAt: d?.checkedAt,
      });
      stats.imported++;

      if (d) {
        store.saveAnalysis(s.id, {
          checkedAt: d.checkedAt,
          ok: d.ok,
          error: d.error,
          errorKind: d.ok ? null : 'other',
          // Measured from a developer's machine, which says nothing about visitors in China:
          // the first recheck from the server fills this in.
          reach: null,
          loadMs: d.loadMs,
          httpStatus: d.httpStatus,
          finalUrl: d.finalUrl,
          embed: d.embed,
          meta: d.meta,
          jsErrors: d.jsErrors,
          coverBytes: d.shotBytes,
          coverNote: d.shotNote,
          hasEmbedShot: false,
        });
        const shot = join(dir, 'shots', d.shot ?? `${s.id}.webp`);
        if (d.ok && existsSync(shot)) {
          copyFileSync(shot, coverFile(config.paths, s.id));
          stats.covers++;
        }
      }
      if (c?.status === 'approved') {
        store.saveCuration(s.id, {
          category: c.category,
          name: c.name,
          tags: c.tags ?? [],
          blurb: c.blurb,
          score: c.score ?? null,
          embedOverride: c.embed === false ? false : null,
          decidedAt: nowIso(),
        });
      } else if (c?.status === 'rejected') {
        store.saveCuration(s.id, { reason: c.reason ?? '', decidedAt: nowIso() });
      }
      if (!d) store.enqueue(s.id, 'analyze', { priority: 1 });
      stats[{ approved: 'approved', rejected: 'rejected', pending_review: 'pending', failed: 'failed', queued: 'queued' }[state]]++;
    }
  });

  const published = intake.publish();
  // Look at every live work once from here, so the site knows how each one loads for visitors in China.
  const rechecks = intake.enqueueRechecks();
  store.kvSet('last_recheck', nowIso());
  log(`seed: ${JSON.stringify(stats)}; published ${published.count} (${published.embeddable} embeddable); ${rechecks} rechecks queued`);
  return { ...stats, published };
}
