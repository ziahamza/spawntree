/**
 * Idempotent schema migration for the spawntree-browser SQLite catalog.
 *
 * Consumers call this once at app boot, before constructing
 * `SpawntreeBrowser`. The function runs `CREATE TABLE IF NOT EXISTS`
 * for every table the browser package touches, plus the indexes, plus
 * any nullable column additions needed for FSA-mode rows on `clones`.
 *
 * The DDL is intentionally additive and idempotent:
 *  - Tables that already exist (because some other writer set them up
 *    first — e.g. a daemon-mode cohabiting catalog) are left untouched.
 *  - Columns that already exist are detected via `pragma table_info`
 *    before issuing `ALTER TABLE` (sqlite has no `IF NOT EXISTS` for
 *    column additions).
 *
 * The DDL strings are sourced from spawntree-core's `BASELINE_DDL`
 * filtered to only the browser-relevant tables, so the daemon's session
 * tables don't get created in browser SQLite where they're not needed.
 */
import { sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { browserSchema } from "./schema.ts";

/**
 * Browser-mode subset of the catalog DDL. The full `BASELINE_DDL` from
 * spawntree-core also creates daemon-only tables (`watched_paths`,
 * `registered_repos`, `sessions`, `session_turns`,
 * `session_tool_calls`); we don't need any of those in a browser
 * sqlite, so we declare a focused subset here.
 *
 * Order matters because of foreign keys:
 *   1. `repos` — referenced by clones
 *   2. `clones` — references repos, referenced by worktrees
 *   3. `worktrees` — references clones
 *   4. `picked_folders` — independent
 */
const BROWSER_DDL: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS repos (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT '',
    remote_url TEXT NOT NULL DEFAULT '',
    default_branch TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS clones (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    last_seen_at TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    picked_folder_id TEXT,
    relative_path TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS clones_repo_id_idx ON clones(repo_id)`,
  `CREATE TABLE IF NOT EXISTS worktrees (
    path TEXT PRIMARY KEY,
    clone_id TEXT NOT NULL REFERENCES clones(id) ON DELETE CASCADE,
    branch TEXT NOT NULL DEFAULT '',
    head_ref TEXT NOT NULL DEFAULT '',
    discovered_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS worktrees_clone_id_idx ON worktrees(clone_id)`,
  `CREATE TABLE IF NOT EXISTS picked_folders (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    picked_at TEXT NOT NULL,
    last_scanned_at TEXT,
    scan_error TEXT
  )`,
];

/**
 * Apply the spawntree-browser baseline DDL idempotently. Safe to call
 * on every app boot.
 *
 * @param db Drizzle-wrapped async SQLite database (PowerSync, wa-sqlite,
 *   OPFS-sqlite, etc.). The same handle the consumer will pass to the
 *   `SpawntreeBrowser` constructor.
 */
export async function migrateBrowserSchema(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: BaseSQLiteDatabase<"async", any, typeof browserSchema>,
): Promise<void> {
  for (const stmt of BROWSER_DDL) {
    await db.run(sql.raw(stmt));
  }
  // Existing `clones` tables (e.g. from an older browser-mode catalog
  // that pre-dated FSA-mode) won't have the new columns. SQLite has no
  // `IF NOT EXISTS` for column additions, so we probe via
  // `pragma table_info` first and only ALTER when the column is
  // genuinely missing.
  await ensureColumn(db, "clones", "picked_folder_id", "TEXT");
  await ensureColumn(db, "clones", "relative_path", "TEXT");
}

async function ensureColumn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: BaseSQLiteDatabase<"async", any, typeof browserSchema>,
  table: string,
  column: string,
  type: string,
): Promise<void> {
  const rows = (await db.all(sql.raw(`PRAGMA table_info(${table})`))) as Array<{
    name: string;
  }>;
  const present = rows.some((r) => r.name === column);
  if (!present) {
    await db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`));
  }
}
