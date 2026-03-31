# Environment Variables

## .env File Resolution

spawntree loads `.env` files in this order (later wins):

| Priority | File | Typical Use |
|----------|------|-------------|
| 1 (lowest) | `.env` | Defaults, committed to repo |
| 2 | `.env.local` | Local overrides, gitignored |
| 3 | `.env.<env-name>` | Per-environment overrides |
| 4 | `--env KEY=VALUE` | CLI overrides |
| 5 (highest) | Shell environment | Already-set variables |

## Auto-Injected Variables

spawntree injects these for every service:

| Variable | Description |
|----------|-------------|
| `PORT` | Allocated physical port for this service |
| `ENV_NAME` | Environment name (branch name or `--prefix` value) |
| `STATE_DIR` | Persistent state directory for this environment |

## Service Discovery

Every service gets variables for every other service:

| Variable | Example |
|----------|---------|
| `<SERVICE>_HOST` | `API_HOST=127.0.0.1` |
| `<SERVICE>_PORT` | `API_PORT=10001` |
| `<SERVICE>_URL` | `API_URL=http://127.0.0.1:10001` |

Postgres and Redis services also inject conventional connection strings:

| Type | Variable | Format |
|------|----------|--------|
| postgres | `DATABASE_URL` | `postgresql://localhost:PORT/spawntree_ENV` |
| redis | `REDIS_URL` | `redis://127.0.0.1:PORT` |

## Missing Variables

If `spawntree.yaml` references a `${VAR}` that isn't defined in any source, spawntree exits with a clear error:

```
Error: Missing required variables:
  PROD_DATABASE_URL — set in .env, .env.local, or pass via --env PROD_DATABASE_URL=...
  API_SECRET — set in .env, .env.local, or pass via --env API_SECRET=...
```

## Example

```bash
# .env (committed)
NODE_ENV=development
API_PORT=3000

# .env.local (gitignored)
API_SECRET=my-local-secret

# .env.feat-auth (per-branch)
API_PORT=3001
```

```yaml
# spawntree.yaml
services:
  api:
    type: process
    command: node server.js
    port: ${API_PORT}
    environment:
      NODE_ENV: ${NODE_ENV}
      API_SECRET: ${API_SECRET}
```

```bash
# Override from CLI
spawntree up --env API_SECRET=override-secret
```
