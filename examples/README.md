# Examples

Real-world project configurations for spawntree. Each example is a spawntree.yaml and README showing how spawntree fits into a specific stack.

| Example | Stack | Services | Status |
|---------|-------|----------|--------|
| [project-alpha](./project-alpha/) | Django + Postgres + Redis + Mailpit | 6 services | Requires v0.1.1 (type:postgres, type:redis, type:container) |
| [project-beta](./project-beta/) | 5-runtime monorepo + Postgres + Redis | 4+ services | Requires v0.1.1 (type:postgres, type:redis) |
| [project-gamma](./project-gamma/) | CF Workers + Bun + Vite | 2-3 services | Works now (v0.1.0, type:process only) |

## Testing status

- **project-gamma**: Tested end-to-end. Host (PGlite) + Studio (Vite) start via daemon, healthchecks pass.
- **project-alpha**: Awaiting Phase 3 (shared Postgres/Redis Docker infrastructure).
- **project-beta**: Awaiting Phase 3 + pre-resolved .env files.
