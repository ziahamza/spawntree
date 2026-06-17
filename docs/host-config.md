# Centralized storage config via `spawntree-host`

By default, each `spawntree-daemon` reads `~/.spawntree/storage.json` to learn
how its local catalog should sync upstream. The catalog itself is always one
SQLite file at `~/.spawntree/spawntree.db`, opened through Turso Sync's local
engine.

The `--host` / `--host-key` flags let a daemon fetch that sync config from a
central `spawntree-host` server on boot and then poll for changes. Operators can
rotate credentials or move a machine between `none`, `turso`, and `s3` sync
without SSHing into the machine.

This is opt-in. A daemon started without `--host` and without a persisted
`~/.spawntree/host.json` reads its local `storage.json` and defaults to
`{ "syncMethod": "none" }`.

## Config Shape

`StorageConfig` has a sharp shape:

```json
{ "syncMethod": "none" }
```

```json
{
  "syncMethod": "turso",
  "turso": {
    "url": "libsql://machine-db-org.turso.io",
    "authToken": "rw-token"
  }
}
```

```json
{
  "syncMethod": "s3",
  "s3": {
    "bucket": "spawntree-snapshots",
    "keyPrefix": "machines/hzia-laptop",
    "accessKeyId": "AKIA...",
    "secretAccessKey": "secret"
  }
}
```

There is no storage provider registry and no source-of-truth swap. Changing
`syncMethod` reopens the same local SQLite catalog with different background
sync behavior.

## Architecture

```
        spawntree-host
   (admin API + daemon config)
              |
              | GET /api/daemons/me/config
              | Authorization: Bearer dh_...
              v
       spawntree-daemon
              |
              v
   ~/.spawntree/spawntree.db
   (local Turso SQLite catalog)
              |
              +-- syncMethod: none  -> local only
              +-- syncMethod: turso -> async push/pull to Turso Cloud
              +-- syncMethod: s3    -> async whole-file snapshot upload
```

The host server is the same package used as a federation proxy (`/h/:name/*`).
The `/api/daemons` family manages daemon credentials and sync configs; the
`/api/hosts` admin and `/h/:name/*` proxy paths are unchanged.

## Bind a Fresh Daemon

### 1. Run a host server somewhere reachable

```bash
npm i -g spawntree-host
HOST_SERVER_PORT=7777 spawntree-host
```

For anything beyond a single laptop, run it on a server everyone can reach.
There is no built-in TLS or auth on the admin endpoints, so put it on a private
network, behind a reverse proxy, or both.

### 2. Mint a daemon credential

```bash
curl -X POST http://controller:7777/api/daemons \
  -H 'content-type: application/json' \
  -d '{"label":"hzia-laptop"}'
```

Response:

```json
{
  "key": "dh_AbCdEf...43_more_chars",
  "label": "hzia-laptop",
  "registeredAt": "2026-04-28T10:00:00.000Z",
  "warning": "This is the only time the full key is shown. Store it securely on the daemon machine."
}
```

The `dh_...` value is both identity and authentication. If it is lost, mint a
new key and revoke the old one.

### 3. Push a sync config for that daemon

```bash
curl -X PUT http://controller:7777/api/daemons/dh_AbCdEf.../config \
  -H 'content-type: application/json' \
  -d '{
    "config": {
      "syncMethod": "turso",
      "turso": {
        "url": "libsql://machine-db-org.turso.io",
        "authToken": "rw-token"
      }
    }
  }'
```

The host validates the basic structure. The daemon validates the full
`StorageConfig` schema before applying it.

### 4. Boot the daemon with the binding

```bash
spawntree daemon \
  --host http://controller:7777 \
  --host-key dh_AbCdEf...43_more_chars
```

After the first run, `~/.spawntree/host.json` caches the binding with `0600`
permissions, so later runs can use:

```bash
spawntree daemon
```

To unbind, delete `~/.spawntree/host.json`. To switch hosts, pass a new
`--host` and `--host-key`; the daemon overwrites the persisted binding.

## Boot Behavior

