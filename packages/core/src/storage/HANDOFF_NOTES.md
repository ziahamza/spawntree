# Storage Providers — Handoff Notes

This PR lands the storage provider system for the spawntree daemon. It
establishes the architecture, ships three working providers (`local`,
`turso-embedded`, `s3-snapshot`), exposes runtime admin routes at
`/api/v1/storage/*` with probe and hot-swap support, and **migrates the
daemon's `CatalogDatabase` to the `StorageManager`'s libSQL client** —
so every read/write the daemon does flows through the active primary
provider and is exactly what replicators snapshot.

End-to-end verified against a live MinIO: real repo registration via
HTTP → `CatalogDatabase` via libSQL → `StorageManager.client` → S3
snapshot → downloaded and queried with `sqlite3`, rows present. The
daemon no longer depends on `better-sqlite3`.

## What's shipped

- `spawntree-core/storage`
  - `types.ts` — `PrimaryStorageProvider`, `ReplicatorProvider`, `StorageRegistry`, `ProviderStatus`, config schema. `ReplicatorHandle` now has optional `pause()`/`resume()`.
  - `registry.ts` — provider lookup/registration.
  - `providers/local.ts` — default, plain libSQL file.
  - `providers/turso-embedded.ts` — libSQL embedded replica with `syncUrl`.
  - `providers/s3-snapshot.ts` — VACUUM INTO + atomic CopyObject upload. Now exposes
    `lastOkBytes`, `lastEtag`, `paused`, `fatal` in status; classifies S3 errors;
    pauses cleanly during primary hot-swap; never loads the snapshot file into
    memory for cleanup (Devin-fixed).
  - `config.ts` — persisted config load/save with Effect Schema validation.
    Writes now chmod to `0600` so credentials aren't world-readable.
- `spawntree-daemon`
  - `storage/manager.ts` — orchestrates registry + persisted config + active
    connections. Mutations are serialized via an internal lock. Hot-swap with
    data migration (and rollback on failure). Exposes `probePrimary` /
    `probeReplicator` for dry-run validation.
  - `routes/storage.ts` — HTTP admin endpoints including new
    `POST /primary/probe` and `POST /replicators/probe`. All mutations are gated
    behind a localhost-origin check (opt out via `SPAWNTREE_STORAGE_TRUST_REMOTE=1`).
  - `server-main.ts` boots a `StorageManager` and shuts it down on SIGINT/SIGTERM.
  - `server.ts` mounts storage routes conditionally.
- Daemon catalog (Drizzle, no wrapper)
  - `DaemonService.makeLayer(storage)` opens `drizzle(storage.client, { schema })`
    directly in the layer init. No `CatalogDatabase` class, no domain-type
    mapper functions — Drizzle's `$inferSelect` row types ARE the domain
    types. Every read and write inside `daemon-service.ts` is a plain
    Drizzle call like `catalog.select().from(reposTable)...`.
  - `packages/daemon/src/catalog/queries.ts` keeps the 5 multi-step
    helpers that carry real business logic (`upsertRepo`/`upsertClone`
    evict stale unique-key collisions, `replaceWorktrees` is atomic
    delete-then-insert, `upsertWatchedPath` + `registerRepo` handle
    `ON CONFLICT` patterns). Everything else is one-line Drizzle inline.
  - `better-sqlite3` + `@types/better-sqlite3` removed from daemon deps.
- Typed catalog schema + two external-client surfaces (`spawntree-core/db`)
  - `schema.ts` — Drizzle schema for all 8 catalog tables (5 original +
    3 for ACP sessions: `sessions`, `session_turns`, `session_tool_calls`).
    Single source of truth for column names, types, indexes, foreign keys.
    Row types inferred via `$inferSelect` / `$inferInsert`. JSON columns
    (turn `content`, tool-call `arguments`/`result`) use Drizzle's
    `{ mode: "json" }` with `$type<...>()` hints so reads are typed.
  - `client.ts` — `createCatalogClient(options)` and
    `createCatalogClientAsync(options)` for direct-libSQL consumers
    (local file, Turso replica).
  - `http-client.ts` — `createCatalogHttpDb({ url })` and
    `catalogHttpProxy({ url })` for consumers that talk to a running
    daemon over HTTP. Backed by `drizzle-orm/sqlite-proxy`. Users
    import Drizzle natively:
    ```ts
    import { createCatalogHttpDb, schema } from "spawntree-core";
    import { eq } from "drizzle-orm";
    const db = createCatalogHttpDb({ url: "http://127.0.0.1:2222" });
    const repos = await db.select().from(schema.repos).where(
      eq(schema.repos.provider, "github"),
    );
    ```
    No read endpoints to reimplement, no protocol to learn.
  - `drizzle.config.ts` + `migrations/` — `drizzle-kit generate` wired
    up for future schema changes. Baseline DDL is applied idempotently
    in `applyCatalogSchema()` at daemon boot; incremental migrations
    land via `drizzle-orm/libsql/migrator` once schema changes start shipping.
