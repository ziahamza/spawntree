---
"spawntree-core": minor
---

Lift the catalog schema, HTTP client, and a new daemon-first/host-fallback
routing client into `spawntree-core/browser` so embedders (gitenv, custom
dashboards, CLIs) stop redeclaring tables and roll-your-own probe loops.

**`spawntree-core/browser`** now re-exports everything in `db/schema.ts` and
`db/http-client.ts`, plus two new helpers:

- `probeDaemonReachable({ url, timeoutMs })` — never-throws liveness probe
  hitting `/health` (or a custom path) with a short abort budget. Returns
  a boolean.
- `createRoutingCatalogClient({ primary, fallback, probeTtlMs, onRouteChange })`
  — Drizzle database that routes per-query between two catalog endpoints
  based on a TTL-cached probe. Inflight probe dedupe (no thundering herd),
  `onRouteChange` hook for "live / read-only" badges in dashboards.

Server-side consumers can keep importing from the package root; nothing
moved, the new helpers are available there too via `db/index.ts`. The
browser entry stays free of `@libsql/client` and other Node-only deps.

13 new tests cover the probe (timeout, network errors, custom path) and
the routing client (route flips, TTL caching, stampede dedupe,
`onRouteChange` semantics).

See `docs/embedding.md` for the import patterns.
