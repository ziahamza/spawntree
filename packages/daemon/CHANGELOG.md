# spawntree-daemon

## 0.2.1

### Patch Changes

- [#8](https://github.com/ziahamza/spawntree/pull/8) [`5fd202b`](https://github.com/ziahamza/spawntree/commit/5fd202b567ab22a3536fabaa4699d4e0a6cc93cc) Thanks [@ziahamza](https://github.com/ziahamza)! - Fix spaHandler race condition, bundle self-hosted fonts, add frontend tests

## 0.2.0

### Minor Changes

- [#6](https://github.com/ziahamza/spawntree/pull/6) [`fd91fd0`](https://github.com/ziahamza/spawntree/commit/fd91fd0de3800f9ed481ee2f43079cbf33ae353d) Thanks [@ziahamza](https://github.com/ziahamza)! - Add web admin dashboard served by the daemon

  - Web dashboard at `http://localhost:<port>` shows all repos, environments, and services
  - SQLite database for persistent repo/clone/worktree tracking across daemon restarts
  - Real-time SSE log streaming with service filtering
  - Start, stop, and restart environments from the browser
  - Add local folders with automatic git remote detection (GitHub, GitLab, Bitbucket)
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

- Updated dependencies [[`523af9c`](https://github.com/ziahamza/spawntree/commit/523af9c067ff037dec35df5db6f8c713cd67adc7)]:
  - spawntree-core@0.2.0
