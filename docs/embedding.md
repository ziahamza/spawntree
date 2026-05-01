# Embedding spawntree in your own app

If you're building a tool that runs on top of spawntree (a custom dashboard, a
CLI that surfaces session history, a backup verifier, gitenv-style integrations)
the goal is the same: import what we expose, don't redeclare it.

This page shows the three import paths most embedders need.

## 1. `spawntree-core/browser` — for browser bundles and shared code

The browser entry is intentionally light. It's everything that:

- Doesn't need a Node runtime (no `@libsql/client`, no `node:fs`, no `dockerode`)
- Doesn't ship native bindings
- Stays under whatever bundle-size budget your dashboard has

What's there:

```ts
import {
  // Typed Drizzle catalog schema — same one the daemon uses internally
  schema,
  sessions,
  sessionTurns,
  sessionToolCalls,
  repos,
  clones,
  worktrees,
  // ... all table exports + their `RowType` / `NewRowType` aliases

  // HTTP-backed Drizzle database (sqlite-proxy under the hood)
  createCatalogHttpDb,
  catalogHttpProxy,

  // Daemon liveness probe (used by the routing client; useful on its own)
  probeDaemonReachable,

  // Daemon-first / host-fallback routing client
  createRoutingCatalogClient,

  // High-level HTTP client for daemon mutations
  ApiClient,
  createApiClient,
} from "spawntree-core/browser";
```

What's NOT there: anything that imports `@libsql/client`, `dockerode`, or other
Node-only deps. For server-side embedders, import from `spawntree-core` instead
(the package root re-exports the full surface, browser-safe + Node-only).

## 2. Direct catalog reads with full Drizzle inference

The simplest case: you have a daemon URL and want to query its catalog. No
session manager, no orchestration — just rows out.

```ts
import { createCatalogHttpDb, schema } from "spawntree-core/browser";
import { eq, desc } from "drizzle-orm";

const db = createCatalogHttpDb({
  url: "http://127.0.0.1:2222",
  // optional: readOnly: true (route to /query-readonly)
});

const recent = await db
  .select()
  .from(schema.sessions)
  .orderBy(desc(schema.sessions.createdAt))
  .limit(50);
// recent: Array<{ id, provider, cwd, createdAt, ... }> — fully typed.
```

Behind the scenes this is `drizzle-orm/sqlite-proxy` pointed at the daemon's
`/api/v1/catalog/query` endpoint. The proxy serializes the parameterized
query, the daemon runs it, the typed result comes back. No protocol to learn,
no read endpoints to re-implement.

For SELECT-only callers (browser dashboards, public mirrors) pass
`readOnly: true` to route through `/query-readonly`. The daemon rejects
anything that isn't a read at the classifier layer, so the client physically
cannot mutate.

## 3. Daemon-first, host-fallback in one factory

Embedders typically want this shape: prefer the local daemon when it's up
(fast, private, can mutate), fall back to a federation host when it isn't
(remote, possibly stale, read-only). Don't roll your own — this is one
import:

```ts
import { createRoutingCatalogClient, schema } from "spawntree-core/browser";

const db = createRoutingCatalogClient({
  primary:  { url: "http://127.0.0.1:2222" },
  fallback: { url: "https://host.example", authToken: "dh_…", readOnly: true },
  probeTtlMs: 30_000, // default
  onRouteChange: (active) => {
    // toggle a "live" / "read-only mirror" badge in your UI
  },
});

// Use it like any Drizzle database. The routing is invisible.
const sessions = await db.select().from(schema.sessions).limit(20);
```

What this gives you:

- **Cached probe.** The first query probes `primary.url/health`. The result
  is cached for `probeTtlMs` (default 30s); subsequent queries inside that
  window hit the active endpoint without a probe round-trip.
- **Stampede dedupe.** When the cache is stale and many queries arrive at
  once, only one probe goes out. All callers wait on the same promise.
- **Route-change hook.** `onRouteChange` fires once per actual flip
  (primary→fallback or back). Use it to update a connection-status badge.
- **No transactions.** Same caveat as `createCatalogHttpDb` — `sqlite-proxy`
  doesn't support transactions yet. Reads only.

If you need a custom probe (auth-checked, version-pinned, whatever), pass
`probe: (url) => Promise<boolean>`. The default just hits `/health`.

If you need the raw proxy callback to wire into Drizzle yourself (custom
schema, query logger, middleware), use `createRoutingCatalogProxy` instead.

## 4. Daemon mutations: `ApiClient`

The catalog clients above are read-oriented. For state-changing operations
(create session, register repo, store config, etc.) use `ApiClient`:

```ts
import { createApiClient } from "spawntree-core/browser";

const api = createApiClient({ baseUrl: "http://127.0.0.1:2222" });
const session = await api.createSession({
  provider: "claude-code",
  cwd: "/path/to/repo",
});
```

The client is fully typed against `packages/core/src/api/types.ts`. It returns
`Result` shapes, not throwing for HTTP errors — same pattern as the existing
daemon dashboard.

## When to redeclare vs. when to import

A simple rule: if it's already in `spawntree-core/browser`, importing wins.
Schema drift is the silent killer of embedders — your `sessions` table starts
the day matching the daemon's, then the daemon adds a column, the embedder
keeps building, and three months later half the rows look broken because the
embedder's local schema diverged.

If you find yourself reaching for "well, I'll just copy this into my repo,"
file an issue (or a PR). The browser entry is small on purpose; we'd rather
add an export than have N copies of the same Drizzle schema in N tools.
