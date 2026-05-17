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

## 5. Browser-only mode: `spawntree-browser`

When the embedder runs entirely in a browser tab — no daemon, no host — it
needs to drive everything from the page itself: pick folders via the File
System Access API, scan them for git clones + worktrees, persist the catalog
in browser-side SQLite, compute diffs against arbitrary base refs. That's
what `spawntree-browser` is for.

```ts
import {
  SpawntreeBrowser,
  browserSchema,
  migrateBrowserSchema,
  type FetchPackInput,
  type FetchPackResult,
} from "spawntree-browser";

// 1. BYO Drizzle async-SQLite. Most likely PowerSync, wa-sqlite,
//    or a service-worker-hosted libSQL. The schema migration is
//    one call — the embedder owns the database lifecycle.
const db = wrapMyDrizzle(...);
await migrateBrowserSchema(db);

// 2. Optional: a `fetchPack` callback that the diff path uses when
//    a needed object isn't in the user's local clone. GitHub's
//    `git-upload-pack` doesn't serve CORS, so this typically goes
//    through your own server (a Worker / Edge Function / spawntree
//    host) that proxies upload-pack with auth.
async function myFetchPack(input: FetchPackInput): Promise<FetchPackResult> {
  const res = await fetch("/api/git/pack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.headers.get("content-type")?.includes("application/json")) {
    // refNames-mode: server returns { pack: <base64>, refs: {name: sha} }.
    // See "RefNames mode" below.
    return await res.json();
  }
  return new Uint8Array(await res.arrayBuffer());
}

const browser = new SpawntreeBrowser({ db, fetchPack: myFetchPack });

// 3. Use it.
await browser.scanFolder(pickedFolderId, dirHandle);
const result = await browser.computeDiff({
  cloneId,
  remoteUrl,
  baseRef: "main",
  headSha: prHeadSha,
  headRef: "feature/x",
});
if (result.ok) console.log(result.unifiedDiff);
```

### What it does

- **Scan**: walks an FSA `FileSystemDirectoryHandle`, finds git repos +
  worktrees + bare repos, stitches worktrees back to their main repo,
  produces normalized rows for `clones` / `worktrees` in the catalog DB.
- **Catalog**: typed Drizzle queries over `repos`, `clones`, `worktrees`
  (canonical schema from `spawntree-core`) plus a browser-only
  `picked_folders` table for FSA permission tracking.
- **computeDiff**: opens the user's local clone via the FSA bridge,
  resolves `baseRef` + `headSha`, and returns a unified diff. If either
  isn't local, it asks the consumer's `fetchPack` callback to land the
  missing objects.
- **Config**: `readConfig` / `writeConfig` for `spawntree.yaml` files
  inside the user's clones, validated against the spawntree-core schema.

### `fetchPack` — wants vs refNames

The callback has two modes the consumer can support:

| Mode | Input | Use case | Response |
|---|---|---|---|
| Wants | `wants: ["<sha>"]` | The caller already has the SHA (typical for the PR head sha). | `Uint8Array` (raw pack bytes, side-band stripped). |
| RefNames | `refNames: ["main"]`, `wants: []` | The caller knows ref names but not SHAs (typical when the base ref hasn't been fetched into the local clone). | `{ pack: Uint8Array, refs: Record<string,string> }` — server resolves names → SHAs via `ls-refs` and returns both. |

`spawntree-browser` writes the resolved refs into
`refs/remotes/origin/<name>` so subsequent `resolveRefSha` calls find the
new commit by name. If the consumer can support both modes, return the
richer `{ pack, refs }` shape whenever `refNames` is non-empty; the
client side will accept either.

### When to use `spawntree-browser` vs `spawntree-core/browser`

- **`spawntree-core/browser`** — talks to a running daemon (or host
  fallback) over HTTP. The user has spawntree installed and running.
- **`spawntree-browser`** — does it all in the browser tab. The user
  doesn't need a daemon at all, just a folder they can pick.

Many embedders ship both: `spawntree-core/browser` for the
"daemon-detected" path with mutations and live data, and
`spawntree-browser` as the always-available fallback that works even
when no daemon is reachable. gitenv's studio is the canonical example.

## When to redeclare vs. when to import

A simple rule: if it's already in `spawntree-core/browser`, importing wins.
Schema drift is the silent killer of embedders — your `sessions` table starts
the day matching the daemon's, then the daemon adds a column, the embedder
keeps building, and three months later half the rows look broken because the
embedder's local schema diverged.

If you find yourself reaching for "well, I'll just copy this into my repo,"
file an issue (or a PR). The browser entry is small on purpose; we'd rather
add an export than have N copies of the same Drizzle schema in N tools.
