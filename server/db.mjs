// SQLite through Node's built-in node:sqlite: no native module to compile in the image.
//
// One file holds everything the reviewer decides, so it is the thing to back up.
// Timestamps are ISO-8601 strings in UTC; they sort correctly as text.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candidates (
  id          TEXT PRIMARY KEY,
  url         TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL DEFAULT '',
  origin      TEXT NOT NULL CHECK (origin IN ('hn', 'submit', 'admin', 'seed')),
  source_json TEXT,
  note        TEXT,
  submitter   TEXT,
  state       TEXT NOT NULL CHECK (state IN ('queued', 'analyzing', 'failed', 'pending_review', 'approved', 'rejected', 'hidden')),
  attention   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS candidates_state ON candidates (state);
CREATE INDEX IF NOT EXISTS candidates_origin ON candidates (origin, created_at);

-- The latest health check of each candidate.
CREATE TABLE IF NOT EXISTS analyses (
  candidate_id   TEXT PRIMARY KEY REFERENCES candidates (id) ON DELETE CASCADE,
  checked_at     TEXT NOT NULL,
  ok             INTEGER NOT NULL,
  error          TEXT,
  error_kind     TEXT,
  reach          TEXT,
  load_ms        INTEGER,
  http_status    INTEGER,
  final_url      TEXT,
  embed_ok       INTEGER,
  embed_reason   TEXT,
  warnings_json  TEXT,
  meta_json      TEXT,
  js_errors      INTEGER,
  cover_bytes    INTEGER,
  cover_note     TEXT,
  has_embed_shot INTEGER NOT NULL DEFAULT 0
);

-- What the reviewer (or the AI draft waiting for the reviewer) says about a candidate.
CREATE TABLE IF NOT EXISTS curation (
  candidate_id   TEXT PRIMARY KEY REFERENCES candidates (id) ON DELETE CASCADE,
  category       TEXT,
  name           TEXT,
  tags_json      TEXT,
  blurb          TEXT,
  score          INTEGER,
  embed_override INTEGER,
  reason         TEXT,
  ai_json        TEXT,
  decided_at     TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('analyze', 'recheck')),
  state        TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done')),
  priority     INTEGER NOT NULL DEFAULT 1,
  run_after    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  late_ms      INTEGER NOT NULL DEFAULT 0,
  locked_by    TEXT,
  locked_at    TEXT,
  created_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS jobs_pick ON jobs (state, priority, run_after);
CREATE INDEX IF NOT EXISTS jobs_candidate ON jobs (candidate_id, id);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}
