# Roadmap

## v0.1.0 — Orchestration Core (done)

Ship the lifecycle model: start, stop, crash recovery, signal handling.

- [x] pnpm workspace monorepo (packages/core, packages/cli, packages/cloud placeholder)
- [x] Config parser (spawntree.yaml, YAML anchors, schema validation, cycle detection)
- [x] .env loader (resolution order, per-env isolation, missing var errors)
- [x] ProcessRunner (child_process.spawn, signal forwarding, HTTP/TCP healthchecks)
- [x] WorktreeManager (git worktree isolation, .gitignore setup)
- [x] PortAllocator (file-locked first-fit-free-slot, stale PID cleanup)
- [x] StateManager (crash recovery, orphan process detection)
- [x] Orchestrator (dependency-order start/stop)
- [x] CLI: up, down, status, logs, rm, init
- [x] Branch-aware by default (current branch = env name)
- [x] `spawntree init --from-compose` and `--from-package`
- [x] CI pipeline (GitHub Actions, Node 20+22, Ubuntu+macOS)
- [x] Changesets for automated npm publishing

## v0.1.1 — Shared Infrastructure + Real Projects

The goal: onboard project-alpha, project-beta, and project-gamma. Every feature here is driven by what those projects actually need.

### Shared Global Postgres

One Postgres instance shared across ALL spawntree repos on the machine. Per-env isolation via separate databases within it.

- [ ] **`type: postgres`**: declares a Postgres dependency. spawntree manages the lifecycle.
- [ ] **Resolution order**: use `DATABASE_URL` from env (external hosted PG) > start a shared Docker Postgres container (global, `~/.spawntree/postgres/`)
- [ ] **Shared global instance**: one Docker Postgres per major version, reused across all repos. Data lives at `~/.spawntree/postgres/<version>/data/`. Started on first `spawntree up` that needs it, kept running.
- [ ] **Extension superset**: always install pgvector, pg_cron, uuid-ossp, postgis, pg_trgm, and any other commonly needed extensions. Custom Docker image: `FROM postgres:<version>` + all extensions. No per-project extension config needed.
- [ ] **Multi-database**: each env gets its own database within the shared instance (e.g., `spawntree_<repo>_<env>`). Multiple `type: postgres` entries in one config create multiple databases.
- [ ] **`DATABASE_URL` injection**: auto-injected per service, per database.
- [ ] **Database templates**: keep pg_dump snapshots in `~/.spawntree/postgres/templates/` for fast spinup. `fork_from: <DATABASE_URL>` seeds from external source. `fork_from: template:<name>` seeds from a saved template.
- [ ] **Offline fallback**: if no internet and no external `DATABASE_URL`, use cached Docker image.

### Shared Global Redis

Same pattern as Postgres.

- [ ] **`type: redis`**: declares a Redis dependency. spawntree manages the lifecycle.
- [ ] **Resolution order**: use `REDIS_URL` from env > start a shared Docker Redis container (global, `~/.spawntree/redis/`)
- [ ] **Per-env isolation**: each env gets its own Redis database index (0-15) or keyspace prefix within the shared instance.
- [ ] **`REDIS_URL` injection**: auto-injected per service.

### Docker Containers

- [ ] **`type: container`**: run arbitrary Docker containers via dockerode. For services that aren't Postgres/Redis (e.g., Mailpit, Elasticsearch, PowerSync).
- [ ] **Port mapping, volume mounts, environment injection**.

### Reverse Proxy

- [ ] **`*.localhost` routing**: Node.js HTTP server, `<service>-<env>.localhost:<port>`. Replaces portless for projects that use it.
- [ ] **Startup DNS check**: verify `*.localhost` resolution, print instructions if it fails (musl Linux).
- [ ] **Solves circular service discovery**: stable URLs like `host.localhost` and `studio.localhost` eliminate the "service A needs service B's URL but B isn't started yet" problem.

### Toolchain + Environment

- [ ] **Mise integration**: run `mise install` and activate toolchains before starting `process` services. Critical for multi-runtime monorepos (project-beta: node + bun + deno + erlang + elixir).
- [ ] **`cwd` per service**: already works (v0.1.0 fix), but document and test with monorepo layouts.

### Other

