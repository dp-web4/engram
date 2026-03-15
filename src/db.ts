/**
 * SQLite storage layer — schema, queries, lifecycle.
 * Single database at ~/.engram/engram.db
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ENGRAM_ROOT = join(homedir(), '.engram');

/**
 * Derive a per-directory database path from the launch directory.
 * Same pattern as Claude Code's -c flag: each project directory gets
 * its own isolated context. Structure: ~/.engram/projects/<hash>/engram.db
 */
export function getDbPath(launchDir?: string): string {
  const dir = launchDir || process.cwd();
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 12);
  const projectDir = join(ENGRAM_ROOT, 'projects', hash);
  mkdirSync(projectDir, { recursive: true });
  // Write a metadata file so we can map hash → directory
  const metaPath = join(projectDir, 'meta.json');
  try {
    const { writeFileSync, existsSync } = require('node:fs');
    if (!existsSync(metaPath)) {
      writeFileSync(metaPath, JSON.stringify({ dir, hash, created: new Date().toISOString() }));
    }
  } catch { /* non-critical */ }
  return join(projectDir, 'engram.db');
}

const SCHEMA = `
-- Tier 1: Salience-gated observations
CREATE TABLE IF NOT EXISTS observations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  tool_name       TEXT NOT NULL,
  input_summary   TEXT,
  output_summary  TEXT,
  surprise        REAL NOT NULL DEFAULT 0,
  novelty         REAL NOT NULL DEFAULT 0,
  arousal         REAL NOT NULL DEFAULT 0,
  reward          REAL NOT NULL DEFAULT 0,
  conflict        REAL NOT NULL DEFAULT 0,
  salience        REAL NOT NULL DEFAULT 0,
  cwd             TEXT,
  tags            TEXT
);

CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_salience ON observations(salience DESC);
CREATE INDEX IF NOT EXISTS idx_obs_ts ON observations(ts);

-- FTS5 for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  input_summary, output_summary, tags,
  content=observations,
  content_rowid=id
);

-- FTS sync triggers
CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, input_summary, output_summary, tags)
  VALUES (new.id, new.input_summary, new.output_summary, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, input_summary, output_summary, tags)
  VALUES ('delete', old.id, old.input_summary, old.output_summary, old.tags);
END;

-- Tier 2: Consolidated patterns (INFERRED — not raw observations)
CREATE TABLE IF NOT EXISTS patterns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  kind        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  detail      TEXT,
  frequency   INTEGER DEFAULT 1,
  source_ids  TEXT,
  confidence  REAL DEFAULT 0.5,
  last_seen   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS patterns_fts USING fts5(
  summary, detail,
  content=patterns,
  content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS pat_ai AFTER INSERT ON patterns BEGIN
  INSERT INTO patterns_fts(rowid, summary, detail)
  VALUES (new.id, new.summary, new.detail);
END;

-- Tier 3: Identity (persistent project facts)
CREATE TABLE IF NOT EXISTS identity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  key         TEXT NOT NULL UNIQUE,
  value       TEXT NOT NULL,
  source      TEXT DEFAULT 'auto',
  confidence  REAL DEFAULT 0.5
);

-- Seen-set for novelty detection
CREATE TABLE IF NOT EXISTS seen_set (
  token       TEXT PRIMARY KEY,
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  count       INTEGER DEFAULT 1
);

-- Session log
CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at    TEXT,
  cwd         TEXT,
  obs_count   INTEGER DEFAULT 0
);

-- Tool transition frequencies (persisted for cross-session surprise scoring)
CREATE TABLE IF NOT EXISTS tool_transitions (
  from_tool   TEXT NOT NULL,
  to_tool     TEXT NOT NULL,
  count       INTEGER DEFAULT 1,
  PRIMARY KEY (from_tool, to_tool)
);
`;

