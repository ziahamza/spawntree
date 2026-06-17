# SpawnTree Storage

SpawnTree has one catalog database: `<dataDir>/spawntree.db`.

That file is always opened through Turso Sync's local SQLite engine. The daemon
does not choose between storage implementations, migrate between databases, or
keep a second source of truth. `storage.json` only selects how the local catalog
syncs upstream:

```json
{ "syncMethod": "none" }
```

```json
{
  "syncMethod": "turso",
  "turso": {
    "url": "libsql://machine-db.turso.io",
    "authToken": "rw-token"
  }
}
```

```json
{
  "syncMethod": "s3",
  "s3": {
    "bucket": "spawntree-backups",
    "keyPrefix": "laptop",
    "accessKeyId": "...",
    "secretAccessKey": "..."
  }
}
```

## Runtime API

`GET /api/v1/storage` returns:

```json
{
  "storage": {
    "id": "sqlite",
    "config": {},
    "status": { "healthy": true }
  },
  "sync": {
    "method": "none",
    "config": {},
    "status": { "healthy": true }
  },
  "reconfiguring": false,
  "hostSync": null
}
```

`POST /api/v1/storage/sync` triggers the configured background sync once.

## Files

- `types.ts` defines the config and status shapes.
- `sqlite.ts` opens the local SQLite file through `@tursodatabase/sync` and
  adapts it to the libSQL client interface used by Drizzle.
- `s3-snapshot.ts` implements the optional S3 snapshot loop.
- `config.ts` loads/saves `storage.json` with `0600` permissions.

The daemon-side `StorageManager` owns the one live sqlite handle, applies
host-provided sync config, and exposes the libSQL client used by the catalog.
