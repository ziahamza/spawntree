# Storage Providers

Architecture reference for the storage layer that landed in [PR #15](https://github.com/ziahamza/spawntree/pull/15) and was extended with the read-only catalog endpoint + turn hydration in [PR #25](https://github.com/ziahamza/spawntree/pull/25).

The daemon's database layer is pluggable along two axes:

1. **Primary storage** (exactly one active): owns the libSQL client the daemon reads and writes through. Default impl is `local` (plain SQLite file). Optional impls like `turso-embedded` swap in a syncing client.
2. **Replicators** (zero or more active): background jobs that copy the primary's data somewhere else (S3 snapshot, future Litestream, future Postgres mirror) for backup or cross-host read access. They observe the primary; they never substitute for it.

Providers are resolved from a `StorageRegistry`. Built-ins register themselves; third parties call `registry.registerPrimary(...)` or `registry.registerReplicator(...)` before the daemon boots.

## Layout

- `spawntree-core/storage`
  - `types.ts` — `PrimaryStorageProvider`, `ReplicatorProvider`, `StorageRegistry`, `ProviderStatus`, config schema. `ReplicatorHandle` has optional `pause()`/`resume()` so a hot-swap can drain in-flight replication cleanly.
  - `registry.ts` — provider lookup/registration.
  - `providers/local.ts` — default, plain libSQL file.
  - `providers/turso-embedded.ts` — libSQL embedded replica with `syncUrl`.
  - `providers/s3-snapshot.ts` — VACUUM INTO + atomic CopyObject upload. Status exposes `lastOkBytes`, `lastEtag`, `paused`, `fatal`; errors are classified; the provider pauses cleanly during primary hot-swap; cleanup never loads the snapshot file into memory.
  - `config.ts` — persisted config load/save with Effect Schema validation. `storage.json` is written with `0600` perms and re-chmod'd on every save so rotation doesn't drift to world-readable.
- `spawntree-daemon/storage`
  - `storage/manager.ts` — orchestrates registry + persisted config + active connections. Mutations are serialized via an internal lock. Hot-swap supports data migration (and rollback on failure). Exposes `probePrimary` / `probeReplicator` for dry-run validation.
  - `routes/storage.ts` — HTTP admin endpoints including `POST /primary/probe` and `POST /replicators/probe`. All mutations are gated behind a localhost-origin check (opt out via `SPAWNTREE_STORAGE_TRUST_REMOTE=1`).
  - `server-main.ts` boots a `StorageManager` and shuts it down on SIGINT/SIGTERM.

## Typed catalog via Drizzle (`spawntree-core/db`)

- `schema.ts` — Drizzle schema for all 8 catalog tables (5 originals + 3 ACP session tables: `sessions`, `session_turns`, `session_tool_calls`). Single source of truth for column names, types, indexes, foreign keys. Row types inferred via `$inferSelect` / `$inferInsert`. JSON columns (turn `content`, tool-call `arguments`/`result`) use Drizzle's `{ mode: "json" }` with `$type<...>()` hints so reads are typed.
- `client.ts` — `createCatalogClient(options)` and `createCatalogClientAsync(options)` for direct-libSQL consumers (local file, Turso replica).
- `http-client.ts` — `createCatalogHttpDb({ url })` and `catalogHttpProxy({ url })` for consumers that talk to a running daemon over HTTP. Backed by `drizzle-orm/sqlite-proxy`. The `{ readOnly: true }` switch routes through the daemon's `/api/v1/catalog/query-readonly` endpoint (SELECT / WITH / EXPLAIN / read-only PRAGMA only):

  ```ts
  import { createCatalogHttpDb, schema } from "spawntree-core";
  import { eq } from "drizzle-orm";

  const db = createCatalogHttpDb({
    url: "http://127.0.0.1:2222",
    readOnly: true,   // safe for browser dashboards / third-party consumers
  });
  const repos = await db.select().from(schema.repos).where(
    eq(schema.repos.provider, "github"),
  );
  ```
- `drizzle.config.ts` + `migrations/` — `drizzle-kit generate` wired up. Baseline DDL is applied idempotently in `applyCatalogSchema()` at daemon boot. Incremental migrations land via `drizzle-orm/libsql/migrator` once schema changes start shipping.

### Daemon-side

- `daemon-service.ts` — uses Drizzle directly against `storage.client`. No wrapper class, no domain-type mappers — Drizzle's `$inferSelect` row types ARE the domain types.
- `packages/daemon/src/catalog/queries.ts` — the 5 multi-step helpers with business logic (`upsertRepo` / `upsertClone` evict stale unique-key collisions, `replaceWorktrees` is atomic delete-then-insert, `upsertWatchedPath` + `registerRepo` handle `ON CONFLICT` patterns). Everything else is one-line Drizzle inline.
- `packages/daemon/src/routes/catalog.ts` — `POST /api/v1/catalog/query`, `POST /api/v1/catalog/batch`, and `POST /api/v1/catalog/query-readonly` implement the server side of Drizzle's sqlite-proxy protocol. Loopback-gated by default (override via `SPAWNTREE_CATALOG_TRUST_REMOTE=1`). The readonly variant's classifier is a single-pass scanner that respects string literals and comments (regression-tested against `SELECT '--' || id; DELETE FROM x` and `PRAGMA main.journal_mode = DELETE` bypasses).

### ACP session persistence

- `SessionManager` takes a `StorageManager` and mirrors every ACP adapter event into the catalog DB via Drizzle. `createSession` upserts a row in `sessions`; `turn_started` / `turn_completed` hit `session_turns`; `tool_call_started` / `tool_call_completed` hit `session_tool_calls`. `message_delta` is intentionally skipped (would write-amplify per token).
- On `turn_completed` the manager calls `adapter.getSessionDetail` once and backfills the final `content`, `modelId`, `durationMs`, `stopReason` into `session_turns` (this is the catch-up for the intentionally-skipped deltas — from [#25](https://github.com/ziahamza/spawntree/pull/25)).
- Writes are queued per-session so events land in the order they were emitted — prevents `turn_completed`'s UPDATE from racing `turn_started`'s INSERT. `flushPersist()` is available for tests and shutdown.
- Sessions survive daemon restart; the s3-snapshot replicator captures them along with the rest of the catalog; external Drizzle clients read them with the same `schema` + typed `db.select() / query` patterns.

## Follow-up work (tracked as issues)

- [#17](https://github.com/ziahamza/spawntree/issues/17) — Device credential layer for admin routes. The loopback-origin check stops drive-by CSRF but doesn't stop a local attacker sharing a workstation. Pre-1.0 item.
- [#18](https://github.com/ziahamza/spawntree/issues/18) — Credential encryption at rest. `storage.json` is `0600` which matches `.env` convention; for defence-in-depth we should encrypt `authToken`, `secretAccessKey`, `accessKeyId`, `password` with a system-keychain-backed key. Post-1.0.
- [#19](https://github.com/ziahamza/spawntree/issues/19) — Auto-load providers from env vars at boot. For the "zero config → R2 backup in 5 minutes" flow.
- [#20](https://github.com/ziahamza/spawntree/issues/20) — Litestream-style WAL streaming primary/replicator. Continuous replication is materially better than the full-file snapshot for large DBs.
- [#21](https://github.com/ziahamza/spawntree/issues/21) — Postgres read-replica replicator. Mirror catalog rows into PG so read-only consumers can query from anywhere.

Not separately tracked but worth remembering: streaming the VACUUM INTO output directly into S3 multipart without the intermediate temp file. Needs libSQL support for a streaming `VACUUM INTO`, which may require custom work.

## Why this is net-positive for spawntree

1. **Disaster recovery.** Any spawntree user with an S3-compatible backend can set up off-host backup with one `POST /api/v1/storage/replicators`.
2. **Multi-machine workflows.** Teams can point multiple daemons at the same Turso DB (one primary + read replicas) and get shared visibility.
3. **Self-hosted friendly.** The default `forcePathStyle: true` + `region: "auto"` shape works against MinIO, Garage, Ceph, Backblaze B2, R2. Verified end-to-end against a live MinIO container.
4. **Clean extension point.** Third parties drop in primaries/replicators via `registry.registerPrimary/Replicator` with no spawntree core changes.
5. **Separation of concerns.** Primary vs replicator isolates "where does my data live" from "who else has a copy."
6. **Typed queries everywhere.** Daemon + external readers use the same Drizzle schema. A schema drift is a TypeScript error, not a runtime surprise.

## API surface summary

```
GET    /api/v1/storage
       → { primary: {id, config, status}, replicators: [...], availableProviders, migrating }

PUT    /api/v1/storage/primary                       body: { id, config }
       → { primary, replicators, availableProviders, migrating }  — migrates data on swap

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

POST   /api/v1/catalog/query                         body: { sql, params, method }
       → { rows }                                    (drizzle-orm/sqlite-proxy server)

POST   /api/v1/catalog/batch                         body: { queries: [...] }
       → { results: [{ rows }, ...] }

POST   /api/v1/catalog/query-readonly                body: { sql, params, method }
       → { rows }                                    (SELECT / WITH / EXPLAIN / read-only PRAGMA only)
```

All mutations reject non-loopback origins with `403 STORAGE_REMOTE_DENIED` unless `SPAWNTREE_STORAGE_TRUST_REMOTE=1` / `SPAWNTREE_CATALOG_TRUST_REMOTE=1` is set.

## Config file

Lives at `~/.spawntree/storage.json` with `0600` perms. Auto-created on first mutation. Schema:

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
