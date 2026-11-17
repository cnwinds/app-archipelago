// Things that happen on their own. One loop wakes up every minute and asks, for each chore,
// "is it due?". When the last run happened is kept in the database, so a restart neither
// repeats a chore nor forgets one.

import { readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from './store.mjs';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const KEEP_BACKUPS = 7;

// The server clock is UTC; people live in China.
const hourInChina = (date) => (date.getUTCHours() + 8) % 24;
const stamp = (date) => date.toISOString().slice(0, 10).replace(/-/g, '');

export function createScheduler({ store, intake, discover, config, log = console.log, fetchImpl = fetch, tickMs = 60000 }) {
  const age = (key) => {
    const v = store.kvGet(key);
    return v ? Date.now() - Date.parse(v) : Infinity;
  };

  function backup(date = new Date()) {
    const { backups } = config.paths;
    mkdirSync(backups, { recursive: true });
    const base = join(backups, `app-${stamp(date)}`);
    rmSync(`${base}.db`, { force: true });
    store.backupTo(`${base}.db`);
    // The decisions as plain json, readable without sqlite and importable by hand.
    writeFileSync(`${base}.curation.json`, JSON.stringify(store.exportCuration(), null, 1));
    for (const ext of ['.db', '.curation.json']) {
      const mine = readdirSync(backups).filter((f) => f.startsWith('app-') && f.endsWith(ext)).sort();
      for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) rmSync(join(backups, old), { force: true });
    }
    store.kvSet('last_backup', nowIso());
    log(`backup written: ${base}.db`);
  }

  async function digest() {
    const counts = store.counts();
    store.kvSet('last_digest', nowIso());
    if (!config.notify.webhook || counts.pending_review === 0) return false;
    const content = `应用群岛：${counts.pending_review} 个作品等待审核${counts.failed ? `，${counts.failed} 个体检失败` : ''}。${config.notify.siteUrl}/admin/`;
    const bodies = {
      feishu: { msg_type: 'text', content: { text: content } },
      wecom: { msgtype: 'text', text: { content } },
      json: { text: content },
    };
    const res = await fetchImpl(config.notify.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodies[config.notify.format] ?? bodies.json),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`webhook ${res.status}`);
    return true;
  }

  // Runs every chore that is due. Errors are logged and never stop the loop.
  async function tick(date = new Date()) {
    const attempt = async (name, fn) => {
      try {
        await fn();
      } catch (e) {
        log(`scheduler: ${name} failed: ${e.message}`);
      }
    };
    // A failed discovery is tried again after an hour, not every minute.
    if (config.discover.enabled && age('last_discover') > DAY && age('last_discover_try') > HOUR) await attempt('discover', () => discover.run());
    if (age('last_recheck') > 7 * DAY) {
      await attempt('recheck', () => {
        const n = intake.enqueueRechecks();
        store.kvSet('last_recheck', nowIso());
        log(`scheduler: queued ${n} rechecks`);
      });
    }
    if (age('last_backup') > DAY && hourInChina(date) >= 3) await attempt('backup', () => backup(date));
    if (config.notify.webhook && age('last_digest') > DAY && hourInChina(date) >= 9) await attempt('digest', digest);
  }

  let timer = null;
  return {
    tick,
    backup,
    digest,
    start() {
      tick().catch((e) => log(`scheduler: ${e.message}`));
      timer = setInterval(() => tick().catch((e) => log(`scheduler: ${e.message}`)), tickMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
