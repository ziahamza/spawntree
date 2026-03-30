# Roadmap

## v0.1.0 — Orchestration Core (current)

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
- [ ] E2E test with a real sample project

## v0.1.1 — Built-in Databases + Proxy

Add native Postgres, Redis, Docker support, and clean URL routing.

- [ ] **PostgresService**: singleton PGlite via `@electric-sql/pglite-socket`, per-env databases via CREATE DATABASE, `DATABASE_URL` injection
- [ ] **3-tier DB fallback**: connect to existing PG server (if `DATABASE_URL` in .env) > PGlite > Docker container
- [ ] **`fork_from`**: seed a database from another `DATABASE_URL` on first run
- [ ] **RedisService**: `redjs` in-process server, per-env keyspace isolation, `REDIS_URL` injection
- [ ] **3-tier Redis fallback**: existing server > redjs > Docker container
- [ ] **ContainerRunner**: dockerode for `type: container` services
- [ ] **Reverse proxy**: Node.js HTTP server, `<service>-<env>.localhost:<port>` routing, `*.localhost` DNS validation
- [ ] **GlobalRegistry**: `~/.spawntree/registry.json`, `spawntree status --global` across repos
- [ ] **Mise integration**: toolchain bootstrap before starting `process` services
- [ ] **`--detach` mode**: daemon with PID file, parent waits for healthchecks before returning
- [ ] Integration tests for PGlite, Redis, Docker, proxy

## v0.2 — Environment Fabric

Environments as forkable, promotable objects. Internet exposure.

- [ ] **`spawntree fork <source> <new>`**: clone worktree + pg_dump/restore database + copy Redis state
- [ ] **Tunnel support**: `spawntree up --tunnel` via cloudflared subprocess, internet-accessible URLs
- [ ] **`spawntree migrate`**: convert docker-compose.yml to spawntree.yaml
- [ ] **Snapshot/restore**: save and restore full environment state
- [ ] **Concurrency limits**: configurable max environments, resource monitoring

## v0.3 — Cloud Platform

Per-PR and per-agent-session environments, hosted.

- [ ] **packages/cloud**: Cloudflare Workers runtime for remote environment management
- [ ] **Per-PR environments**: GitHub webhook triggers environment creation on PR open, teardown on close
- [ ] **Per-agent environments**: API for AI coding agents to create/destroy isolated environments
- [ ] **Environment sync**: keep environments in sync across branches (state, schema, data)
- [ ] **Dashboard**: web UI for managing environments across repos

## Future

- [ ] Windows support
- [ ] Homebrew tap (`brew install spawntree`)
- [ ] Prebuilt binaries via GitHub Releases (bun build --compile)
- [ ] Plugin system for custom service types
- [ ] Shared immutable caches across environments (node_modules, pip packages)
- [ ] WebSocket passthrough in reverse proxy
- [ ] Hot reload: detect file changes and restart affected services
- [ ] `spawntree exec <env> <command>`: run a command inside an environment's context

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Vanilla Node.js APIs only | Cloudflare Workers compatibility for cloud version |
| Bun for packaging only | `bun build --compile` for single binary distribution |
| No external DNS dependencies | `*.localhost` (RFC 6761) instead of sslip.io |
| Native PG/Redis over Docker | PGlite + redjs eliminate Docker dependency for common databases |
| Branch = environment name | Like portless. One env by default, `--prefix` for multiples |
| File-locked port allocation | Prevents race conditions on concurrent `spawntree up` |
| Foreground by default | Like docker compose. `--detach` is opt-in (v0.1.1) |
| pnpm workspace monorepo | core/cli/cloud split for future Workers version |
| Fixed versioning (changesets) | spawntree + spawntree-core always version together |
