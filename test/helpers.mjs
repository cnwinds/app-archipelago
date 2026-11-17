// Shared scaffolding for the service tests: an in-memory database, a temp data directory and a
// model that always answers the same draft. Not a test file itself.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.mjs';
import { createIntake } from '../server/intake.mjs';
import { createStore } from '../server/store.mjs';

export function setup(t, { limits } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'isle-test-'));
  const catalogDir = join(dir, 'public', 'catalog');
  const paths = { shots: join(dir, 'shots'), catalogDir, publicShots: join(catalogDir, 'shots'), published: join(catalogDir, 'published.json') };
  const config = { paths, checkDns: false, limits: { submitPerIpPerDay: 2, submitPerDay: 3, analysesPerHour: 2, ...limits } };
  const db = openDb(':memory:');
  const store = createStore(db);
  let drafts = 0;
  const llm = {
    async draft() {
      drafts++;
      return { source: 'test', category: 'game', name: 'Drafted', tags: ['demo'], blurb: '草稿介绍', flags: [] };
    },
  };
  const intake = createIntake({ store, config, llm, log: () => {} });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { paths, config, db, store, intake, drafts: () => drafts };
}

export const webp = (bytes) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(bytes)]);
export const b64 = (buf) => buf.toString('base64');
export const good = (over = {}) => ({
  ok: true,
  reach: 'ok',
  loadMs: 900,
  httpStatus: 200,
  finalUrl: 'https://play.example.com/',
  embed: { ok: true, reason: null, warnings: [] },
  meta: { title: 'Play Example' },
  jsErrors: 0,
  ...over,
});
export const bad = (errorKind, error = 'boom') => ({ ok: false, errorKind, error });
export const tick = () => new Promise((r) => setTimeout(r, 15));
