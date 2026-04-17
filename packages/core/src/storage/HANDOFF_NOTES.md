# Storage Providers — Handoff Notes

This PR lands the storage provider system for the spawntree daemon. It
establishes the architecture, ships three working providers (`local`,
`turso-embedded`, `s3-snapshot`), exposes runtime admin routes at
`/api/v1/storage/*` with probe and hot-swap support, and is covered by
unit + integration tests (15 StorageManager tests, 4 MinIO integration
tests gated on a running backend).

The daemon's existing `CatalogDatabase` still talks to its own
`better-sqlite3` handle — that migration is deliberately deferred to a
dedicated follow-up PR (see the issue linked at the bottom).

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
- Tests
  - `packages/core/tests/storage.test.ts` — registry + local provider + config
    persistence (6 tests).
  - `packages/daemon/tests/storage-manager.test.ts` — start/stop, config
    persistence + perms, hot-swap migration (happy path, no-op, rollback on
    failure), concurrency (overlapping swaps, migrating flag), probes,
    replicator add/remove, redaction (15 tests).
  - `packages/core/tests/s3-replicator-minio.test.ts` — integration against a
    running MinIO (4 tests, skipped if `SPAWNTREE_S3_TEST_ENDPOINT` is unset).
    Verifies the Devin CopySource regression is fixed, status info fields are
    populated, bad credentials surface as `fatal`, and `pause()` truly drains.

## What's NOT done (follow-up work for the spawntree agent)

### 1. Migrate `CatalogDatabase` to use the StorageManager's libSQL client

**Deferred to a dedicated PR — see tracking issue.**

The daemon's existing catalog uses `better-sqlite3` synchronously at
`packages/daemon/src/catalog/database.ts`. That code is untouched so the
daemon's behavior doesn't regress while we land the provider infrastructure.

The migration is larger than it first appears:
- 31 direct `catalog.*` call sites in `packages/daemon/src/services/daemon-service.ts`.
- 8+ helper functions that take `catalog` as a parameter and use it
  synchronously (`syncCloneWorktreesSync`, `enrichRepo`, `listRepoEnvsForRepo`,
  `repoSlugForRepoId`, `importGitRepoPathSync`, `buildGitPathInfoMap`,
  `syncWatchedPath`, `listRepoEnvsForRepo`).
- `CatalogDatabase` methods are all synchronous (`.prepare(...).get()`); libSQL
  is async-only, so the entire surface becomes `Promise`-returning.
- Every caller has to move from `Effect.sync` to `Effect.tryPromise`.
- No tests exist for `daemon-service.ts` today, which makes the async conversion
  risky without first adding regression coverage.

Recommended sequence for the follow-up PR:
1. Introduce Drizzle schema in `packages/core/src/db/schema.ts` covering the
   current catalog tables (repos, clones, worktrees, watched_paths,
   registered_repos) plus any session tables once PR #14 merges.
2. Add a programmatic migrator (e.g. Drizzle's `migrate` helper) run at
   `StorageManager.start()` time. Pick either runtime or `drizzle-kit migrate`
   as a daemon boot step — be consistent.
3. Rewrite `CatalogDatabase` internals in terms of Drizzle queries against
   `manager.client`. Keep the external method surface stable (just async).
4. Update `daemon-service.ts` call sites and helper signatures to await.
5. Remove `better-sqlite3` + `@types/better-sqlite3` from the daemon's
   `package.json`.
6. Add smoke-level tests for the daemon service that exercise the catalog
   code paths — the lack of coverage is the main reason this was deferred.

### 2. Admin auth: device credential layer

Currently the storage admin routes are gated by a loopback origin check (new
in this PR) plus the opt-out env var. That stops drive-by CSRF but doesn't
stop a local attacker who can reach 127.0.0.1 (e.g. another user on the same
machine). Before spawntree 1.0 we want:
- Device credential: shared secret at `~/.spawntree/daemon.key`, checked as a
  `Bearer` header on mutations.
- Configurable via the daemon config model (on by default in production
  builds, opt-out for dev).

### 3. Credential encryption at rest

`storage.json` now has `0600` perms, which matches `.env` conventions and is
acceptable for v1. For defence-in-depth we should encrypt the secret fields
(`authToken`, `secretAccessKey`, `accessKeyId`, `password`) with a
system-keychain-backed key (macOS Keychain / libsecret on Linux / DPAPI on
Windows). This is a post-1.0 item.

### 4. Additional providers

The `ReplicatorProvider` interface is finalized enough that third parties can
register their own. Natural next-steps to ship in-tree:
- **Litestream-style WAL streaming** primary/replicator. The current
  `s3-snapshot` is the dumb full-file approach — continuous WAL replication
  is materially better for large DBs.
- **Postgres read-replica** replicator: mirror rows into a PG schema so
  read-only consumers can query catalog/session state from elsewhere.
- **Turso read-replica** replicator: complement the embedded primary with a
  push-only read replica for multi-host setups.

### 5. Auto-load providers from env vars at boot

Today the user has to `POST /api/v1/storage/replicators` after boot to
activate backup. For the "zero config → R2 backup in 5 minutes" flow we
want:
- `SPAWNTREE_STORAGE_PRIMARY=turso-embedded` + related env vars to pre-seed
  the primary.
- `SPAWNTREE_STORAGE_REPLICATORS=s3-prod` + per-replicator env groups to
  pre-seed replicators.
- Boot-time reconciliation with whatever's already in `storage.json`.

### 6. Streaming S3 upload

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
