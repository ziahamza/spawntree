# Changelog

All notable changes to spawntree will be documented in this file.

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
