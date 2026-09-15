import Database, { type Database as DatabaseType } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MIGRATIONS } from "./migrations.js";

const DB_PATH = resolve(process.env.HARNESS_DB_PATH ?? "./data/harness.db");

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db: DatabaseType = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const applied = new Set(
  db
    .prepare(`SELECT version FROM schema_migrations`)
    .all()
    .map((r) => (r as { version: number }).version),
);

for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
  if (applied.has(migration.version)) continue;
  const run = db.transaction(() => {
    db.exec(migration.sql);
    db.prepare(`INSERT INTO schema_migrations (version, name) VALUES (?, ?)`).run(
      migration.version,
      migration.name,
    );
  });
  run();
}

export function dbPath(): string {
  return DB_PATH;
}

export function schemaVersion(): number {
  const row = db.prepare(`SELECT MAX(version) as v FROM schema_migrations`).get() as {
    v: number | null;
  };
  return row.v ?? 0;
}
