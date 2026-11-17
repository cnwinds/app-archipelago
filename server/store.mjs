// Everything the api knows about candidates, as plain functions over one SQLite database.
// No HTTP in here, so it can be tested with an in-memory database.
//
// States of a candidate:
//   queued -> analyzing -> pending_review -> approved | rejected   (approved <-> hidden)
//                       \-> failed (after the retries are used up; the reviewer decides)

import { scoreFromSource } from '../shared/rules.mjs';
import { normalizeUrl, slugFor } from '../shared/url.mjs';

export const STATES = ['queued', 'analyzing', 'failed', 'pending_review', 'approved', 'rejected', 'hidden'];

export const nowIso = () => new Date().toISOString();
export const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
export const minutesFromNow = (m) => new Date(Date.now() + m * 60000).toISOString();

const parse = (text, fallback = null) => {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};
const flag = (v) => (v == null ? null : !!v);
const bit = (v) => (v == null ? null : v ? 1 : 0);

// A job whose worker vanished is put back this many times before the candidate is given up on.
const MAX_CRASHES = 3;

export function createStore(db) {
  const statements = new Map();
  const sql = (text) => {
    let stmt = statements.get(text);
    if (!stmt) statements.set(text, (stmt = db.prepare(text)));
    return stmt;
  };
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  function hydrate(id) {
    const c = sql('SELECT * FROM candidates WHERE id = ?').get(id);
    if (!c) return null;
    const a = sql('SELECT * FROM analyses WHERE candidate_id = ?').get(id);
    const u = sql('SELECT * FROM curation WHERE candidate_id = ?').get(id);
    const j = sql('SELECT * FROM jobs WHERE candidate_id = ? ORDER BY id DESC LIMIT 1').get(id);
    return {
      id: c.id,
      url: c.url,
      title: c.title,
      origin: c.origin,
      source: parse(c.source_json),
      // What the work scores when the reviewer does not set a score.
      autoScore: scoreFromSource(parse(c.source_json)),
      note: c.note,
      state: c.state,
      attention: c.attention,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      analysis: a && {
        checkedAt: a.checked_at,
        ok: !!a.ok,
        error: a.error,
        errorKind: a.error_kind,
        reach: a.reach,
        loadMs: a.load_ms,
        httpStatus: a.http_status,
        finalUrl: a.final_url,
        embed: a.embed_ok == null && !a.embed_reason ? null : { ok: !!a.embed_ok, reason: a.embed_reason, warnings: parse(a.warnings_json, []) },
        meta: parse(a.meta_json),
        jsErrors: a.js_errors,
        coverBytes: a.cover_bytes,
        coverNote: a.cover_note,
        hasEmbedShot: !!a.has_embed_shot,
      },
      curation: u && {
        category: u.category,
        name: u.name,
        tags: parse(u.tags_json, []),
        blurb: u.blurb,
        score: u.score,
        embedOverride: flag(u.embed_override),
        reason: u.reason,
        ai: parse(u.ai_json),
        decidedAt: u.decided_at,
      },
      job: j && { id: j.id, kind: j.kind, state: j.state, attempts: j.attempts, runAfter: j.run_after, lateMs: j.late_ms },
    };
  }

  return {
    db,
    tx,
    hydrate,

    kvGet: (key) => sql('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null,
    kvSet: (key, value) => void sql('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)),

    // Same URL (or the same slug) is the same work, however it arrived.
    // `id` and `createdAt` are only for importing existing data.
    addCandidate({ id: forcedId, url, title = '', origin, source = null, note = null, submitter = null, state = 'queued', createdAt }) {
      const normalized = normalizeUrl(url);
      const id = forcedId ?? slugFor(normalized);
      const existing = sql('SELECT id FROM candidates WHERE id = ? OR url = ?').get(id, normalized);
      if (existing) return { id: existing.id, created: false };
      const t = nowIso();
      sql(
        'INSERT INTO candidates (id, url, title, origin, source_json, note, submitter, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, normalized, title.slice(0, 200), origin, source ? JSON.stringify(source) : null, note, submitter, state, createdAt ?? t, t);
      return { id, created: true };
    },

    get: hydrate,

    list({ states, origin, q, limit = 50, offset = 0, order = 'review' } = {}) {
      const where = [];
      const params = [];
      if (states?.length) {
        where.push(`c.state IN (${states.map(() => '?').join(',')})`);
        params.push(...states);
      }
      if (origin) {
        where.push('c.origin = ?');
        params.push(origin);
      }
      if (q) {
        where.push("(c.id LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\' OR c.url LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')");
        const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`;
        params.push(like, like, like, like);
      }
      const from = 'FROM candidates c LEFT JOIN curation u ON u.candidate_id = c.id' + (where.length ? ` WHERE ${where.join(' AND ')}` : '');
      const orderBy =
        order === 'name'
          ? 'ORDER BY lower(COALESCE(u.name, c.title))'
          : order === 'recent'
            ? 'ORDER BY c.updated_at DESC'
            : // Someone is waiting for an answer on a submission: those first, then by Hacker News score.
              "ORDER BY (c.origin = 'submit') DESC, COALESCE(json_extract(c.source_json, '$.points'), 0) DESC, c.created_at DESC";
      const total = sql(`SELECT COUNT(*) n ${from}`).get(...params).n;
      const ids = sql(`SELECT c.id ${from} ${orderBy} LIMIT ? OFFSET ?`).all(...params, limit, offset).map((r) => r.id);
      return { total, items: ids.map(hydrate) };
    },

    counts() {
      const out = Object.fromEntries(STATES.map((s) => [s, 0]));
      for (const r of sql('SELECT state, COUNT(*) n FROM candidates GROUP BY state').all()) out[r.state] = r.n;
      return out;
    },

    setState(id, state, attention) {
      if (!STATES.includes(state)) throw new Error(`unknown state ${state}`);
      if (attention === undefined) sql('UPDATE candidates SET state = ?, updated_at = ? WHERE id = ?').run(state, nowIso(), id);
      else sql('UPDATE candidates SET state = ?, attention = ?, updated_at = ? WHERE id = ?').run(state, attention, nowIso(), id);
    },
    setAttention(id, attention) {
      sql('UPDATE candidates SET attention = ?, updated_at = ? WHERE id = ?').run(attention, nowIso(), id);
    },
    setTitle(id, title) {
      sql('UPDATE candidates SET title = ? WHERE id = ?').run(title.slice(0, 200), id);
    },

    // Only the keys present in `patch` change.
    saveCuration(id, patch) {
      const cur = sql('SELECT * FROM curation WHERE candidate_id = ?').get(id) ?? {};
      const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
      const next = {
        category: has('category') ? patch.category : (cur.category ?? null),
        name: has('name') ? patch.name : (cur.name ?? null),
        tags_json: has('tags') ? JSON.stringify(patch.tags ?? []) : (cur.tags_json ?? null),
        blurb: has('blurb') ? patch.blurb : (cur.blurb ?? null),
        score: has('score') ? patch.score : (cur.score ?? null),
        embed_override: has('embedOverride') ? bit(patch.embedOverride) : (cur.embed_override ?? null),
        reason: has('reason') ? patch.reason : (cur.reason ?? null),
        ai_json: has('ai') ? (patch.ai ? JSON.stringify(patch.ai) : null) : (cur.ai_json ?? null),
        decided_at: has('decidedAt') ? patch.decidedAt : (cur.decided_at ?? null),
      };
      sql(
        `INSERT INTO curation (candidate_id, category, name, tags_json, blurb, score, embed_override, reason, ai_json, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(candidate_id) DO UPDATE SET category = excluded.category, name = excluded.name, tags_json = excluded.tags_json,
           blurb = excluded.blurb, score = excluded.score, embed_override = excluded.embed_override, reason = excluded.reason,
           ai_json = excluded.ai_json, decided_at = excluded.decided_at`,
      ).run(id, next.category, next.name, next.tags_json, next.blurb, next.score, next.embed_override, next.reason, next.ai_json, next.decided_at);
    },

    saveAnalysis(id, r) {
      sql(
        `INSERT INTO analyses (candidate_id, checked_at, ok, error, error_kind, reach, load_ms, http_status, final_url, embed_ok, embed_reason,
           warnings_json, meta_json, js_errors, cover_bytes, cover_note, has_embed_shot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(candidate_id) DO UPDATE SET checked_at = excluded.checked_at, ok = excluded.ok, error = excluded.error,
           error_kind = excluded.error_kind, reach = excluded.reach, load_ms = excluded.load_ms, http_status = excluded.http_status,
           final_url = excluded.final_url, embed_ok = excluded.embed_ok, embed_reason = excluded.embed_reason,
           warnings_json = excluded.warnings_json, meta_json = excluded.meta_json, js_errors = excluded.js_errors,
           cover_bytes = excluded.cover_bytes, cover_note = excluded.cover_note, has_embed_shot = excluded.has_embed_shot`,
      ).run(
        id,
        r.checkedAt ?? nowIso(),
        r.ok ? 1 : 0,
        r.error ?? null,
        r.errorKind ?? null,
        r.reach ?? null,
        r.loadMs ?? null,
        r.httpStatus ?? null,
        r.finalUrl ?? null,
        r.embed ? bit(r.embed.ok) : null,
        r.embed?.reason ?? null,
        r.embed?.warnings?.length ? JSON.stringify(r.embed.warnings) : null,
        r.meta ? JSON.stringify(r.meta) : null,
        r.jsErrors ?? null,
        r.coverBytes ?? null,
        r.coverNote ?? null,
        r.hasEmbedShot ? 1 : 0,
      );
    },

    // ---- jobs -------------------------------------------------------------------------------

    // One open job per candidate. Asking again only makes a waiting job more urgent.
    enqueue(candidateId, kind, { priority = 1, runAfter = nowIso(), lateMs = 0 } = {}) {
      const open = sql("SELECT id, state, priority FROM jobs WHERE candidate_id = ? AND state IN ('queued', 'running') ORDER BY id DESC LIMIT 1").get(candidateId);
      if (open) {
        if (open.state === 'queued') sql('UPDATE jobs SET priority = ?, run_after = ?, late_ms = max(late_ms, ?) WHERE id = ?').run(Math.min(priority, open.priority), runAfter, lateMs, open.id);
        return { id: open.id, created: false };
      }
      const r = sql(
        "INSERT INTO jobs (candidate_id, kind, state, priority, run_after, late_ms, created_at) VALUES (?, ?, 'queued', ?, ?, ?, ?)",
      ).run(candidateId, kind, priority, runAfter, lateMs, nowIso());
      return { id: Number(r.lastInsertRowid), created: true };
    },

    // Hand the next due job to a worker. `hourlyCap` limits background work (priority >= 1)
    // so a burst of discoveries cannot keep the small server busy all day; submissions and
    // admin requests (priority 0) are never held back.
    claim(workerId, { hourlyCap = 0 } = {}) {
      return tx(() => {
        const t = nowIso();
        // A worker that died mid-job: put its job back, counting it as an attempt.
        sql("UPDATE jobs SET state = 'queued', attempts = attempts + 1, locked_by = NULL, locked_at = NULL WHERE state = 'running' AND locked_at < ?").run(minutesAgo(10));
        for (const dead of sql("SELECT id, candidate_id, kind FROM jobs WHERE state = 'queued' AND attempts >= ?").all(MAX_CRASHES)) {
          sql("UPDATE jobs SET state = 'done', finished_at = ? WHERE id = ?").run(t, dead.id);
          if (dead.kind === 'analyze') sql("UPDATE candidates SET state = 'failed', attention = ?, updated_at = ? WHERE id = ? AND state IN ('queued', 'analyzing')").run('the browser kept crashing on this page', t, dead.candidate_id);
        }
        const busy = hourlyCap > 0 && sql("SELECT COUNT(*) n FROM jobs WHERE priority >= 1 AND state IN ('running', 'done') AND locked_at > ?").get(minutesAgo(60)).n >= hourlyCap;
        const row = busy
          ? sql("SELECT * FROM jobs WHERE state = 'queued' AND run_after <= ? AND priority = 0 ORDER BY id LIMIT 1").get(t)
          : sql("SELECT * FROM jobs WHERE state = 'queued' AND run_after <= ? ORDER BY priority, id LIMIT 1").get(t);
        if (!row) return null;
        sql("UPDATE jobs SET state = 'running', locked_by = ?, locked_at = ? WHERE id = ?").run(workerId, t, row.id);
        if (row.kind === 'analyze') sql("UPDATE candidates SET state = 'analyzing', updated_at = ? WHERE id = ? AND state IN ('queued', 'failed')").run(t, row.candidate_id);
        const candidate = sql('SELECT id, url FROM candidates WHERE id = ?').get(row.candidate_id);
        return { id: row.id, kind: row.kind, attempts: row.attempts, lateMs: row.late_ms, candidate: { id: candidate.id, url: candidate.url } };
      });
    },
    getJob: (id) => sql('SELECT * FROM jobs WHERE id = ?').get(id) ?? null,
    finishJob: (id) => void sql("UPDATE jobs SET state = 'done', finished_at = ? WHERE id = ?").run(nowIso(), id),
    retryJob: (id, runAfter, attempts) => void sql("UPDATE jobs SET state = 'queued', run_after = ?, attempts = ?, locked_by = NULL, locked_at = NULL WHERE id = ?").run(runAfter, attempts, id),
    queueLength: () => sql("SELECT COUNT(*) n FROM jobs WHERE state = 'queued'").get().n,
    runningJobs: () => sql("SELECT COUNT(*) n FROM jobs WHERE state = 'running'").get().n,

    // ---- misc -------------------------------------------------------------------------------

    countSubmissions({ submitter, since } = {}) {
      return submitter
        ? sql("SELECT COUNT(*) n FROM candidates WHERE origin = 'submit' AND submitter = ? AND created_at > ?").get(submitter, since).n
        : sql("SELECT COUNT(*) n FROM candidates WHERE origin = 'submit' AND created_at > ?").get(since).n;
    },

    idsByState: (state) => sql('SELECT id FROM candidates WHERE state = ? ORDER BY id').all(state).map((r) => r.id),

    // The same shape catalog/curation.json used, for backups and for moving data out.
    exportCuration() {
      const out = {};
      const rows = sql(
        "SELECT c.id, c.state, u.* FROM candidates c LEFT JOIN curation u ON u.candidate_id = c.id WHERE c.state IN ('approved', 'rejected', 'hidden') ORDER BY c.id",
      ).all();
      for (const r of rows) {
        if (r.state === 'rejected') out[r.id] = { status: 'rejected', reason: r.reason ?? '' };
        else {
          const entry = { status: r.state === 'approved' ? 'approved' : 'hidden', category: r.category, name: r.name, tags: parse(r.tags_json, []), blurb: r.blurb };
          if (r.score != null) entry.score = r.score;
          if (r.embed_override === 0) entry.embed = false;
          out[r.id] = entry;
        }
      }
      return out;
    },

    backupTo(path) {
      sql('VACUUM INTO ?').run(path);
    },
  };
}
