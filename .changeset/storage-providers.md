---
"spawntree-core": minor
"spawntree-daemon": minor
---

Pluggable storage providers, typed catalog via Drizzle, and ACP session persistence.

### Storage providers (`spawntree-core/storage`, `spawntree-daemon/storage`)

- `PrimaryStorageProvider` + `ReplicatorProvider` contracts, registry, and three
  built-in providers: `local` (plain libSQL file), `turso-embedded` (libSQL
  embedded replica with `syncUrl`), `s3-snapshot` (VACUUM INTO + atomic
  CopyObject upload).
- `StorageManager` orchestrates the active primary + replicators, serializes
  mutations via an internal lock, and supports hot-swapping the primary with
  transactional data migration (rollback on failure keeps the old primary
  active).
- HTTP admin surface at `/api/v1/storage/*` with probe endpoints, loopback
  origin gating (opt out with `SPAWNTREE_STORAGE_TRUST_REMOTE=1`), and
  `0600` file perms on `~/.spawntree/storage.json`.

### Typed catalog via Drizzle (`spawntree-core/db`)

- Drizzle schema for all 8 catalog tables (`repos`, `clones`, `worktrees`,
  `watched_paths`, `registered_repos`, `sessions`, `session_turns`,
  `session_tool_calls`) is the single source of truth for shape, indexes, and
  foreign keys. Row types exported via `$inferSelect` / `$inferInsert`.
- `drizzle-kit` wired up for future schema changes; baseline migration checked
  in at `packages/core/src/db/migrations/`.
- External consumers get two client surfaces:
  - `createCatalogClient({ url })` / `createCatalogClientAsync({ url })` for
    direct libSQL access (local file or Turso replica).
  - `createCatalogHttpDb({ url })` / `catalogHttpProxy({ url })` for daemon-side
    HTTP access, backed by Drizzle's `sqlite-proxy` driver. Consumers write
    standard `db.select()` / `db.query.*` / joins against a shared schema —
    no read endpoints to re-implement.
- Daemon-side `CatalogDatabase` wrapper replaced with direct Drizzle queries.
  `better-sqlite3` removed from daemon deps.
- `POST /api/v1/catalog/query` + `POST /api/v1/catalog/batch` implement the
  server side of the sqlite-proxy protocol. Loopback-gated by default.

### ACP session persistence

- `SessionManager` now takes a `StorageManager` and mirrors every ACP adapter
  event into the catalog DB so sessions survive daemon restart, ride along
  with the s3-snapshot replicator, and are queryable by external Drizzle
  clients.
- Per-session write queue serializes events so `turn_completed` can't race
  `turn_started`. `flushPersist()` exposed for tests and shutdown.
