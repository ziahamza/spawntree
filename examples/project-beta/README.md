# Project Beta

5-runtime monorepo: Node.js, Bun, Deno, Elixir, CF Workers.

- **db**: Postgres with pgvector + pg_cron (shared global instance)
- **redis**: Redis for cache/queues
- **gateway**: Next.js API gateway (Node.js)
- **studio**: Next.js frontend (Bun)
- **amazon** (optional): Deno GraphQL microservices

## Requirements

- Postgres with pgvector + pg_cron (spawntree provides both)
- Redis
- mise (node 24, bun 1.3, deno 2.5)
- Pre-resolved .env files (via 1Password `pnpm env:init`)

## Run

```bash
cd /path/to/project-beta
cp /path/to/spawntree/examples/project-beta/spawntree.yaml .
spawntree up
```
