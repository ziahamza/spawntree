# Getting Started

## Install

```bash
npm i -g spawntree
```

The npm package includes the native Go daemon binary for supported macOS, Linux, and Windows platforms.

Or run directly:

```bash
npx spawntree --help
```

## Prerequisites

- Node.js >= 20
- Git
- Docker (for `type: postgres`, `type: redis`, `type: container` services)

## Quick Start

1. Navigate to your project:

```bash
cd my-project
```

2. Generate a config:

```bash
spawntree init                  # blank template
spawntree init --from-compose   # from docker-compose.yml
spawntree init --from-package   # from package.json scripts
```

3. Start your environment:

```bash
spawntree up
```

A background native daemon starts automatically. Services start in dependency order. Ctrl+C to stop.

4. Check what's running:

```bash
spawntree status
```

## How It Works

spawntree runs a native Go daemon that manages all infrastructure:

```
spawntree up → daemon starts (if not running) → services start → logs stream
                   │
                   ├── Shared Postgres (Docker, one instance for all repos)
                   ├── Shared Redis (Docker, per-env DB index)
                   ├── Process services (native, with port injection)
                   ├── Container services (Docker, arbitrary images)
                   ├── Reverse proxy (*.localhost URLs on :13655)
                   └── Generated OpenAPI API (Unix socket + loopback HTTP)
```

- **Shared infrastructure**: Postgres and Redis run as shared Docker containers reused across all your projects. Each environment gets its own database/keyspace.
- **Port isolation**: spawntree allocates non-conflicting ports automatically. No more port conflicts between projects.
- **Service discovery**: environment variables like `HOST_URL`, `DATABASE_URL`, `REDIS_URL` are injected automatically.
- **Framework-aware**: vite, next.js, astro, and nuxt get `--port` flags injected automatically (they ignore the PORT env var).
- **portless coexistence**: spawntree injects `PORTLESS=0` so embedded portless in dev scripts is bypassed cleanly.

## Example

```yaml
# spawntree.yaml
services:
  db:
    type: postgres

  cache:
    type: redis

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
      API_URL: ${API_URL}
```

```bash
spawntree up
# → Postgres starts (shared Docker, pgvector+pg_cron+postgis)
# → Redis starts (shared Docker, per-env DB index)
# → api starts on allocated port, healthcheck passes
# → worker starts, API_URL auto-injected
# → All services accessible via *.localhost proxy URLs
```

## Next Steps

- [Configuration Reference](./configuration.md)
- [Daemon Architecture](./daemon-architecture.md)
- [Environment Variables](./environment-variables.md)
- [CLI Reference](./cli-reference.md)
- [Examples](../examples/)
