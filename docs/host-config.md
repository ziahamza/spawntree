# Centralized storage config via `spawntree-host`

By default, each `spawntree-daemon` reads `~/.spawntree/storage.json` to learn
which primary database to use and which replicators to run. That's fine for a
single laptop, but it doesn't scale to "I have ten daemons across three
machines and I want them all to replicate to the same Turso database."

The `--host` / `--host-key` flags let a daemon fetch its storage config from a
central `spawntree-host` server on every boot, so the operator changes the
target in one place and every daemon reconciles to it.

This is opt-in. A daemon started without `--host` (and without a persisted
`~/.spawntree/host.json`) behaves exactly like before.

## When to use this

- You run multiple daemons (laptops, CI runners, remote dev boxes) and want
  them all replicating to the same Turso/S3/whatever sink.
- You need to rotate replication credentials without SSHing into each box.
- You want a paper trail of which daemons exist and when each last checked in.

If you run a single daemon on a single machine, keep using `storage.json` —
this feature adds an extra hop you don't need.

## Architecture in one diagram

```
        ┌──────────────────────────────────────────┐
        │            spawntree-host                │
        │  (admin API: mint/list/configure daemons)│
        │           hosts.db (SQLite)              │
        └──────────────┬───────────────────────────┘
                       │  GET /api/daemons/me/config
                       │  Authorization: Bearer dh_…
                       │  → { config: StorageConfig }
        ┌──────────────┴───────────────┬───────────────────┐
        ▼                              ▼                   ▼
   spawntree-daemon            spawntree-daemon     spawntree-daemon
   (laptop, --host …)          (CI runner)          (remote dev box)
        │                              │                   │
        ▼                              ▼                   ▼
   StorageManager.applyConfig — primary + replicators reconcile in-place
```

The host server is the same package you may already be using as a federation
proxy (`/h/:name/*`). The `/api/daemons` family is the new surface; the
`/api/hosts` admin and `/h/:name/*` proxy paths are unchanged.

## Step-by-step: bind a fresh daemon to a host

### 1. Run a host server somewhere reachable

```bash
npm i -g spawntree-host
HOST_SERVER_PORT=7777 spawntree-host
# [spawntree-host] listening on http://127.0.0.1:7777 (db: ./hosts.db)
```

For anything beyond a single laptop, run it on a server everyone can reach.
There's no built-in TLS or auth on the admin endpoints — put it on a private
network, behind a reverse proxy, or both.

### 2. Mint a daemon credential

```bash
curl -X POST http://controller:7777/api/daemons \
  -H 'content-type: application/json' \
  -d '{"label":"hzia-laptop"}'
```

Response (the only time the full key is shown):

```json
{
  "key": "dh_AbCdEf...43_more_chars",
  "label": "hzia-laptop",
  "registeredAt": "2026-04-28T10:00:00.000Z",
  "warning": "This is the only time the full key is shown. Store it securely on the daemon machine."
}
```

The `dh_…` value is **both identity and authentication** — there's no separate
daemon ID. Capture it, copy it to the daemon's machine. If you lose it, mint a
new one and revoke the old (`DELETE /api/daemons/<keyFingerprint>` — see
below).

### 3. Push a storage config for that daemon

```bash
curl -X PUT http://controller:7777/api/daemons/dh_AbCdEf.../config \
  -H 'content-type: application/json' \
  -d '{
    "config": {
      "primary": { "id": "local", "config": {} },
      "replicators": [
        {
          "rid": "main-snapshot",
          "id": "s3-snapshot",
          "config": {
            "bucket": "spawntree-prod",
            "region": "us-east-1",
            "intervalMs": 300000
          }
        }
      ]
    }
  }'
```

The `config` field follows the `StorageConfig` shape from `spawntree-core`:
one `primary` (the libSQL backing store) and zero-or-more `replicators` (each
identified by `rid`, the *daemon-local* name, plus `id`, the provider name).

The host validates the structural shape but does not run schema validation —
the daemon does that when it actually applies the config.

### 4. Boot the daemon with the binding

```bash
spawntree daemon \
  --host http://controller:7777 \
  --host-key dh_AbCdEf...43_more_chars
# [spawntree-daemon] host: persisted binding to /Users/you/.spawntree/host.json
# [spawntree-daemon] host: bound to http://controller:7777 (key dh_…AbCdEf)
# [spawntree-daemon] API: http://127.0.0.1:2222/api/v1/daemon
```

After the first run, `~/.spawntree/host.json` (perms `0600`) caches the
binding, so subsequent runs don't need the flags:

```bash
spawntree daemon
# (still talks to the same host)
```

To unbind, delete the file:

```bash
rm ~/.spawntree/host.json && spawntree daemon
# now in standalone mode, reads ~/.spawntree/storage.json again
```

To switch a daemon to a different host, pass new flags — they overwrite the
persisted file:

```bash
spawntree daemon --host http://other:7777 --host-key dh_…NEW_KEY…
```

## What happens at boot

1. Daemon starts its HTTP server immediately. It does NOT block on the host.
2. `HostConfigSync` issues the first `GET /api/daemons/me/config`.
3. Three possible responses:
   - **`200`** with a `config` payload → `StorageManager.applyConfig` reconciles
     the primary and the replicator set. Log line: `host config applied`.
   - **`404 NO_CONFIG_SET`** → the operator minted the daemon but hasn't pushed
     a config yet. Daemon keeps using its existing `storage.json`. Status
     reads `awaiting_config`.
   - **anything else** (5xx, network failure, malformed JSON) → status reads
     `error`, retry on exponential backoff (5s → 30s → 2m → 10m cap).
4. After a successful sync, the loop polls every 5 minutes for changes.

The reconciler is a diff, not a wipe-and-reload:

