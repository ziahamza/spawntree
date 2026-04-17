import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ContentBlock } from "../api/schemas.ts";

/**
 * Spawntree catalog schema — the single source of truth for table shape
 * across the daemon (writer) and any external tool (reader).
 *
 * Every column is declared with its SQLite type AND Drizzle's TypeScript
 * type, so `db.select().from(repos)` returns a fully-typed row without any
 * `as` casts. External consumers import this schema, hand it to Drizzle
 * alongside a libSQL client, and query directly with the same types the
 * daemon uses internally.
 *
 * Philosophy: the schema is the API. Readers that connect via libSQL
 * (Turso sync, local file, S3-downloaded snapshot) don't need the daemon
 * HTTP to be running — they just need schema + a libSQL client. That lets
 * downstream integrations like cross-host dashboards, CLIs, and backup
 * verifiers avoid reimplementing read endpoints.
 */

export const repos = sqliteTable("repos", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  owner: text("owner").notNull().default(""),
  remoteUrl: text("remote_url").notNull().default(""),
  defaultBranch: text("default_branch").notNull().default(""),
  description: text("description").notNull().default(""),
  registeredAt: text("registered_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const clones = sqliteTable(
  "clones",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    path: text("path").notNull().unique(),
    status: text("status").notNull().default("active"),
    lastSeenAt: text("last_seen_at").notNull(),
    registeredAt: text("registered_at").notNull(),
  },
  (table) => [index("clones_repo_id_idx").on(table.repoId)],
);

export const worktrees = sqliteTable(
  "worktrees",
  {
    path: text("path").primaryKey(),
    cloneId: text("clone_id")
      .notNull()
      .references(() => clones.id, { onDelete: "cascade" }),
    branch: text("branch").notNull().default(""),
    headRef: text("head_ref").notNull().default(""),
    discoveredAt: text("discovered_at").notNull(),
  },
  (table) => [index("worktrees_clone_id_idx").on(table.cloneId)],
);

export const watchedPaths = sqliteTable("watched_paths", {
  path: text("path").primaryKey(),
  // Boolean stored as 0/1. Drizzle's `{ mode: "boolean" }` would round-trip
  // to `true`/`false` but existing data uses integers — keep explicit.
  scanChildren: integer("scan_children").notNull().default(0),
  addedAt: text("added_at").notNull(),
  lastScannedAt: text("last_scanned_at").notNull().default(""),
  lastScanError: text("last_scan_error").notNull().default(""),
});

export const registeredRepos = sqliteTable("registered_repos", {
  repoId: text("repo_id").primaryKey(),
  repoPath: text("repo_path").notNull(),
  configPath: text("config_path").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
});

// ─── ACP sessions ────────────────────────────────────────────────────────
//
// Persist ACP session metadata + turn log + tool-call log in the catalog so
// sessions survive daemon restart, ride along with the S3 snapshot replicator,
// and are queryable directly by external Drizzle clients (no "does the
// subprocess know about this session anymore" lookups required).
//
// The ACP adapter subprocesses still own the live conversation state — this
// schema is the durable mirror. On session events the daemon upserts here so
// `db.select().from(sessions)` always reflects the latest.

export const sessions = sqliteTable(
  "sessions",
  {
    /** External ACP session id. Also the wire identifier clients use. */
    sessionId: text("session_id").primaryKey(),
    /** `"claude-code"` | `"codex"` | future adapters. */
    provider: text("provider").notNull(),
    /** Matches `SessionStatus` — "active" | "completed" | "error" | "cancelled". */
    status: text("status").notNull(),
    /** Human title, if the adapter produced one. */
    title: text("title"),
    /** cwd the session was opened against. */
    workingDirectory: text("working_directory").notNull(),
    gitBranch: text("git_branch"),
    gitHeadCommit: text("git_head_commit"),
    gitRemoteUrl: text("git_remote_url"),
    totalTurns: integer("total_turns").notNull().default(0),
    startedAt: text("started_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("sessions_provider_idx").on(table.provider),
    index("sessions_updated_at_idx").on(table.updatedAt),
  ],
);

export const sessionTurns = sqliteTable(
  "session_turns",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    turnIndex: integer("turn_index").notNull(),
    /** "user" | "assistant". */
    role: text("role").notNull(),
    /**
     * Serialised `ContentBlock[]`. `{ mode: "json" }` gives us automatic
     * JSON (de)serialisation; the `$type` hint propagates the element type
     * so `row.content` is `ContentBlock[]`, not `unknown`.
     */
    content: text("content", { mode: "json" }).$type<Array<ContentBlock>>().notNull(),
    modelId: text("model_id"),
    durationMs: integer("duration_ms"),
    stopReason: text("stop_reason"),
    /** "streaming" | "completed" | "error" | "cancelled". */
    status: text("status").notNull(),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("session_turns_session_id_idx").on(table.sessionId),
    index("session_turns_session_turn_idx").on(table.sessionId, table.turnIndex),
  ],
);