1. The daemon starts `StorageManager`, which opens `spawntree.db`.
2. `HostConfigSync` fetches `GET /api/daemons/me/config`.
3. `200` with a `config` payload applies the new `syncMethod`.
4. `404 NO_CONFIG_SET` marks host sync as `awaiting_config`; the local catalog
   stays available with the last valid config.
5. Other failures retry on exponential backoff.

`applyConfig` is serialized by the storage manager. A bad config fails before
it is persisted, and the daemon reopens the previous config.

## Inspecting State

From the host server:

```bash
curl http://controller:7777/api/daemons
```

From the daemon:

```bash
curl http://127.0.0.1:2222/api/v1/storage | jq .
```

The daemon response is:

```json
{
  "storage": {
    "id": "sqlite",
    "config": {},
    "status": { "healthy": true }
  },
  "sync": {
    "method": "turso",
    "config": { "url": "libsql://...", "authToken": "***redacted***" },
    "status": { "healthy": true }
  },
  "reconfiguring": false,
  "hostSync": { "state": "synced", "lastSyncAt": "2026-04-28T10:05:01.000Z", "daemonLabel": "hzia-laptop" }
}
```

## Operational Recipes

### Rotate a daemon credential

```bash
curl -X POST http://controller:7777/api/daemons \
  -H 'content-type: application/json' \
  -d '{"label":"hzia-laptop"}'

spawntree daemon --host http://controller:7777 --host-key dh_...NEW_KEY...

curl -X DELETE http://controller:7777/api/daemons/dh_...OLD_KEY...
```

### Push a config change

```bash
curl -X PUT http://controller:7777/api/daemons/dh_.../config \
  -H 'content-type: application/json' \
  -d '{"config": { "syncMethod": "none" }}'
```

The daemon applies the change on the next poll or restart.

### Park a daemon

Set its config to `null`:

```bash
curl -X PUT http://controller:7777/api/daemons/dh_.../config \
  -H 'content-type: application/json' \
  -d '{"config": null}'
```

The daemon reports `awaiting_config` and keeps the last valid local catalog
config until a new config is pushed.

## Security Notes

- The bearer token is the daemon's identity. Treat it like a personal access
  token.
- `host.json` is written with `0600` permissions where the filesystem supports
  POSIX modes.
- Admin endpoints are unauthenticated by design. Put the host behind a private
  network or authenticated reverse proxy.
- Revoking a daemon key stops future config fetches. It does not delete the
  daemon's local catalog.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `error: 401 key not recognized` | Key was revoked or mistyped | Mint a new key and restart with `--host-key` |
| Stuck in `fetching` | Host unreachable | Check `--host`, network, and firewall |
| `awaiting_config` forever | No config pushed | Push a config to the daemon row |
| `applyConfig failed` | Malformed config | Fix the config; daemon retries on next poll |
| Daemon sees old config after `PUT` | Poll has not fired yet | Wait up to 5 minutes or restart |

## API Reference

Surfaced by `spawntree-host`:

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/daemons` | none | Mint a new daemon credential |
| `GET` | `/api/daemons` | none | List daemons |
| `DELETE` | `/api/daemons/<key>` | none | Revoke a daemon |
| `GET` | `/api/daemons/<key>/config` | none | Read config |
| `PUT` | `/api/daemons/<key>/config` | none | Set config |
| `GET` | `/api/daemons/me/config` | `Bearer <key>` | Daemon fetch path |

Surfaced by `spawntree-daemon`:

| Flag | Purpose |
| --- | --- |
| `--host <url>` | Host server base URL. Persisted to `~/.spawntree/host.json`. |
| `--host-key <dh_...>` | Bearer token from `POST /api/daemons`. Persisted alongside the URL. |

Both flags are passed together or not at all.

### Environment Variables

| Variable | Purpose |
| --- | --- |
| `SPAWNTREE_HOST_POLL_INTERVAL_MS` | Override the default 5-minute host config poll interval. |
| `SPAWNTREE_HOST_REQUEST_TIMEOUT_MS` | Abort individual host config, heartbeat, and session-sync HTTP requests after this many milliseconds. Default: 30000. |
