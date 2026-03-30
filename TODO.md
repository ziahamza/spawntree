# TODO

## v0.1.1 — Must-have for onboarding project-alpha, project-beta, project-gamma

### Shared Global Postgres

- [ ] Custom Docker image with extension superset: pgvector, pg_cron, uuid-ossp, pg_trgm, postgis. Build and cache at `~/.spawntree/postgres/images/`
- [ ] `~/.spawntree/postgres/<version>/data/` for persistent data across all repos
- [ ] Auto-start on first `spawntree up` that declares `type: postgres`, keep running after `spawntree down`
- [ ] `spawntree infra stop` / `spawntree infra status` to manage the shared instances
- [ ] Multi-database: parse config for multiple `type: postgres` entries, create separate databases (e.g., `sasha` + `sasha_dbos` for project-alpha)
- [ ] `DATABASE_URL` injection with per-service database name
- [ ] `fork_from: <url>` — pg_dump from external source into local database on first run
- [ ] `fork_from: template:<name>` — restore from a saved template snapshot
- [ ] `spawntree db dump <name>` / `spawntree db restore <name>` — save/restore database snapshots to `~/.spawntree/postgres/templates/`
- [ ] Graceful handling when Docker is not installed (clear error, suggest install)
- [ ] Graceful handling when `DATABASE_URL` is provided in env (skip Docker, connect directly)

### Shared Global Redis

- [ ] Start shared Redis container at `~/.spawntree/redis/`
- [ ] Per-env database index allocation (Redis supports DB 0-15 by default, extend with `--databases 512`)
- [ ] `REDIS_URL` injection with per-env DB index
- [ ] Graceful handling when `REDIS_URL` is provided in env (skip Docker, connect directly)

### Container Runner

- [ ] `type: container` with `image`, `port`, `environment`, `volumes`, `command` support via dockerode
- [ ] Port mapping to spawntree-allocated ports
- [ ] Healthcheck support for containers
- [ ] Needed for: Mailpit (project-alpha), Equanimity Docker (project-beta), PowerSync (project-gamma)

### Reverse Proxy

- [ ] Node.js HTTP server listening on configurable port
- [ ] Route `<service>-<env>.localhost:<port>` to correct physical port
- [ ] Startup check for `*.localhost` DNS resolution
- [ ] Inject `SERVICE_URL` with clean `*.localhost` URLs instead of raw `localhost:<port>`
- [ ] Solves portless replacement for project-beta/project-gamma
- [ ] Solves circular dependency (host needs studio URL, studio needs host URL)

### Mise Integration

- [ ] Detect `.mise.toml` / `mise.toml` in project root
- [ ] Run `mise install` before starting any services
- [ ] Activate mise-managed toolchains for `type: process` services
- [ ] Critical for: project-alpha (uv, bun, node), project-beta (node, bun, deno, erlang, elixir), project-gamma (bun, node)

### Real Project Examples

- [ ] `examples/project-alpha/spawntree.yaml` — Django + Vite + Postgres(pgvector) + Redis + Mailpit
- [ ] `examples/project-beta/spawntree.yaml` — Gateway + Studio + Amazon + GitEnv + Equanimity + Postgres + Redis
- [ ] `examples/project-gamma/spawntree.yaml` — Host (dev-local) + Machine + Studio
- [ ] E2E test script that starts each example and verifies healthchecks

## v0.1.0 polish (can be done in parallel)

- [ ] `spawntree up` should print a table with service name, port, status columns
- [ ] `spawntree status` should detect dead processes via PID check
- [ ] `spawntree logs -f` follow mode with `fs.watch`
- [ ] `spawntree init` should detect common stacks (Next.js, Django, Rails) and generate smarter defaults
- [ ] `--verbose` and `--quiet` flags
- [ ] `--timeout` flag for healthcheck wait override
- [ ] Validate ports are free before starting (EADDRINUSE pre-check)
- [ ] Shell completions (bash, zsh, fish)

## Error messages

- [ ] When a process exits immediately, show last 10 lines of its log
- [ ] When port allocation fails, suggest `spawntree status --all`
- [ ] When Docker is not running, print clear install/start instructions
- [ ] When git worktree fails on detached HEAD, suggest `git checkout <branch>`
- [ ] `spawntree up` in non-git directory should suggest `git init`

## Testing

- [ ] E2E test: compiled CLI against sample project with 2 process services
- [ ] Test `.env` resolution order
- [ ] Test branch names with special characters
- [ ] Test concurrent `spawntree up` (lock file contention)
- [ ] Test Ctrl+C handling (SIGINT cleanup)
- [ ] Test `spawntree rm` full cleanup
- [ ] Integration tests for Docker Postgres lifecycle
- [ ] Integration tests for Docker Redis lifecycle
- [ ] Integration tests for container runner
- [ ] Integration tests for reverse proxy routing

## Documentation

- [ ] Update docs/configuration.md with `type: postgres`, `type: redis`, `type: container` reference
- [ ] Document shared global infrastructure model (`~/.spawntree/postgres/`, `~/.spawntree/redis/`)
- [ ] Document `fork_from` and database templates
- [ ] Add `spawntree infra` commands to CLI reference
- [ ] Add `spawntree db` commands to CLI reference
- [ ] CONTRIBUTING.md with dev setup
- [ ] Architecture diagram (ASCII) in README
- [ ] examples/ directory with real project configs (project-alpha, project-beta, project-gamma)

## Future (not blocking v0.1.1)

- [ ] Secret provider integration (1Password `op://`, Wrangler, Vercel, Aptible)
- [ ] DB version management (separate instances per major PG version)
- [ ] `spawntree doctor` command (check prerequisites)
- [ ] Colored output for service status
- [ ] `--dry-run` flag
- [ ] Windows support
- [ ] Homebrew tap
- [ ] Plugin system for custom service types