- Daemon catalog query endpoint
  - `packages/daemon/src/routes/catalog.ts` — `POST /api/v1/catalog/query`
    and `POST /api/v1/catalog/batch` implement the server side of
    Drizzle's sqlite-proxy protocol. Gated by the same loopback-origin
    check as the storage admin routes (override via
    `SPAWNTREE_CATALOG_TRUST_REMOTE=1`).
- ACP session persistence (fits on top of the Drizzle stack)
  - `SessionManager` now takes a `StorageManager` and mirrors every
    ACP adapter event into the catalog DB via Drizzle. `createSession`
    upserts a row in `sessions`; `turn_started`/`turn_completed` hit
    `session_turns`; `tool_call_started`/`tool_call_completed` hit
    `session_tool_calls`. `message_delta` is intentionally skipped
    (would write-amplify per token).
  - Writes are queued per-session so events land in the order they were
    emitted — prevents `turn_completed`'s UPDATE from racing
    `turn_started`'s INSERT. `flushPersist()` is available for tests and
    shutdown.
  - Sessions survive daemon restart; the s3-snapshot replicator captures
    them (they're in the same DB file as the rest of the catalog);
    external Drizzle clients read them with the same `schema` + typed
    `db.select()/query` patterns, no per-table re-implementation.
- Tests (79 passing + 4 MinIO-gated)
  - `packages/core/tests/storage.test.ts` — registry + local provider + config
    persistence (6 tests).
  - `packages/daemon/tests/storage-manager.test.ts` — start/stop, config
    persistence + perms, hot-swap migration (happy path, no-op, rollback on
    failure), concurrency (overlapping swaps, migrating flag), probes,
    replicator add/remove, redaction (15 tests).
  - `packages/daemon/tests/catalog-queries.test.ts` — the 5 multi-step
    helpers (`upsertRepo`/`upsertClone` with stale-row eviction,
    `replaceWorktrees` atomic bulk-replace, `upsertWatchedPath` +
    `registerRepo` conflict handling). Simple inline Drizzle queries
    inside daemon-service aren't dedicated-tested because they're
    already proven by `catalog-client.test.ts` and `catalog-http.test.ts`
    (9 tests).
  - `packages/daemon/tests/catalog-http.test.ts` — end-to-end: boot a
    StorageManager, mount the catalog HTTP routes, have an external
    Drizzle client (`createCatalogHttpDb` AND raw `catalogHttpProxy` +
    `drizzle(...)`) run selects, wheres, joins, and the relational
    query API over HTTP against the live daemon (7 tests).
  - `packages/core/tests/catalog-client.test.ts` — external
    `createCatalogClient` coverage: schema bootstrap, typed inserts +
    selects, filtered queries (`eq` + `and`), joins across `repos` +
    `clones`, relational query API (`db.query.repos.findFirst(...)`),
    FK cascade on `DELETE FROM repos`, sync vs async factory semantics
    (10 tests).
  - `packages/core/tests/s3-replicator-minio.test.ts` — integration against a
    running MinIO (4 tests, skipped if `SPAWNTREE_S3_TEST_ENDPOINT` is unset).
    Verifies the Devin CopySource regression is fixed, status info fields are
    populated, bad credentials surface as `fatal`, and `pause()` truly drains.

## What's NOT done (follow-up work for the spawntree agent)

### 1. Admin auth: device credential layer

Currently the storage admin routes are gated by a loopback origin check (new
in this PR) plus the opt-out env var. That stops drive-by CSRF but doesn't
stop a local attacker who can reach 127.0.0.1 (e.g. another user on the same
machine). Before spawntree 1.0 we want:
- Device credential: shared secret at `~/.spawntree/daemon.key`, checked as a
  `Bearer` header on mutations.
- Configurable via the daemon config model (on by default in production
  builds, opt-out for dev).

### 2. Credential encryption at rest

`storage.json` now has `0600` perms, which matches `.env` conventions and is
acceptable for v1. For defence-in-depth we should encrypt the secret fields
(`authToken`, `secretAccessKey`, `accessKeyId`, `password`) with a
system-keychain-backed key (macOS Keychain / libsecret on Linux / DPAPI on
Windows). This is a post-1.0 item.

### 3. Additional providers

The `ReplicatorProvider` interface is finalized enough that third parties can
register their own. Natural next-steps to ship in-tree:
- **Litestream-style WAL streaming** primary/replicator. The current
  `s3-snapshot` is the dumb full-file approach — continuous WAL replication
  is materially better for large DBs.
- **Postgres read-replica** replicator: mirror rows into a PG schema so
  read-only consumers can query catalog/session state from elsewhere.
- **Turso read-replica** replicator: complement the embedded primary with a
  push-only read replica for multi-host setups.

### 4. Auto-load providers from env vars at boot

Today the user has to `POST /api/v1/storage/replicators` after boot to
activate backup. For the "zero config → R2 backup in 5 minutes" flow we
want:
- `SPAWNTREE_STORAGE_PRIMARY=turso-embedded` + related env vars to pre-seed
  the primary.
- `SPAWNTREE_STORAGE_REPLICATORS=s3-prod` + per-replicator env groups to
  pre-seed replicators.
- Boot-time reconciliation with whatever's already in `storage.json`.

### 5. Streaming S3 upload

The current `s3-snapshot` writes VACUUM output to a temp file then streams
that file to S3. For large DBs it'd be better to pipe VACUUM output directly
into a multipart upload. Requires libSQL to expose a streaming VACUUM INTO,
which may need custom work.

## Why this is net-positive for spawntree

Beyond any specific downstream integration:

1. **Disaster recovery.** Any spawntree user with an S3-compatible backend
   can set up off-host backup with one `POST /api/v1/storage/replicators`.
2. **Multi-machine workflows.** Teams can point multiple daemons at the same
   Turso DB (one primary + read replicas) and get shared visibility.
3. **Self-hosted friendly.** The default `forcePathStyle: true` + `region: "auto"`
   shape works against MinIO, Garage, Ceph, Backblaze B2, R2. Verified end-to-end
   against a live MinIO container.
4. **Clean extension point.** Third parties drop in primaries/replicators via
   `registry.registerPrimary/Replicator` with no spawntree core changes.
5. **Separation of concerns.** Primary vs replicator isolates "where does my
   data live" from "who else has a copy."

## API surface summary

```
GET    /api/v1/storage
       → { primary: {id, config, status}, replicators: [...], availableProviders, migrating }

PUT    /api/v1/storage/primary                       body: { id, config }
       → { primary, replicators, availableProviders, migrating } — migrates data on swap

POST   /api/v1/storage/primary/probe                 body: { id, config }
       → { ok: true, info } | { ok: false, error }

POST   /api/v1/storage/replicators                   body: { rid, id, config }
       → 201 { primary, replicators, availableProviders, migrating }

POST   /api/v1/storage/replicators/probe             body: { id, config }
       → { ok: true, info } | { ok: false, error }

POST   /api/v1/storage/replicators/:rid/trigger
       → { status: ProviderStatus }

DELETE /api/v1/storage/replicators/:rid
       → { ok: true }
```

All mutations reject non-loopback origins with `403 STORAGE_REMOTE_DENIED`
unless `SPAWNTREE_STORAGE_TRUST_REMOTE=1` is set.

## Config file

Lives at `~/.spawntree/storage.json` with `0600` perms. Auto-created on first
mutation. Schema:

```json
{
  "primary": { "id": "local", "config": {} },
  "replicators": [
    {
      "rid": "s3-prod",
      "id": "s3-snapshot",
      "config": {
        "bucket": "my-backups",
        "keyPrefix": "laptop/",
        "endpoint": "https://r2.cloudflarestorage.com",
        "accessKeyId": "...",
        "secretAccessKey": "...",
        "intervalSec": 60
      }
    }
  ]
}
```

## Running the MinIO integration tests locally

```sh
docker run -d --rm --name mio -p 9100:9000 \
  -e MINIO_ROOT_USER=testkey -e MINIO_ROOT_PASSWORD=testsecret \
  minio/minio server /data
docker run --rm --network host --entrypoint sh minio/mc -c \
  "mc alias set local http://127.0.0.1:9100 testkey testsecret && \
   mc mb --ignore-existing local/spawntree-test"

SPAWNTREE_S3_TEST_ENDPOINT=http://127.0.0.1:9100 \
SPAWNTREE_S3_TEST_BUCKET=spawntree-test \
SPAWNTREE_S3_TEST_ACCESS_KEY=testkey \
SPAWNTREE_S3_TEST_SECRET_KEY=testsecret \
  pnpm --filter spawntree-core test
```