export function openDatabase(path?: string): Database.Database {
  const dbPath = path || getDbPath();

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

// Prepared statement factories
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function prepareStatements(db: Database.Database) {
  return {
    insertObservation: db.prepare(`
      INSERT INTO observations (session_id, tool_name, input_summary, output_summary,
        surprise, novelty, arousal, reward, conflict, salience, cwd, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    insertPattern: db.prepare(`
      INSERT INTO patterns (kind, summary, detail, frequency, source_ids, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `),

    upsertIdentity: db.prepare(`
      INSERT INTO identity (key, value, source, confidence)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = CASE WHEN excluded.confidence > identity.confidence THEN excluded.value ELSE identity.value END,
        confidence = MAX(excluded.confidence, identity.confidence)
    `),

    upsertSeen: db.prepare(`
      INSERT INTO seen_set (token) VALUES (?)
      ON CONFLICT(token) DO UPDATE SET count = count + 1
    `),

    checkSeen: db.prepare(`
      SELECT token FROM seen_set WHERE token IN (${Array(20).fill('?').join(',')})
    `),

    upsertTransition: db.prepare(`
      INSERT INTO tool_transitions (from_tool, to_tool, count) VALUES (?, ?, 1)
      ON CONFLICT(from_tool, to_tool) DO UPDATE SET count = count + 1
    `),

    getTransitionCount: db.prepare(`
      SELECT count FROM tool_transitions WHERE from_tool = ? AND to_tool = ?
    `),

    getMaxTransition: db.prepare(`
      SELECT MAX(count) as max_count FROM tool_transitions WHERE from_tool = ?
    `),

    searchObservations: db.prepare(`
      SELECT o.* FROM observations_fts f
      JOIN observations o ON o.id = f.rowid
      WHERE observations_fts MATCH ?
      ORDER BY o.salience DESC
      LIMIT ?
    `),

    searchPatterns: db.prepare(`
      SELECT p.* FROM patterns_fts f
      JOIN patterns p ON p.id = f.rowid
      WHERE patterns_fts MATCH ?
      LIMIT ?
    `),

    getSessionObservations: db.prepare(`
      SELECT * FROM observations WHERE session_id = ? ORDER BY ts
    `),

    getRecentObservations: db.prepare(`
      SELECT * FROM observations ORDER BY ts DESC LIMIT ?
    `),

    getObservationContext: db.prepare(`
      SELECT * FROM observations WHERE ts BETWEEN datetime(?, '-5 minutes') AND datetime(?, '+5 minutes')
      ORDER BY ts
    `),

    getAllPatterns: db.prepare(`
      SELECT * FROM patterns ORDER BY frequency DESC, confidence DESC
    `),

    getPatternsByKind: db.prepare(`
      SELECT * FROM patterns WHERE kind = ? ORDER BY frequency DESC
    `),

    getAllIdentity: db.prepare(`
      SELECT * FROM identity ORDER BY confidence DESC
    `),

    initSession: db.prepare(`
      INSERT OR REPLACE INTO sessions (session_id, cwd) VALUES (?, ?)
    `),

    endSession: db.prepare(`
      UPDATE sessions SET ended_at = datetime('now'),
        obs_count = (SELECT COUNT(*) FROM observations WHERE session_id = ?)
      WHERE session_id = ?
    `),

    // Confidence decay: reduce confidence of patterns not seen recently
    // Called during dream cycle. Decay rate: 0.05 per day since last_seen.
    decayPatterns: db.prepare(`
      UPDATE patterns SET
        confidence = MAX(0.0, confidence - 0.05 * (julianday('now') - julianday(last_seen)))
      WHERE julianday('now') - julianday(last_seen) > 1.0
    `),

    // Prune patterns that have decayed below usefulness
    prunePatterns: db.prepare(`
      DELETE FROM patterns WHERE confidence < 0.1
    `),

    // Decay old observations — reduce salience of observations older than 7 days
    decayObservations: db.prepare(`
      UPDATE observations SET
        salience = MAX(0.0, salience - 0.02 * (julianday('now') - julianday(ts) - 7))
      WHERE julianday('now') - julianday(ts) > 7
    `),

    getStats: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM observations) as obs_count,
        (SELECT COUNT(*) FROM patterns) as pattern_count,
        (SELECT COUNT(*) FROM identity) as identity_count,
        (SELECT COUNT(*) FROM seen_set) as seen_count,
        (SELECT COUNT(*) FROM sessions) as session_count,
        (SELECT AVG(salience) FROM observations) as avg_salience,
        (SELECT MAX(ts) FROM observations) as last_obs
    `),
  };
}

export type Statements = ReturnType<typeof prepareStatements>;