export const sessionToolCalls = sqliteTable(
  "session_tool_calls",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    /** Nullable — a tool call can exist before its owning turn is assigned. */
    turnId: text("turn_id"),
    toolName: text("tool_name").notNull(),
    /** "terminal" | "file_edit" | "mcp" | "other". */
    toolKind: text("tool_kind").notNull(),
    /** "pending" | "in_progress" | "completed" | "error". */
    status: text("status").notNull(),
    /** Tool invocation input. JSON-encoded. */
    arguments: text("arguments", { mode: "json" }).$type<unknown>().notNull(),
    /** Tool invocation result. JSON-encoded. */
    result: text("result", { mode: "json" }).$type<unknown>().notNull(),
    durationMs: integer("duration_ms"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("session_tool_calls_session_id_idx").on(table.sessionId),
    index("session_tool_calls_turn_id_idx").on(table.turnId),
  ],
);

/**
 * Full schema object suitable for `drizzle(client, { schema })`. Clients
 * that want the relational query API (`db.query.repos.findMany(...)`)
 * pass this at connect time.
 */
export const schema = {
  repos,
  clones,
  worktrees,
  watchedPaths,
  registeredRepos,
  sessions,
  sessionTurns,
  sessionToolCalls,
};

export type Schema = typeof schema;

// Row type exports — handy for code that takes a catalog row as a param.
export type RepoRow = typeof repos.$inferSelect;
export type NewRepoRow = typeof repos.$inferInsert;
export type CloneRow = typeof clones.$inferSelect;
export type NewCloneRow = typeof clones.$inferInsert;
export type WorktreeRow = typeof worktrees.$inferSelect;
export type NewWorktreeRow = typeof worktrees.$inferInsert;
export type WatchedPathRow = typeof watchedPaths.$inferSelect;
export type NewWatchedPathRow = typeof watchedPaths.$inferInsert;
export type RegisteredRepoRow = typeof registeredRepos.$inferSelect;
export type NewRegisteredRepoRow = typeof registeredRepos.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type SessionTurnRow = typeof sessionTurns.$inferSelect;
export type NewSessionTurnRow = typeof sessionTurns.$inferInsert;
export type SessionToolCallRow = typeof sessionToolCalls.$inferSelect;
export type NewSessionToolCallRow = typeof sessionToolCalls.$inferInsert;

/**
 * DDL needed to bootstrap an empty database into the current schema.
 *
 * We keep this alongside the Drizzle schema so `CatalogDatabase.open(client)`
 * can bring any libSQL file to the right shape idempotently without
 * depending on `drizzle-kit migrate` at runtime. Proper incremental
 * migrations (generated by `drizzle-kit generate`) live under
 * `packages/core/src/db/migrations/` and apply on top of this baseline
 * once schema changes start shipping.
 *
 * Kept as individual statements because libSQL's `client.execute()` takes
 * one statement per call. Every statement is idempotent (`IF NOT EXISTS`).
 */
export const BASELINE_DDL: ReadonlyArray<string> = [
  "PRAGMA foreign_keys = ON",
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
    registered_at TEXT NOT NULL
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
  `CREATE TABLE IF NOT EXISTS watched_paths (
    path TEXT PRIMARY KEY,
    scan_children INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL,
    last_scanned_at TEXT NOT NULL DEFAULT '',
    last_scan_error TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS registered_repos (
    repo_id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    config_path TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT,
    working_directory TEXT NOT NULL,
    git_branch TEXT,
    git_head_commit TEXT,
    git_remote_url TEXT,
    total_turns INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_provider_idx ON sessions(provider)`,
  `CREATE INDEX IF NOT EXISTS sessions_updated_at_idx ON sessions(updated_at)`,
  `CREATE TABLE IF NOT EXISTS session_turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    turn_index INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    model_id TEXT,
    duration_ms INTEGER,
    stop_reason TEXT,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS session_turns_session_id_idx ON session_turns(session_id)`,
  `CREATE INDEX IF NOT EXISTS session_turns_session_turn_idx ON session_turns(session_id, turn_index)`,
  `CREATE TABLE IF NOT EXISTS session_tool_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    turn_id TEXT,
    tool_name TEXT NOT NULL,
    tool_kind TEXT NOT NULL,
    status TEXT NOT NULL,
    arguments TEXT NOT NULL,
    result TEXT NOT NULL,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS session_tool_calls_session_id_idx ON session_tool_calls(session_id)`,
  `CREATE INDEX IF NOT EXISTS session_tool_calls_turn_id_idx ON session_tool_calls(turn_id)`,
];

// Re-export `sql` so external consumers can build raw clauses without a
// separate drizzle-orm import. `eq`, `and`, `or`, etc. can be imported from
// drizzle-orm by consumers who want them — we don't re-export the full
// query operator set to keep the public surface focused.
export { sql };
