# Storage Providers — Handoff Notes

This PR scaffolds the storage provider system for the spawntree daemon.
It establishes the architecture, ships three working providers (`local`,
`turso-embedded`, `s3-snapshot`), and exposes runtime admin routes at
`/api/v1/storage/*`. The DaemonService's existing `CatalogDatabase` is
**not** migrated to the new layer in this PR — that's a follow-up so the
two concerns land separately.

## What's shipped

- `spawntree-core/storage`
  - `types.ts` — `PrimaryStorageProvider`, `ReplicatorProvider`, `StorageRegistry`, `ProviderStatus`, config schema
  - `registry.ts` — provider lookup/registration
  - `providers/local.ts` — default, plain libSQL file (covered by tests)
  - `providers/turso-embedded.ts` — libSQL embedded replica with `syncUrl`
  - `providers/s3-snapshot.ts` — VACUUM INTO + tmp-key upload + atomic CopyObject
  - `config.ts` — persisted config load/save with Effect Schema validation
- `spawntree-daemon`
  - `storage/manager.ts` — orchestrates registry + persisted config + active connections
  - `routes/storage.ts` — HTTP admin endpoints
  - `server-main.ts` boots a `StorageManager` and shuts it down on SIGINT/SIGTERM
  - `server.ts` mounts storage routes conditionally
- `packages/core/tests/storage.test.ts` — registry + local provider + config persistence

## What's NOT done (follow-up work for the spawntree agent)

### 1. Migrate `CatalogDatabase` to use the StorageManager's libSQL client

The daemon's existing catalog uses `better-sqlite3` directly at `packages/daemon/src/catalog/database.ts`. That code is untouched. To actually benefit from the storage providers (Turso sync, S3 snapshots), the catalog needs to read/write through `manager.client` instead of its own `better-sqlite3` handle.

Steps:
1. Introduce Drizzle schema in a new `packages/core/src/db/schema.ts` covering repos, clones, worktrees, registered paths, settings, plus the session tables from PR #14 once that merges.
2. Replace `CatalogDatabase`'s raw SQL with Drizzle queries against the `StorageManager`'s client.
3. Wire migration execution: on daemon boot, run `drizzle-kit migrate` (or equivalent programmatic migrator) against `manager.client` before any read/write.
4. Remove `better-sqlite3` as a dep once `CatalogDatabase` no longer uses it.

### 2. Hot-swap primary with data migration

`StorageManager.setPrimary()` currently shuts down the old primary and opens a new one **without copying data**. This is explicitly flagged in a `TODO` comment. Users who swap `local` → `turso-embedded` would lose everything.

Design:
- On swap, open the new primary WITHOUT closing the old one.
- Run the canonical schema migrations on the new primary.
- Copy all rows from old → new (table-by-table; both are libSQL so batched `INSERT`s are fine).
- Swap the active reference.
- Close the old primary.
- Persist config.

If any step fails, close the new primary and keep the old one active. Return a descriptive 500 from the API.

Writes during migration: block them at the manager level with a short "migrating" flag; the daemon's catalog operations should get a `STORAGE_MIGRATING` error. Alternatively, drain in-flight requests first.

### 3. Provider validation & probe endpoint

Right now, `PUT /api/v1/storage/primary` with an invalid config either throws on `create()` (bubbles up as a 500) or succeeds with a half-working primary. We should add:

- `POST /api/v1/storage/primary/probe` — validate config + attempt a test connection WITHOUT committing. Returns `{ ok: true }` or `{ ok: false, error }`.
- Same for replicators: `POST /api/v1/storage/replicators/probe`.

This is what UIs will call to show "Test connection" before saving.

### 4. Concurrency-safe S3 replicator

The current s3-snapshot replicator:
- Uses `VACUUM INTO` which locks the primary DB briefly (okay for SQLite).
- Runs serially via `inFlight` guard — won't overlap with itself.
- But doesn't coordinate with other replicators or with primary hot-swap.

Before calling this production-ready:
- Ensure the replicator pauses (or yields) during primary swap.
- Add a `lastOkBytes` / `objectEtag` to status.
- Consider streaming the snapshot directly to S3 multipart upload without the intermediate temp file (for large DBs).
- Error classification: transient (retry) vs fatal (surface to status).

### 5. Tests

- Integration test for `StorageManager` end-to-end: boot, register replicator via API, trigger, verify S3 object exists (use a local MinIO or aws-sdk mock).
- Integration test for Turso: use `@libsql/embedded` in-memory mode or a local turbo test server.
- Property test for config persistence with arbitrary provider configs.

### 6. Security hardening

The storage admin routes are currently unauthenticated — consistent with the rest of the daemon API, which assumes localhost-only. Before this ships in a deployed/remote context, the admin routes MUST be gated:

- Device credential header check (per the "daemon uses local device credential" design in the integration discussion).
- Origin restriction: only accept requests from `127.0.0.1` / `::1`.
- Secret redaction is already in place for `GET /api/v1/storage`, but double-check: `authToken`, `secretAccessKey`, `accessKeyId`, `password`.

## Why this is net-positive for spawntree

Beyond the gitenv integration story:

1. **Disaster recovery.** Every spawntree user now has a trivial path to backing up their session history and repo catalog. Set `SPAWNTREE_STORAGE_REPLICATOR=s3-snapshot` with creds, done.
2. **Multi-machine workflows.** Teams can point multiple daemons at the same Turso DB (one primary + read replicas) and get shared session visibility.
3. **Self-hosted friendly.** `s3-snapshot` works against MinIO, Garage, Ceph, any S3-compatible store. No forced cloud dependency.
4. **Clean extension point.** Third-party providers (dropbox sync, Hetzner Storage Box over SFTP, Postgres replica, whatever) drop in by calling `registry.registerReplicator(...)`. No spawntree core changes needed.
5. **Clear separation of concerns.** Primary vs replicator isolates "where does my data live" from "who else has a copy."

## API surface summary

```
GET    /api/v1/storage
       → { primary: {id, config, status}, replicators: [...], availableProviders: {...} }

PUT    /api/v1/storage/primary          body: { id, config }
       → { primary, replicators, availableProviders }

POST   /api/v1/storage/replicators      body: { rid, id, config }
       → 201 { primary, replicators, availableProviders }

POST   /api/v1/storage/replicators/:rid/trigger
       → { status: ProviderStatus }

DELETE /api/v1/storage/replicators/:rid
       → { ok: true }
```

## Config file

Lives at `~/.spawntree/storage.json`. Auto-created on first mutation. Schema:

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

## Open design questions

- Should `PUT /api/v1/storage/primary` require a `confirm: "yes-really-swap"` body field until migration is implemented? (Current PR does not.)
- Config file stored in plaintext includes credentials. Should we encrypt with a local machine key? System keychain (macOS Keychain / libsecret)? Leaving as plaintext for v1 with 0600 perms feels acceptable, matching `.env` conventions. Flag if you disagree.
- `s3-snapshot` uses `VACUUM INTO` which briefly write-locks the DB. Fine for small catalogs, potentially disruptive for large session histories. An incremental alternative is worth prototyping after v1.
