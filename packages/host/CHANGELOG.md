# spawntree-host

## 0.4.0

### Minor Changes

- [#38](https://github.com/ziahamza/spawntree/pull/38) [`b3b4412`](https://github.com/ziahamza/spawntree/commit/b3b44126aee347b91cb3173fa248dd167d69342f) Thanks [@ziahamza](https://github.com/ziahamza)! - Two follow-ups on top of `--host` / `--host-key` ([#35](https://github.com/ziahamza/spawntree/issues/35)):

  **`spawntree-host`**: split `server.ts` into a `createApp({ store, host, port })`
  factory plus a thin CLI entrypoint guarded by `import.meta.url ===
fileURLToPath(process.argv[1])`. `openStore` and the `Store` type are now
  exported. The CLI behavior is unchanged (same env vars, same bin) but
  embedders can now bind the handler to any `http.Server` without a child
  process. The landing page at `GET /` now lists registered daemons (with
  "config set" / "awaiting config" pills) alongside federation hosts.

  **`spawntree-daemon`**: `GET /api/v1/storage` now returns a `hostSync` field
  (union: `idle` | `fetching` | `synced` | `awaiting_config` | `error`, or
  `null` in standalone mode) so the dashboard can paint host-binding state
  without a separate endpoint. The infra page in the bundled web app
  surfaces a "Storage" card and (when `--host` is in effect) a "Host
  binding" card next to the existing PostgreSQL / Redis cards. Polished
  across all four host-sync states + mobile after end-to-end QA: relative
  time formatting, trimmed error messages, multi-line value layout fix,
  status pill mapping (`Synced` / `Idle` / `Error` / `Fetching`).

  **`spawntree-core`**: new `StorageStatusResponse` and `HostSyncState`
  schemas, plus `apiClient.getStorageStatus()`.

  Also: replaced the child-process integration test for the host server
  with an in-process one that wires the new `createApp` factory to a
  random-port `http.Server`. ~2× faster, no race on stderr, no dependency
  on `dist/server.js` existing at test time. Bumped daemon's
  `vitest.config` default timeout from 5s to 15s — pre-existing
  parallel-load flakiness that grew worse as the suite passed 150 tests.

## 0.3.0

### Minor Changes

- [#37](https://github.com/ziahamza/spawntree/pull/37) [`c94e6f9`](https://github.com/ziahamza/spawntree/commit/c94e6f974509025e6b9281563283b178a3d94863) Thanks [@ziahamza](https://github.com/ziahamza)! - Centralized storage config sync via `--host` / `--host-key`.

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

## 0.2.1

### Patch Changes

- [#27](https://github.com/ziahamza/spawntree/pull/27) [`ca16b3d`](https://github.com/ziahamza/spawntree/commit/ca16b3d3c8a228fae1d47e4b4f7ff3835acf9b0e) Thanks [@ziahamza](https://github.com/ziahamza)! - Renamed package from `spawntree-host-server` to `spawntree-host` before its first npm publish. The shorter name fits the vocabulary the rest of the docs already use ("a federation host"), the `bin` is now `spawntree-host`, and the source directory moves to `packages/host/`. Nothing shipped under the old name, so there's no migration path to worry about — this is just picking the final name ahead of the first real publish.

## 0.2.0

### Minor Changes

- First public release of `spawntree-host` (originally merged as
  `spawntree-host-server` in [#14](https://github.com/ziahamza/spawntree/pull/14);
  renamed before first npm publish so the package ships under its final name).
  A SQLite-backed registry + reverse proxy that lets one web dashboard switch
  between multiple spawntree daemons running on different machines.

  - Pure Node.js server (< 500 lines, one dep: `better-sqlite3`).
  - Admin API: `GET/POST/DELETE /api/hosts`, `GET /api/hosts/:name/health`.
  - Proxies API calls to the selected host, including SSE streams.
  - HTML landing page escapes user-supplied labels and preserves query strings
    on proxied URLs.
  - Ships a `bin` (`spawntree-host`) so teams can `npm i -g` or `npx spawntree-host`
    without copying source.
