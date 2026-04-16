# Roadmap

## v0.1.0 — Orchestration Core + Node Daemon (done)

- [x] Single Node.js daemon as the only control plane
- [x] CLI as a thin HTTP client that auto-starts the daemon
- [x] Shared typed contract/client consumed by the CLI and web
- [x] ProcessRunner with shell mode, framework port injection (vite, next,
      astro, nuxt)
- [x] Config parser (spawntree.yaml, YAML anchors, schema validation, cycle
      detection)
- [x] .env loader (resolution order, per-env isolation, missing var errors)
- [x] Branch-aware by default (current branch = env name, `--prefix` for
      multiples)
- [x] `PORTLESS=0` injection (disables portless when embedded in service
      scripts)
- [x] Shared global Postgres (Docker, extension superset: pgvector, pg_cron,
      postgis)
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

- [ ] **Mise integration**: `mise install` before starting services. Auto-detect
      `.mise.toml`.
- [ ] **`--detach` mode**: run in background, `spawntree up -d`
- [ ] **`spawntree logs -f`**: live follow mode via SSE streaming
- [ ] **Port-binding verification**: check process actually bound to allocated
      port
- [ ] **Colored status output**: green=running, red=failed, gray=stopped
- [ ] **`spawntree doctor`**: check prerequisites (Docker, git, node, mise)
- [ ] **Shell completions**: bash, zsh, fish via commander
- [ ] **Graceful errors**: show last 10 log lines on crash, suggest
      `spawntree status --all` on port exhaustion
- [ ] **GlobalRegistry**: `~/.spawntree/registry.json`,
      `spawntree status --global`

## v0.3 — Tunnels + Remote Access

- [ ] **Tunnel support**: `spawntree up --tunnel` via cloudflared,
      internet-accessible URLs
- [ ] **`spawntree migrate`**: smarter docker-compose.yml converter
- [ ] **DB version management**: separate PG instances per major version
- [ ] **Snapshot/restore**: save and restore full environment state

## v0.4 — Agent Sessions (in progress)

First-class AI coding agent orchestration.

- [x] **ACP integration layer**: normalized `ACPAdapter` interface over Claude
      Code (native ACP) and Codex (JSON-RPC app-server facade)
- [x] **Session manager + HTTP API**: `POST/GET/DELETE /api/v1/sessions`,
      per-session SSE stream, typed SDK
- [x] **Typed session errors**: 409 `SESSION_BUSY`, 501 `DELETE_NOT_SUPPORTED`,
      400 `UNKNOWN_PROVIDER` / `PROVIDER_CAPABILITY_MISSING`
- [x] **Custom providers**: `SessionManager.registerAdapter()` takes any
      `ACPAdapter` implementation — HTTP schema accepts arbitrary names
- [x] **Example federation host**: `examples/host-server/` aggregates multiple
      spawntree daemons behind one dashboard
- [ ] **Sessions attached to envs**: `createSession({ envId })` auto-injects
      `DATABASE_URL`/`REDIS_URL`/per-service vars into the agent subprocess
- [ ] **`spawntree session {list,start,send,kill}`**: CLI commands mirroring the
      HTTP surface
- [ ] **Sessions in the web dashboard**: live turn streaming, tool call
      inspector, session launcher per env

## v0.5 — Cloud Platform

Per-PR and per-agent-session environments, hosted.

- [ ] **packages/cloud**: Cloudflare Workers implementing same API contract
- [ ] **Per-PR environments**: GitHub webhook → env creation on PR open,
      teardown on close
- [ ] **`spawntree logs --cloud`**: same interface, cloud transport
- [ ] **Dashboard**: web UI for managing environments across repos

## Future

- [ ] Secret provider integration (1Password `op://`, Wrangler, Vercel, Aptible)
- [ ] Windows support
- [ ] Homebrew tap (`brew install spawntree`)
- [ ] Prebuilt binaries via GitHub Releases
- [ ] Plugin system for custom service types
- [ ] Hot reload: detect file changes, restart affected services
- [ ] `spawntree exec <env> <command>`: run a command inside an environment's
      context

## Design Decisions

| Decision                 | Rationale                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| Daemon + thin CLI        | Heavy lifting in one background Node.js process. CLI and web share the same typed client surface. |
| Shared global Postgres   | One Docker PG per version, reused across all repos. Per-env isolation via databases.              |
| Extension superset       | pgvector, pg_cron, postgis, uuid-ossp baked in. No per-project config.                            |
| No PGlite                | Too experimental. Real projects need real Postgres with extensions.                               |
| Own proxy (not portless) | Need same proxy for local and cloud. `PORTLESS=0` disables portless cleanly.                      |
| Framework port injection | Auto-detect vite/next/astro and inject `--port` flags (like portless).                            |
| Hono for HTTP            | Small, readable HTTP layer over the Effect runtime.                                               |
| `PORTLESS=0` injection   | Prevents port allocation conflicts with embedded portless in dev scripts.                         |
| Env vars user-provided   | Users bring .env files. Secret providers (1Password etc.) are future.                             |
