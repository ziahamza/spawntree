# Configuration Reference

## File Location

spawntree looks for `spawntree.yaml` in the current directory. Override with
`--config-file`:

```bash
spawntree up --config-file infra/spawntree.yaml
```

## Service Types

### process

Run a native command. The primary service type.

```yaml
services:
  api:
    type: process
    command: node src/server.js
    port: 3000
    healthcheck:
      url: http://localhost:${PORT}/health
      timeout: 30
    depends_on:
      - db
    environment:
      API_KEY: ${API_KEY}
```

**Framework port injection**: spawntree auto-detects vite, next.js, astro, nuxt,
and expo in the command and injects `--port` flags. These frameworks ignore the
`PORT` env var, so spawntree handles it for you.

**portless coexistence**: if your command uses `portless run`, spawntree injects
`PORTLESS=0` to disable portless. spawntree owns port allocation and proxy.

### postgres

Shared global Postgres. No Docker commands needed.

```yaml
services:
  db:
    type: postgres
    fork_from: ${PROD_DATABASE_URL}   # optional: seed from external source

  dbos-db:
    type: postgres                     # second database in same instance
```

- Uses a shared Docker Postgres container with extension superset (pgvector,
  pg_cron, postgis, uuid-ossp, pg_trgm)
- Each service gets its own database within the shared instance
- Injects: `DATABASE_URL`, `DB_HOST`, `DB_PORT`, `DB_NAME`
- Multiple postgres services get per-service vars: `DBOS_DB_DATABASE_URL`,
  `DBOS_DB_HOST`, etc.
- If `DATABASE_URL` is already in your environment, Docker is skipped (use
  external server)

### redis

Shared global Redis. No Docker commands needed.

```yaml
services:
  cache:
    type: redis
```

- Uses a shared Docker Redis container with per-env DB index isolation
- Injects: `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`
- If `REDIS_URL` is already in your environment, Docker is skipped

### container

Run any Docker container.

```yaml
services:
  mailpit:
    type: container
    image: axllent/mailpit:latest
    port: 8025
    environment:
      MP_SMTP_AUTH_ACCEPT_ANY: "1"
    volumes:
      - host: ./data
        container: /data
        mode: rw
```

## depends_on

Services start in dependency order. If a dependency fails, dependents are
skipped.

```yaml
services:
  db:
    type: postgres
  api:
    type: process
    command: node server.js
    depends_on: [db]
  worker:
    type: process
    command: node worker.js
    depends_on: [db, api]
```

Start order: db, then api, then worker. Stop order: worker, api, db.

## Variable Substitution

Use `${VAR_NAME}` in: `command`, `healthcheck.url`, `environment` values,
`fork_from`.

Variables are resolved from `.env` files, CLI args, and spawntree's
auto-injected vars (PORT, HOST_URL, DATABASE_URL, etc.).

## YAML Anchors

Standard YAML anchors work for sharing config:

```yaml
x-defaults: &defaults
  type: process
  healthcheck:
    timeout: 30

services:
  api:
    <<: *defaults
    command: node api.js
  worker:
    <<: *defaults
    command: node worker.js
```
