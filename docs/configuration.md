# Configuration Reference

## File Location

spawntree looks for `spawntree.yaml` in the current directory. Override with `--config-file`:

```bash
spawntree up --config-file infra/spawntree.yaml
```

## Top-Level Fields

```yaml
proxy:          # (v0.1.1) reverse proxy settings
  port: 8080

services:       # required: map of service definitions
  my-service:
    ...
```

## Service Types

### process

Run a native command. The primary service type.

```yaml
services:
  api:
    type: process
    command: node src/server.js      # required
    port: 3000                       # logical port (spawntree allocates the physical port)
    toolchain:                       # (v0.1.1) mise-managed toolchains
      node: "22"
    healthcheck:
      url: http://localhost:${PORT}/health
      timeout: 30                    # seconds
    depends_on:
      - db
    environment:
      API_KEY: ${API_KEY}
```

### postgres (v0.1.1)

Built-in Postgres. No Docker needed.

```yaml
services:
  db:
    type: postgres
    fork_from: ${PROD_DATABASE_URL}  # optional: seed from another database
```

Injects: `DATABASE_URL`, `DB_HOST`, `DB_PORT`, `DB_NAME`

### redis (v0.1.1)

Built-in Redis. No Docker needed.

```yaml
services:
  cache:
    type: redis
```

Injects: `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`

### container (v0.1.1)

Docker container for anything else.

```yaml
services:
  legacy:
    type: container
    image: elasticsearch:8.12
    port: 9200
```

## depends_on

Services start in dependency order. If a dependency fails, dependents are skipped.

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

Start order: db, then api, then worker.

## Variable Substitution

Use `${VAR_NAME}` in these fields: `command`, `healthcheck.url`, `environment` values, `fork_from`.

Variables are resolved from `.env` files and CLI args. See [Environment Variables](./environment-variables.md).

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
    port: 3000
  worker:
    <<: *defaults
    command: node worker.js
```
