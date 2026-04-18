# spawntree

Isolated environment orchestrator. Native processes + shared Postgres/Redis +
Docker containers + per-branch isolation. One command to start everything.

```bash
spawntree up        # start your stack
spawntree status    # see what's running
spawntree down      # stop everything
```

## What it does

- **Hybrid orchestration** — native processes alongside Docker containers in one
  config
- **Shared Postgres** — one Docker instance with pgvector + pg_cron + postgis,
  reused across all your projects. Each environment gets its own database.
- **Shared Redis** — same pattern. Per-env DB index isolation.
- **Branch-aware** — current git branch = your environment. Switch branches,
  switch environments.
- **Port isolation** — automatic, no conflicts. Supports multiple projects
  simultaneously.
- **Clean URLs** — `api-main.localhost:13655` via built-in reverse proxy
- **Framework-aware** — auto-injects `--port` for vite, next.js, astro, nuxt
- **portless compatible** — injects `PORTLESS=0` to disable portless cleanly
  when embedded in dev scripts
- **Drive AI coding agents** — first-class session API for Claude Code and Codex
  via a normalized ACP adapter layer. One SSE stream for turns, tool calls, and
  message deltas. ([docs](./docs/sessions.md))
- **Single Node daemon** — one background server manages orchestration, state,
  the web API, and real-time updates.
- **Shared typed contract** — CLI and web talk through the same `spawntree-core`
  client surface.

## Architecture

- `packages/daemon` runs the single Node.js control plane (envs, infra,
  sessions, SSE event bus)
- `packages/core` exposes the shared typed client, schemas, and the `ACPAdapter`
  layer for driving coding agents
- `packages/cli` is a thin client that auto-starts the daemon
- `packages/web` is the browser client and listens for daemon events over SSE

## Install

```bash
npm i -g spawntree
```

## Quick start

```bash
spawntree init                  # generate config
spawntree up                    # start everything
```

## Config

```yaml
# spawntree.yaml
services:
  db:
    type: postgres              # shared Docker PG with pgvector+pg_cron+postgis
    fork_from: ${PROD_DB_URL}   # optional: seed from production

  cache:
    type: redis                 # shared Docker Redis, per-env isolation

  api:
    type: process
    command: node src/server.js
    port: 3000
    depends_on: [db, cache]
    healthcheck:
      url: http://localhost:${PORT}/health

  worker:
    type: process
    command: python src/worker.py
    depends_on: [api]
    environment:
      API_URL: ${API_URL}       # auto-injected by spawntree

  mailpit:
    type: container             # arbitrary Docker containers
    image: axllent/mailpit
    port: 8025
```

## Service types

| Type        | What it does                                                              |
| ----------- | ------------------------------------------------------------------------- |
| `process`   | Native process via `child_process.spawn`. Framework-aware port injection. |
| `postgres`  | Shared Docker Postgres with extension superset. Per-env database.         |
| `redis`     | Shared Docker Redis. Per-env DB index.                                    |
| `container` | Any Docker image. Port mapping, volumes, env injection.                   |

## Auto-injected environment variables

| Variable         | Source                                                         |
| ---------------- | -------------------------------------------------------------- |
| `PORT`           | Allocated physical port                                        |
| `HOST`           | Always `127.0.0.1`                                             |
| `DATABASE_URL`   | From shared Postgres (or external if provided)                 |
| `REDIS_URL`      | From shared Redis (or external if provided)                    |
| `<SERVICE>_URL`  | Proxy URL for each service (`http://api-main.localhost:13655`) |
| `<SERVICE>_HOST` | `127.0.0.1`                                                    |
| `<SERVICE>_PORT` | Allocated port                                                 |
| `PORTLESS`       | Set to `0` (disables portless)                                 |

## Multiple projects simultaneously

```bash
cd ~/repos/project-a && spawntree up &
cd ~/repos/project-b && spawntree up &
cd ~/repos/project-c && spawntree up &
# All running, separate ports, shared Postgres/Redis, one daemon
```

## Infrastructure management

```bash
spawntree infra status     # see shared Postgres + Redis containers
spawntree infra stop       # stop shared infrastructure
spawntree db dump mydata   # snapshot current database
spawntree db restore mydata
```

## Requirements

- Node.js >= 20
- Git
- Docker (for postgres, redis, container services)

## Documentation

- [Getting Started](./docs/getting-started.md)
- [Configuration](./docs/configuration.md)
- [Environment Variables](./docs/environment-variables.md)
- [CLI Reference](./docs/cli-reference.md)
- [Agent Sessions](./docs/sessions.md) — driving Claude Code / Codex through the
  daemon
- [Federation host](./packages/host/README.md) — published as
  `spawntree-host`, lets one dashboard drive multiple daemons
- [Examples](./examples/)
- [Roadmap](./ROADMAP.md)

## License

MIT