- [ ] **GlobalRegistry**: `~/.spawntree/registry.json`, `spawntree status --global` across repos
- [ ] **`--detach` mode**: daemon with PID file, parent waits for healthchecks before returning
- [ ] **E2E tests against all 3 target projects**: project-alpha, project-beta, project-gamma example configs in `examples/`
- [ ] **Integration tests**: Docker Postgres lifecycle, Redis lifecycle, container runner, proxy routing

## v0.2 — Polish + Tunnels

- [ ] **Tunnel support**: `spawntree up --tunnel` via cloudflared, internet-accessible URLs
- [ ] **`spawntree migrate`**: convert docker-compose.yml to spawntree.yaml (smarter than `init --from-compose`)
- [ ] **DB version management**: if two projects need different Postgres versions, spin up separate instances per major version
- [ ] **Concurrency limits**: configurable max environments, resource monitoring
- [ ] **Snapshot/restore**: save and restore full environment state (pg_dump + state dir)

## v0.3 — Cloud Platform

Per-PR and per-agent-session environments, hosted.

- [ ] **packages/cloud**: Cloudflare Workers runtime for remote environment management
- [ ] **Per-PR environments**: GitHub webhook triggers environment creation on PR open, teardown on close
- [ ] **Per-agent environments**: API for AI coding agents to create/destroy isolated environments
- [ ] **Environment sync**: keep environments in sync across branches
- [ ] **Dashboard**: web UI for managing environments across repos

## Future

- [ ] **Secret provider integration**: 1Password (`op://`), Cloudflare Wrangler, Vercel, Aptible. Load env vars from external secret managers.
- [ ] Windows support
- [ ] Homebrew tap (`brew install spawntree`)
- [ ] Prebuilt binaries via GitHub Releases (bun build --compile)
- [ ] Plugin system for custom service types
- [ ] Shared immutable caches across environments (node_modules, pip packages)
- [ ] WebSocket passthrough in reverse proxy
- [ ] Hot reload: detect file changes and restart affected services
- [ ] `spawntree exec <env> <command>`: run a command inside an environment's context

## Target Projects

These three projects must work with spawntree before v0.1.1 ships:

| Project | Stack | Key needs |
|---------|-------|-----------|
| **project-alpha** | Django + Expo, Postgres w/ pgvector, Redis, Mailpit | Shared PG w/ pgvector, Redis, `type: container` for Mailpit, Mise (uv, bun) |
| **project-beta** | 5-runtime monorepo (Node, Bun, Deno, Elixir, CF Workers), Postgres w/ pg_cron + pgvector, Redis, portless | Shared PG w/ extensions, Redis, reverse proxy (replaces portless), Mise (5 runtimes), `type: container` for Equanimity |
| **project-gamma** | Hono/CF Workers, Bun, Vite, Postgres (Supabase/PGlite), SQLite, PowerSync | Shared PG (replaces PGlite dev path), reverse proxy (replaces portless), Mise, `type: container` for PowerSync E2E |

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Shared global Postgres | One Docker PG instance reused across all repos. Per-env isolation via databases. Avoids starting N Postgres containers. |
| Extension superset | Always install pgvector, pg_cron, uuid-ossp, etc. No per-project extension config. If a project needs it, it's already there. |
| No PGlite | Too experimental. Doesn't support extensions. Real projects need real Postgres. |
| Docker for PG/Redis only as fallback | Prefer external `DATABASE_URL` / `REDIS_URL`. Docker is the offline/no-config fallback. |
| Database templates | pg_dump snapshots for fast env spinup. Stored globally in `~/.spawntree/postgres/templates/`. |
| No fork command | None of the target projects need it. Removed from roadmap. |
| Env vars: user-provided | Users bring their own .env files or have vars in shell. Secret provider integration (1Password, etc.) is future work. |
| Vanilla Node.js APIs only | Cloudflare Workers compatibility for cloud version |
| `*.localhost` for clean URLs | RFC 6761, no external DNS deps, replaces portless |
| Branch = environment name | One env by default, `--prefix` for multiples |
| File-locked port allocation | Prevents race conditions on concurrent `spawntree up` |
| Foreground by default | Like docker compose. `--detach` is opt-in. |
| pnpm workspace monorepo | core/cli/cloud split for future Workers version |
