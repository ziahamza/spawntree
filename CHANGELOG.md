# Changelog

All notable changes to spawntree will be documented in this file.

## [Unreleased]

### Added

- **Agent sessions** — daemon can now drive Claude Code and Codex as first-class
  sessions. New `/api/v1/sessions` HTTP API with listing, creation, messaging,
  interrupt, and per-session SSE event streams. Session events also mirror onto
  the main `/api/v1/events` stream as `type: "session_event"` so a single
  subscriber can watch infra + agents together. See
  [docs/sessions.md](./docs/sessions.md).
- **Normalized ACP adapter layer** (`packages/core/src/acp/`) — one `ACPAdapter`
  interface over Claude Code (via `@zed-industries/claude-code-acp`, native ACP)
  and Codex (via `codex app-server --listen stdio://`, JSON-RPC). Third-party
  providers can be registered via `SessionManager.registerAdapter`.
- **Typed session errors** — `SessionBusyError` (409 Conflict on concurrent
  `sendMessage`), `SessionDeleteUnsupportedError` (501 for providers that don't
  support delete, such as Codex), `UnknownProviderError` (400 on unregistered
  providers), `ProviderCapabilityError` (400 when a capability isn't supported).
- **Typed SDK** — `ApiClient` gained `listSessions`, `createSession`,
  `getSession`, `deleteSession`, `sendSessionMessage`, `interruptSession`, and
  `streamSessionEvents` (async generator over SSE). All responses go through
  Effect Schema validation.
- **`spawntree-host-server`** — new installable package at
  `packages/host-server/` with a `bin` (`spawntree-host-server`). A SQLite-backed registry
  that lets one web dashboard switch between multiple spawntree daemons running
  on different machines.

### Fixed

- **Permission policy fail-closed.** The default ACP client previously fell
  through to `options[0]` when the configured policy didn't match any offered
  option — silently allowing when the user asked to reject. Now prefers any
  option of the same intent and cancels outright when the policy was `reject_*`
  and no reject option exists.
- **Concurrent `sendMessage` race.** Sending a message while a turn was in
  flight would overwrite `activeTurnId` and misattribute inbound session
  updates. Adapters now throw `SessionBusyError` so the caller interrupts first.
- **`deleteSession` no longer lies.** The old implementation was a no-op that
  returned 200 OK. Claude Code sessions are now removed from the in-memory map
  (with any active turn cancelled); Codex sessions return 501 because the
  app-server has no delete RPC.
- **`findSession` no longer spawns unrelated subprocesses.** Added a
  `sessionId→provider` cache populated on `createSession`/`listSessions` so
  routing a known session doesn't trigger every adapter's `discoverSessions()`
  (which booted `codex app-server` as a side effect of Claude Code operations).
  The slow path also skips adapters whose binary isn't installed.
- **`totalTurns` is consistent across providers.** ClaudeCodeAdapter previously
  counted stored message records; Codex counted conversational turns. Both now
  report the number of user messages.
- **Per-session event history replay is filtered by sessionId.** A client
  connecting to `/api/v1/sessions/:id/events` no longer receives up to 64
  buffered events from other sessions before its own stream starts.
- **JSON-RPC 2.0 spec compliance.** `JsonRpcTransport.request()` and `notify()`
  now emit the required `jsonrpc: "2.0"` field on every outgoing message.
  Codex's current app-server is permissive, but strict servers (and future Codex
  versions) would reject the messages.
- **`createSession` no longer drops events emitted during startup.** The manager
  subscribes to the adapter's event stream before calling
  `adapter.createSession()`, so session events fired during handshake (status
  transitions, etc.) reach the domain events bus. `listSessions` also wires up
  the subscription on each adapter it successfully queries.

### Changed

- `SessionProvider` schema widened from
  `Schema.Literals(["claude-code",
  "codex"])` to `Schema.String`. Custom
  providers registered via `SessionManager.registerAdapter` are now accepted by
  the HTTP layer and rejected at dispatch time with a clear `UNKNOWN_PROVIDER`
  error.

## [0.3.0.0] - 2026-04-02

### Added

- Web admin dashboard served by the daemon on the same HTTP port
- See all registered repos, clones, and worktrees in a sidebar tree
- View environment details with service cards showing status, ports, and proxy
  URLs
- Stream logs in real-time from any environment with service filtering
- Start, stop, and restart environments from the browser
- Add local folders to link repos, with automatic git remote detection (GitHub,
  GitLab, Bitbucket)
- Infrastructure status page showing Postgres and Redis container health
- SQLite database for persistent repo/clone/worktree tracking across daemon
  restarts
- Worktree auto-discovery via `POST /api/v1/discover`
- Clone management: relink moved clones or remove deleted ones
- Mobile-responsive layout with hamburger drawer sidebar
- `DESIGN.md` with complete design system (gitenv-inherited almond/cacao dark
  theme)
- Go unit tests for SQLite layer and remote URL parsing (12 tests)
- `--tags noui` build flag for API-only daemon builds without embedded frontend

### Changed

- Migrated HTTP router from manual switch/case to chi (github.com/go-chi/chi/v5)
- Added modernc.org/sqlite dependency for pure-Go SQLite support
- SPA assets embedded in Go binary via `//go:embed` (17MB total binary size)
