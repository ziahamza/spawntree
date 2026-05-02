# spawntree-daemon

## 0.5.1

### Patch Changes

- [#42](https://github.com/ziahamza/spawntree/pull/42) [`10840f1`](https://github.com/ziahamza/spawntree/commit/10840f1cf26c6a5b3f36d4879cd271b5387ee379) Thanks [@ziahamza](https://github.com/ziahamza)! - Wire CORS + PNA into `/api/v1/storage` routes so public Studio can read
  the daemon's storage status.

  The route group was the only browser-facing daemon API without CORS
  middleware. As a result, a Studio at `https://gitenv.dev` (or any other
  allow-listed cross-origin) would fail the preflight (or, on a non-OPTIONS
  GET, get a response with no `Access-Control-Allow-Origin` header — also
  a browser-side CORS failure). The status surface added in [#38](https://github.com/ziahamza/spawntree/issues/38) was
  effectively unreachable from real production browsers.

  Fix: apply the same per-route CORS module the catalog and sessions
  routes already use (`packages/daemon/src/lib/cors.ts`, with the
  gitenv.dev allow-list, PNA preflight echo, and `SPAWNTREE_*_TRUST_REMOTE`
  escape hatch). Allowed methods extended to include `PUT` because the
  storage admin surface uses it for `PUT /primary` — the catalog/sessions
  default doesn't.

  `requireLocalOrigin` IP check stays in place on the write surface
  (PUT/POST/DELETE), so CORS only opens the door for `GET /` reads from
  a browser. Mutations from non-loopback peers continue to return 403
  `STORAGE_REMOTE_DENIED`.

- Updated dependencies [[`896bd8e`](https://github.com/ziahamza/spawntree/commit/896bd8e5d4ba0d385766c65e1b3482f68f09eed7)]:
  - spawntree-core@0.7.0

## 0.5.0

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

### Patch Changes

- Updated dependencies [[`b3b4412`](https://github.com/ziahamza/spawntree/commit/b3b44126aee347b91cb3173fa248dd167d69342f)]:
  - spawntree-core@0.6.0

## 0.4.0

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

### Patch Changes

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

- [#37](https://github.com/ziahamza/spawntree/pull/37) [`c94e6f9`](https://github.com/ziahamza/spawntree/commit/c94e6f974509025e6b9281563283b178a3d94863) Thanks [@ziahamza](https://github.com/ziahamza)! - Close two SQL classifier bypasses on `/api/v1/catalog/query-readonly` that
  became remotely exploitable when the loopback gate was lifted from that
  route in [#33](https://github.com/ziahamza/spawntree/issues/33).

  1. **Writable CTE bypass**: `WITH d AS (SELECT 1) INSERT INTO repos(...) VALUES(...)`
     is a single statement starting with `WITH` but performing a write — the
     classifier accepted it. Now: when first keyword is `WITH`, scan the body
     for `INSERT/UPDATE/DELETE/REPLACE/MERGE/UPSERT` as whole words outside
     strings + comments. Reject with `READONLY_QUERY_REJECTED`. Pure-read CTEs
     continue to pass.

  2. **PRAGMA classifier — switched from denylist to fail-closed allow-list**.
     The previous deny-list let writes slip through for any pragma not
     explicitly listed (e.g. `PRAGMA cache_size = 0`). A first-pass fix
     universally rejected the `=` form, but Devin's follow-on review caught
     that for stateful pragmas the function-call form is also a write —
     `PRAGMA cache_size(0)` is equivalent to `PRAGMA cache_size = 0` and
     was still reachable. The shipped fix is a strict allow-list:

     - `ALLOWED_PRAGMAS: Map<name, "bare" | "function" | "both">` enumerates
       every read-safe pragma along with the form(s) it's allowed in.
     - Pragmas not on the map → rejected.
     - `=` form → always rejected (no map entry can override).
     - `(arg)` form → only allowed for `"function"` / `"both"` entries
       (introspection pragmas like `table_info`, `index_list`, etc.).
     - bare form → only allowed for `"bare"` / `"both"` entries.

     Future SQLite pragmas are blocked by default until reviewed and added
     to the allow-list. No more "we missed one in the deny list" follow-ups.

  Caught by Devin Review on PRs [#34](https://github.com/ziahamza/spawntree/issues/34) and [#36](https://github.com/ziahamza/spawntree/issues/36).

- Updated dependencies [[`c94e6f9`](https://github.com/ziahamza/spawntree/commit/c94e6f974509025e6b9281563283b178a3d94863)]:
  - spawntree-core@0.5.0

## 0.3.0

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

### Patch Changes

- Updated dependencies [[`fb288c0`](https://github.com/ziahamza/spawntree/commit/fb288c0ebc077407d64efbce923b4cf42dc9ccb5), [`72a43f6`](https://github.com/ziahamza/spawntree/commit/72a43f6b110ae2f98e541a42f4434afc2cddeffc)]:
  - spawntree-core@0.4.0

## 0.2.1

### Patch Changes

- [#8](https://github.com/ziahamza/spawntree/pull/8)
  [`5fd202b`](https://github.com/ziahamza/spawntree/commit/5fd202b567ab22a3536fabaa4699d4e0a6cc93cc)
  Thanks [@ziahamza](https://github.com/ziahamza)! - Fix spaHandler race
  condition, bundle self-hosted fonts, add frontend tests

## 0.2.0

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

## 0.1.2

### Patch Changes

- Fix workspace:\* dependencies not being resolved during npm publish.

- Updated dependencies []:
  - spawntree-core@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies
  [[`523af9c`](https://github.com/ziahamza/spawntree/commit/523af9c067ff037dec35df5db6f8c713cd67adc7)]:
  - spawntree-core@0.2.0
