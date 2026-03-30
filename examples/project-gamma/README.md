# Project Gamma

CF Workers + Bun + Vite SPA. Zero external dependencies for local dev.

- **host**: Hono on Bun with PGlite (in-process Postgres, auto-seeds dev user)
- **studio**: TanStack Start / Vite SPA
- **machine** (optional): Bun CLI service with local SQLite

## Run

```bash
cd /path/to/project-gamma
cp /path/to/spawntree/examples/project-gamma/spawntree.yaml .
spawntree up
```

## What to observe

- Host auto-initializes PGlite, runs migrations, seeds a dev user
- Studio connects to host via `${HOST_URL}` (auto-injected by spawntree)
- No Docker, no external databases, no secrets needed
