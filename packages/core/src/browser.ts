export { ApiClient, ApiClientError, createApiClient } from "./api/client.ts";
export * from "./api/types.ts";

// ─── Catalog (browser-safe pieces) ───────────────────────────────────────
//
// Gitenv (and any other embedder) used to redeclare the `sessions` /
// `session_turns` / `session_tool_calls` Drizzle tables inline + write its
// own `createCatalogHttpDb` factory because `spawntree-core/browser` only
// ever exposed `ApiClient`. The schema and the HTTP proxy factory don't
// need a Node runtime — `drizzle-orm/sqlite-core` is just type definitions
// and `drizzle-orm/sqlite-proxy` calls back into a fetch you provide. Both
// run unchanged in browser bundles.
//
// What's deliberately NOT here: `db/client.ts` (the libSQL connector),
// because `@libsql/client` ships native bindings that don't load in a
// browser. Server-side consumers can keep importing from the package
// root, which still re-exports `db/index.ts` in full.
export * from "./db/schema.ts";
export * from "./db/http-client.ts";
export * from "./db/probe.ts";
export * from "./db/routing-client.ts";
