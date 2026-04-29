---
"spawntree-daemon": minor
"spawntree-host": minor
---

Centralized storage config sync via `--host` / `--host-key`.

**Daemon**: new CLI flags `--host <url>` and `--host-key <dh_…>` bind a daemon
to a `spawntree-host` server. The pair is persisted to `~/.spawntree/host.json`
(0600) so subsequent boots don't need the args. On boot, the daemon pulls its
`StorageConfig` from `GET /api/daemons/me/config` and reconciles in-place via
`StorageManager.applyConfig` — primary swaps with data migration, replicators
diff by `rid`. Boot is non-blocking: 5-min steady-state poll, exponential
backoff (5s → 30s → 2m → 10m) on failure, `awaiting_config` state on host 404.
Status snapshot exposed via `GET /api/v1/storage`.

**Host**: new `daemons` table + endpoints. `POST /api/daemons` mints a `dh_…`
bearer credential (only revealed once); `GET /api/daemons` lists fingerprints;
`GET|PUT /api/daemons/<key>/config` lets operators push the config; `DELETE`
revokes; `GET /api/daemons/me/config` is the daemon's auth-gated read with
`Authorization: Bearer <key>`. The bearer token is identity + auth in one
shot — no separate daemon ID.

See `docs/host-config.md` for the full operator walkthrough.
