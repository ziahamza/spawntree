# spawntree

Isolated environment orchestrator. Think docker-compose, but with native processes, built-in databases, and per-branch environment isolation.

```bash
spawntree up        # start your stack
spawntree status    # see what's running
spawntree down      # stop everything
```

## What it does

- **Hybrid orchestration** - run native processes alongside Docker containers in one config
- **Branch-aware** - current git branch = your environment. Switch branches, switch environments
- **Port isolation** - automatic port allocation per environment. No conflicts
- **Built-in databases** - native Postgres (PGlite) and Redis, no Docker needed (v0.1.1)
- **Clean URLs** - `api-main.localhost:8080` instead of `localhost:3847` (v0.1.1)
- **`.env` support** - load environment variables with per-env overrides

## Install

```bash
npm i -g @spawntree/cli
```

Or download a binary from [GitHub Releases](https://github.com/spawntree/spawntree/releases).

## Quick start

```bash
# Generate a config from your existing setup
spawntree init --from-compose   # from docker-compose.yml
spawntree init --from-package   # from package.json scripts
spawntree init                  # blank template

# Start your environment
spawntree up

# In another terminal
spawntree status
spawntree logs api
```

## Config

Create a `spawntree.yaml` in your project root:

```yaml
services:
  api:
    type: process
    command: node src/server.js
    port: 3000
    healthcheck:
      url: http://localhost:${PORT}/health
      timeout: 30

  worker:
    type: process
    command: python src/worker.py
    depends_on:
      - api
```

### Service types

| Type | Description | Status |
|------|-------------|--------|
| `process` | Native process via `child_process.spawn` | v0.1.0 |
| `postgres` | Built-in Postgres via PGlite | v0.1.1 |
| `redis` | Built-in Redis via redjs | v0.1.1 |
| `container` | Docker container via dockerode | v0.1.1 |

### Environment variables

spawntree auto-injects these env vars for each service:

- `PORT` - allocated physical port
- `ENV_NAME` - environment name (branch name)
- `STATE_DIR` - persistent state directory
- `<SERVICE>_HOST`, `<SERVICE>_PORT`, `<SERVICE>_URL` - service discovery
- `DATABASE_URL` - for postgres services
- `REDIS_URL` - for redis services

### `.env` files

spawntree loads `.env` files automatically:

1. `.env` - base defaults
2. `.env.local` - local overrides (gitignored)
3. `.env.<env-name>` - per-environment overrides
4. `--env KEY=VALUE` - CLI overrides
5. Shell environment variables

Use `${VAR_NAME}` in `spawntree.yaml` to reference env vars.

## Commands

```
spawntree up [--prefix <name>]     Start the environment (foreground)
spawntree down [env-name]          Stop the environment
spawntree status [--all]           Show environment status
spawntree logs [service]           Tail service logs
spawntree rm <env-name>            Remove environment (full teardown)
spawntree init                     Generate spawntree.yaml
```

## Multiple environments

By default, spawntree runs one environment per branch. Use `--prefix` for additional environments:

```bash
spawntree up                    # env: main
spawntree up --prefix agent-1   # env: main-agent-1
spawntree up --prefix agent-2   # env: main-agent-2
```

## Requirements

- Node.js >= 20
- Git (for worktree isolation)
- Docker (only for `type: container` services)

## License

MIT
