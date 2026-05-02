# spawntree-core

## 0.7.0

### Minor Changes

- [#43](https://github.com/ziahamza/spawntree/pull/43) [`896bd8e`](https://github.com/ziahamza/spawntree/commit/896bd8e5d4ba0d385766c65e1b3482f68f09eed7) Thanks [@ziahamza](https://github.com/ziahamza)! - Lift the catalog schema, HTTP client, and a new daemon-first/host-fallback
  routing client into `spawntree-core/browser` so embedders (gitenv, custom
  dashboards, CLIs) stop redeclaring tables and roll-your-own probe loops.

  **`spawntree-core/browser`** now re-exports everything in `db/schema.ts` and
  `db/http-client.ts`, plus two new helpers:

  - `probeDaemonReachable({ url, timeoutMs })` — never-throws liveness probe
    hitting `/health` (or a custom path) with a short abort budget. Returns
    a boolean.
  - `createRoutingCatalogClient({ primary, fallback, probeTtlMs, onRouteChange })`
    — Drizzle database that routes per-query between two catalog endpoints
    based on a TTL-cached probe. Inflight probe dedupe (no thundering herd),
    `onRouteChange` hook for "live / read-only" badges in dashboards.

  Server-side consumers can keep importing from the package root; nothing
  moved, the new helpers are available there too via `db/index.ts`. The
  browser entry stays free of `@libsql/client` and other Node-only deps.

  13 new tests cover the probe (timeout, network errors, custom path) and
  the routing client (route flips, TTL caching, stampede dedupe,
  `onRouteChange` semantics).

  See `docs/embedding.md` for the import patterns.

## 0.6.0

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

## 0.5.0

### Minor Changes

- [#37](https://github.com/ziahamza/spawntree/pull/37) [`c94e6f9`](https://github.com/ziahamza/spawntree/commit/c94e6f974509025e6b9281563283b178a3d94863) Thanks [@ziahamza](https://github.com/ziahamza)! - Backfill git metadata from `working_directory` in the discovery loop, plus
  re-export `detectGitMetadata` from `spawntree-core` for downstream daemons.

  **Why**: some sessions reach `runDiscoveryPass` with NULL git metadata —
  most commonly older Codex sessions whose `thread.gitInfo` wasn't captured
  at session creation time. Without a `gitBranch` value those rows can't be
  linked to a PR in the consuming UI, even though the session is clearly
  tied to a particular branch on disk.

  **Daemon**: when `discoverSessions` returns a row with any of `gitBranch /
gitHeadCommit / gitRemoteUrl` null, `SessionManager.runDiscoveryPass` now
  runs `git rev-parse` against the session's `workingDirectory` and merges
  in whatever's missing. Adapter-reported values always win; we only fill
  nulls. A per-cwd cache prevents the daemon from re-spawning git on every
  30-second discovery tick. Sessions whose `workingDirectory` no longer
  exists (deleted worktree) skip the spawn entirely — the existing nulls
  stay null, which is correct.

  **Core**: re-exports `detectGitMetadata` and `GitMetadata` from
  `spawntree-core`'s public entry point so daemons (and other downstream
  consumers) can use the same git detection helper without depending on
  internal `lib/git.ts` paths. The helper itself was added to core by [#31](https://github.com/ziahamza/spawntree/issues/31).

## 0.4.0

### Minor Changes

- [#14](https://github.com/ziahamza/spawntree/pull/14) [`fb288c0`](https://github.com/ziahamza/spawntree/commit/fb288c0ebc077407d64efbce923b4cf42dc9ccb5) Thanks [@ziahamza](https://github.com/ziahamza)! - Add agent session API — drive Claude Code and Codex through the daemon as
  first-class sessions.

  - Normalized `ACPAdapter` layer in `spawntree-core` (Claude Code via native ACP,
    Codex via JSON-RPC app-server facade). Third-party providers register via
    `SessionManager.registerAdapter`.
  - New HTTP API: `/api/v1/sessions` (list, create, detail, delete, send message,
    interrupt, per-session SSE events). Session events also mirror onto the main
    `/api/v1/events` stream as `type: "session_event"`.
  - Typed SDK methods on `ApiClient`: `listSessions`, `createSession`,
    `getSession`, `deleteSession`, `sendSessionMessage`, `interruptSession`,
    `streamSessionEvents`.
  - Typed errors with HTTP status translations: `SessionBusyError` → 409,
    `SessionDeleteUnsupportedError` → 501, `UnknownProviderError` /
    `ProviderCapabilityError` → 400.
  - Fixes: permission policy fails closed on reject\_\*, concurrent sendMessage
    rejected with 409, deleteSession actually works (or returns 501), findSession
    cached to avoid spawning unrelated adapter subprocesses, totalTurns normalized
    across providers, per-session event history replay filtered by sessionId.
  - Devin review fixes: JSON-RPC transport now emits `jsonrpc: "2.0"` on every
    request and notification (spec-required; Codex is permissive today but strict
    servers would reject). `SessionManager.createSession` now subscribes to
    adapter events BEFORE calling `adapter.createSession` so events emitted during
    startup aren't dropped. `listSessions` also subscribes to each adapter it
    successfully queries. `decodeBody` moved inside try/catch so invalid POST
    bodies map to HTTP 400. `registerAdapter` unsubscribes + shuts down the old
    instance when replacing. Adapter `start()` uses a `startPromise` mutex so
    concurrent callers don't race the `initialize()` handshake. Host-server
    escapes HTML on its landing page and preserves full query strings on
    proxied URLs.
  - New installable package `spawntree-host-server` (at `packages/host-server/`)
    exposes a `bin` so teams can `npm i -g` or `npx spawntree-host-server` to
    run the federation server without copying source.

- [#25](https://github.com/ziahamza/spawntree/pull/25) [`72a43f6`](https://github.com/ziahamza/spawntree/commit/72a43f6b110ae2f98e541a42f4434afc2cddeffc) Thanks [@ziahamza](https://github.com/ziahamza)! - Pluggable storage providers, typed catalog via Drizzle, and ACP session persistence.

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

## 0.3.1

### Patch Changes

- [#8](https://github.com/ziahamza/spawntree/pull/8)
  [`5fd202b`](https://github.com/ziahamza/spawntree/commit/5fd202b567ab22a3536fabaa4699d4e0a6cc93cc)
  Thanks [@ziahamza](https://github.com/ziahamza)! - Fix spaHandler race
  condition, bundle self-hosted fonts, add frontend tests

## 0.3.0

### Minor Changes

- [#6](https://github.com/ziahamza/spawntree/pull/6)
  [`fd91fd0`](https://github.com/ziahamza/spawntree/commit/fd91fd0de3800f9ed481ee2f43079cbf33ae353d)
  Thanks [@ziahamza](https://github.com/ziahamza)! - Add web admin dashboard
  served by the daemon

  - Web dashboard at `http://localhost:<port>` shows all repos, environments,
    and services
  - SQLite database for persistent repo/clone/worktree tracking across daemon
    restarts
  - Real-time SSE log streaming with service filtering
  - Start, stop, and restart environments from the browser
  - Add local folders with automatic git remote detection (GitHub, GitLab,
    Bitbucket)
  - Infrastructure status page for Postgres and Redis
  - Mobile-responsive layout with hamburger drawer sidebar
  - chi router migration from manual switch/case routing
  - `--tags noui` build flag for API-only daemon builds

## 0.2.1

### Patch Changes

- Fix workspace:\* dependencies not being resolved during npm publish.

## 0.2.0

### Minor Changes

- [#1](https://github.com/ziahamza/spawntree/pull/1)
  [`523af9c`](https://github.com/ziahamza/spawntree/commit/523af9c067ff037dec35df5db6f8c713cd67adc7)
  Thanks [@ziahamza](https://github.com/ziahamza)! - Initial release of
  spawntree v0.1.0.

  Orchestrate isolated development environments with native processes,
  per-branch isolation via git worktrees, and automatic port allocation.

  CLI commands: `up`, `down`, `status`, `logs`, `rm`, `init`.
