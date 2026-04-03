---
"spawntree": minor
"spawntree-core": minor
"spawntree-daemon": minor
---

Add web admin dashboard served by the daemon

- Web dashboard at `http://localhost:<port>` shows all repos, environments, and services
- SQLite database for persistent repo/clone/worktree tracking across daemon restarts
- Real-time SSE log streaming with service filtering
- Start, stop, and restart environments from the browser
- Add local folders with automatic git remote detection (GitHub, GitLab, Bitbucket)
- Infrastructure status page for Postgres and Redis
- Mobile-responsive layout with hamburger drawer sidebar
- chi router migration from manual switch/case routing
- `--tags noui` build flag for API-only daemon builds
