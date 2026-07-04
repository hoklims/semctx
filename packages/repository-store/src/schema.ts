/** SQLite DDL for the semctx store. One file, no external database (ADR 0001). */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  file_path       TEXT,
  bounded_context TEXT,
  exported        INTEGER,
  tags            TEXT NOT NULL DEFAULT '[]',
  evidence        TEXT NOT NULL DEFAULT '[]',
  metadata        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes (kind);
CREATE INDEX IF NOT EXISTS idx_nodes_bc ON nodes (bounded_context);

CREATE TABLE IF NOT EXISTS edges (
  id       TEXT PRIMARY KEY,
  kind     TEXT NOT NULL,
  from_id  TEXT NOT NULL,
  to_id    TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges (from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges (to_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges (kind);

CREATE TABLE IF NOT EXISTS evidence (
  id          TEXT PRIMARY KEY,
  file_path   TEXT NOT NULL,
  start_line  INTEGER,
  end_line    INTEGER,
  source_kind TEXT NOT NULL,
  excerpt     TEXT
);

CREATE TABLE IF NOT EXISTS claims (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,
  statement           TEXT NOT NULL,
  subject_node_ids    TEXT NOT NULL DEFAULT '[]',
  evidence_ids        TEXT NOT NULL DEFAULT '[]',
  authority           REAL NOT NULL,
  freshness           REAL NOT NULL,
  confidence          REAL NOT NULL,
  verification_status TEXT NOT NULL,
  valid_from          TEXT,
  valid_until         TEXT,
  tags                TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_claims_kind ON claims (kind);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims (verification_status);

CREATE TABLE IF NOT EXISTS task_frames (
  id         TEXT PRIMARY KEY,
  raw_task   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_packs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  payload      TEXT NOT NULL,
  generated_at TEXT NOT NULL
);
`;