- **Primary unchanged** → noop.
- **Primary id or config changed** → hot-swap with full data migration (same
  code path as `POST /api/v1/storage/primary` from the admin API).
- **Replicator with same `rid` and same canonical config** → handle preserved,
  no flap.
- **Replicator with same `rid` but different config** → stop old + start new.
- **Replicator in current but not in target** → stopped + removed.
- **Replicator in target but not in current** → started fresh.

The whole `applyConfig` runs inside the manager's lock so an admin-API caller
can't observe a half-applied state.

## Inspecting state

### From the host server

List every daemon the host knows about:

```bash
curl http://controller:7777/api/daemons
```

```json
{
  "daemons": [
    {
      "keyFingerprint": "dh_AbCdEf12",
      "label": "hzia-laptop",
      "registeredAt": "2026-04-28T10:00:00.000Z",
      "lastSeenAt": "2026-04-28T10:05:01.000Z",
      "hasConfig": true
    }
  ]
}
```

The list never returns the full key — only a 12-char fingerprint, so
screen-sharing the dashboard doesn't leak credentials. `lastSeenAt` updates
on each successful authenticated fetch, including 404s, so you can tell
whether a daemon is reachable separately from whether it has a config.

### From the daemon

The daemon's `/api/v1/storage` endpoint exposes a snapshot of the active
primary, replicator handles, and the host-sync status:

```bash
curl http://127.0.0.1:2222/api/v1/storage | jq .hostSync
```

States: `idle` → `fetching` → `synced` | `awaiting_config` | `error`. The
`error` payload includes the next retry timestamp.

## Operational recipes

### Rotate a daemon's credential

```bash
# 1. Mint a new key.
curl -X POST http://controller:7777/api/daemons \
  -H 'content-type: application/json' \
  -d '{"label":"hzia-laptop"}'
# 2. Restart the daemon with the new --host-key. The persisted file overrides.
spawntree daemon --host http://controller:7777 --host-key dh_…NEW_KEY…
# 3. Once the new daemon is checking in, revoke the old key.
curl -X DELETE http://controller:7777/api/daemons/dh_…OLD_KEY…
```

### Push a config change to every daemon

Update the daemon's config row on the host. Every daemon picks up the change
on its next 5-minute poll (or restart). No need to touch any daemon machine.

```bash
curl -X PUT http://controller:7777/api/daemons/dh_…/config \
  -H 'content-type: application/json' \
  -d '{"config": { "primary": { … }, "replicators": [ … ] }}'
```

### Park a daemon (stop applying configs without uninstalling)

Set its config back to `null` on the host:

```bash
curl -X PUT http://controller:7777/api/daemons/dh_…/config \
  -H 'content-type: application/json' \
  -d '{"config": null}'
```

Now `/api/daemons/me/config` returns `404 NO_CONFIG_SET`. The daemon stays
running with whatever it was last applying (its `storage.json` is untouched);
status reads `awaiting_config` so dashboards can see the pause is intentional.

### Move from standalone to host-managed

Daemons that already have a working `storage.json` can switch over without
losing their replication: the first successful `applyConfig` reconciles in
place. If the host-side config matches the existing local config, it's a
no-op (the manager preserves replicator handles by `rid`).

## Security notes

- **The bearer token is the daemon's identity.** Anyone with the `dh_…` value
  can read that daemon's config from the host. Treat it like a personal
  access token.
- **`host.json` is `0600`.** A snooping local user can't read the token off
  the filesystem on a Unix box. (Non-POSIX filesystems silently degrade —
  on Windows / network mounts, file ACLs are your responsibility.)
- **The host's admin endpoints are unauthenticated by design.** Same posture
  as the existing `/api/hosts` proxy — put it behind a private network or a
  reverse proxy that adds auth. Adding bearer auth to the admin paths is a
  natural next step but explicitly out of scope for this PR.
- **Compromised daemon keys can be revoked instantly.** Once you `DELETE
  /api/daemons/<keyFingerprint>`, the next config fetch returns `401`,
  the daemon's status flips to `error`, and the daemon stops applying
  whatever you would have pushed next. (It keeps running with the last
  config it successfully applied — revocation does not stop replication.)

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `error: 401 key not recognized` | Key was revoked or mistyped | Mint a new key, restart with `--host-key` |
| Stuck in `fetching` for >30s | Host is unreachable, not 404 | Check `--host` URL, network/firewall |
| `awaiting_config` forever | No `PUT /config` ever hit | Push a config to the daemon's row |
| `applyConfig failed: …` | Operator pushed a malformed config | Fix the config; daemon retries on next poll |
| Daemon sees old config after `PUT` | Wait up to 5 minutes, or restart | Default poll interval is 5 min |

## API reference

Surfaced by `spawntree-host`:

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/daemons` | none | Mint a new daemon credential |
| `GET` | `/api/daemons` | none | List daemons (fingerprints only) |
| `DELETE` | `/api/daemons/<key>` | none | Revoke a daemon |
| `GET` | `/api/daemons/<key>/config` | none | Read the current config (admin view) |
| `PUT` | `/api/daemons/<key>/config` | none | Set the daemon's config |
| `GET` | `/api/daemons/me/config` | `Bearer <key>` | Daemon-side fetch path |

Surfaced by `spawntree-daemon`:

| Flag | Purpose |
|------|---------|
| `--host <url>` | Host server base URL. Persisted to `~/.spawntree/host.json`. |
| `--host-key <dh_…>` | Bearer token from `POST /api/daemons`. Persisted alongside the URL. |

Both flags are passed together or not at all. Either alone exits with code 2.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `SPAWNTREE_HOST_POLL_INTERVAL_MS` | Override the default 5-minute poll interval for host config sync. Internal/test debugging knob — must be a positive integer; invalid values exit with code 2. |
