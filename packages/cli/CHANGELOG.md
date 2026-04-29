# spawntree

## 0.5.0

### Patch Changes

- Updated dependencies [[`c94e6f9`](https://github.com/ziahamza/spawntree/commit/c94e6f974509025e6b9281563283b178a3d94863), [`c94e6f9`](https://github.com/ziahamza/spawntree/commit/c94e6f974509025e6b9281563283b178a3d94863), [`c94e6f9`](https://github.com/ziahamza/spawntree/commit/c94e6f974509025e6b9281563283b178a3d94863)]:
  - spawntree-core@0.5.0
  - spawntree-daemon@0.4.0

## 0.4.0

### Patch Changes

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

- Updated dependencies [[`fb288c0`](https://github.com/ziahamza/spawntree/commit/fb288c0ebc077407d64efbce923b4cf42dc9ccb5), [`72a43f6`](https://github.com/ziahamza/spawntree/commit/72a43f6b110ae2f98e541a42f4434afc2cddeffc)]:
  - spawntree-core@0.4.0
  - spawntree-daemon@0.3.0

## 0.3.1

### Patch Changes

- [#8](https://github.com/ziahamza/spawntree/pull/8)
  [`5fd202b`](https://github.com/ziahamza/spawntree/commit/5fd202b567ab22a3536fabaa4699d4e0a6cc93cc)
  Thanks [@ziahamza](https://github.com/ziahamza)! - Fix spaHandler race
  condition, bundle self-hosted fonts, add frontend tests

- Updated dependencies
  [[`5fd202b`](https://github.com/ziahamza/spawntree/commit/5fd202b567ab22a3536fabaa4699d4e0a6cc93cc)]:
  - spawntree-core@0.3.1
  - spawntree-daemon@0.2.1

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

### Patch Changes

- Updated dependencies
  [[`fd91fd0`](https://github.com/ziahamza/spawntree/commit/fd91fd0de3800f9ed481ee2f43079cbf33ae353d)]:
  - spawntree-core@0.3.0
  - spawntree-daemon@0.2.0

## 0.2.1

### Patch Changes

- Fix workspace:\* dependencies not being resolved during npm publish.

- Updated dependencies []:
  - spawntree-core@0.2.1
  - spawntree-daemon@0.1.2

## 0.2.0

### Minor Changes

- [#1](https://github.com/ziahamza/spawntree/pull/1)
  [`523af9c`](https://github.com/ziahamza/spawntree/commit/523af9c067ff037dec35df5db6f8c713cd67adc7)
  Thanks [@ziahamza](https://github.com/ziahamza)! - Initial release of
  spawntree v0.1.0.

  Orchestrate isolated development environments with native processes,
  per-branch isolation via git worktrees, and automatic port allocation.

  CLI commands: `up`, `down`, `status`, `logs`, `rm`, `init`.

### Patch Changes

- Updated dependencies
  [[`523af9c`](https://github.com/ziahamza/spawntree/commit/523af9c067ff037dec35df5db6f8c713cd67adc7)]:
  - spawntree-core@0.2.0
  - spawntree-daemon@0.1.1
