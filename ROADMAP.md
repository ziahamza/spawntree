# Roadmap

## v0.1.0 — Orchestration Core + Daemon Architecture (done)

- [x] Daemon architecture: background process on Unix socket, Hono HTTP API
- [x] CLI as thin HTTP client (auto-starts daemon, undici Unix socket fetch)
- [x] 15-endpoint typed API contract (shared between daemon and future cloud)
- [x] ProcessRunner with shell mode, framework port injection (vite, next, astro, nuxt)
- [x] Config parser (spawntree.yaml, YAML anchors, schema validation, cycle detection)
- [x] .env loader (resolution order, per-env isolation, missing var errors)
- [x] Branch-aware by default (current branch = env name, `--prefix` for multiples)
- [x] `PORTLESS=0` injection (disables portless when embedded in service scripts)
- [x] Shared global Postgres (Docker, extension superset: pgvector, pg_cron, postgis)
- [x] Shared global Redis (Docker, per-env DB index, --databases 512)
- [x] Docker container runner (`type: container` via dockerode)
- [x] Reverse proxy (own HTTP proxy, WebSocket support, `*.localhost` routing)
- [x] Per-service env var injection (PORT, HOST_URL, DATABASE_URL, REDIS_URL)
- [x] Multi-database support (per-service-name env vars: `DBOS_DB_DATABASE_URL`)
- [x] `fork_from` for database seeding from external URLs
- [x] Database templates (`spawntree db dump/restore`)
- [x] `spawntree init --from-compose` and `--from-package`
- [x] CLI: up, down, status, logs, rm, init, infra status/stop, db dump/restore
- [x] CI pipeline (GitHub Actions, Node 20+22, Ubuntu+macOS)
- [x] Changesets for automated npm publishing
- [x] Tested E2E: 3 real projects running simultaneously (6 services, 1 daemon)

## v0.2 — Polish + Production Readiness

- [ ] **Mise integration**: `mise install` before starting services. Auto-detect `.mise.toml`.
- [ ] **`--detach` mode**: run in background, `spawntree up -d`
- [ ] **`spawntree logs -f`**: live follow mode via SSE streaming
- [ ] **Port-binding verification**: check process actually bound to allocated port
- [ ] **Colored status output**: green=running, red=failed, gray=stopped
- [ ] **`spawntree doctor`**: check prerequisites (Docker, git, node, mise)
- [ ] **Shell completions**: bash, zsh, fish via commander
- [ ] **Graceful errors**: show last 10 log lines on crash, suggest `spawntree status --all` on port exhaustion
- [ ] **GlobalRegistry**: `~/.spawntree/registry.json`, `spawntree status --global`

## v0.3 — Tunnels + Remote Access

- [ ] **Tunnel support**: `spawntree up --tunnel` via cloudflared, internet-accessible URLs
- [ ] **`spawntree migrate`**: smarter docker-compose.yml converter
- [ ] **DB version management**: separate PG instances per major version
- [ ] **Snapshot/restore**: save and restore full environment state

## v0.4 — Cloud Platform

Per-PR and per-agent-session environments, hosted.

- [ ] **packages/cloud**: Cloudflare Workers implementing same API contract
- [ ] **Per-PR environments**: GitHub webhook → env creation on PR open, teardown on close
- [ ] **Per-agent environments**: API for AI coding agents to create/destroy environments
- [ ] **`spawntree logs --cloud`**: same interface, cloud transport
- [ ] **Dashboard**: web UI for managing environments across repos

## Future

- [ ] Secret provider integration (1Password `op://`, Wrangler, Vercel, Aptible)
- [ ] Windows support
- [ ] Homebrew tap (`brew install spawntree`)
- [ ] Prebuilt binaries via GitHub Releases
- [ ] Plugin system for custom service types
- [ ] Hot reload: detect file changes, restart affected services
- [ ] `spawntree exec <env> <command>`: run a command inside an environment's context

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Daemon + thin CLI | Heavy lifting in background process. Same API for local (Unix socket) and cloud (HTTPS). |
| Shared global Postgres | One Docker PG per version, reused across all repos. Per-env isolation via databases. |
| Extension superset | pgvector, pg_cron, postgis, uuid-ossp baked in. No per-project config. |
| No PGlite | Too experimental. Real projects need real Postgres with extensions. |
| Own proxy (not portless) | Need same proxy for local and cloud. `PORTLESS=0` disables portless cleanly. |
| Framework port injection | Auto-detect vite/next/astro and inject `--port` flags (like portless). |
| Hono for HTTP | Portable between Node.js daemon and future CF Workers cloud. |
| `PORTLESS=0` injection | Prevents port allocation conflicts with embedded portless in dev scripts. |
| Env vars user-provided | Users bring .env files. Secret providers (1Password etc.) are future. |
