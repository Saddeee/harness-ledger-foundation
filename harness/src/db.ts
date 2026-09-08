import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DB_PATH = resolve(process.env.HARNESS_DB_PATH ?? "./data/harness.db");

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  -- Permission list: which Lovable projects Claude Code may touch on Harness's behalf.
  -- Deliberately no MCP tool below can INSERT into this table -- it is curated
  -- out-of-band (scripts/seed) so an agent can never grant itself a new project.
  CREATE TABLE IF NOT EXISTS allowed_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lovable_project_id TEXT NOT NULL UNIQUE,
    label TEXT,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Cached, redacted metadata about approved projects (never raw file contents).
  CREATE TABLE IF NOT EXISTS projects (
    lovable_project_id TEXT PRIMARY KEY,
    name TEXT,
    status TEXT,
    url TEXT,
    tech_stack TEXT,
    raw_json TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS test_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    ref TEXT,
    payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export function dbPath(): string {
  return DB_PATH;
}
