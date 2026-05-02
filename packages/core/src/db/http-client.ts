import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { schema, type Schema } from "./schema.ts";

/**
 * Connect to a running spawntree daemon's `/api/v1/catalog/query` endpoint
 * and return a fully-typed Drizzle database bound to the catalog schema.
 *
 * This is the killer path for external consumers: your CLI, dashboard,
 * backup verifier, or cross-host reader makes ONE import from spawntree-core,
 * calls ONE factory, and uses Drizzle natively:
 *
 * ```ts
 * import { createCatalogHttpDb, schema } from "spawntree-core";
 * import { eq } from "drizzle-orm";
 *
 * const db = createCatalogHttpDb({ url: "http://127.0.0.1:2222" });
 * const githubRepos = await db.select().from(schema.repos).where(
 *   eq(schema.repos.provider, "github"),
 * );
 * // Array<{ id: string; slug: string; name: string; ... }> — fully typed.
 * ```
 *
 * Under the hood this is Drizzle's `sqlite-proxy` driver pointed at our
 * daemon endpoint. No read endpoints to re-implement, no protocol to learn —
 * you write standard Drizzle queries and they run against the live catalog.
 *
 * Limits:
 *   - Transactions are not supported yet (would need a batch callback
 *     per `drizzle-orm/sqlite-proxy`). External consumers are typically
 *     read-only anyway; writes go through the daemon's HTTP API.
 *   - The endpoint is localhost-gated by default. For remote access set
 *     `SPAWNTREE_CATALOG_TRUST_REMOTE=1` on the daemon (acknowledge that
 *     you're opening the catalog to the network).
 */
export interface CreateCatalogHttpDbOptions {
  /** Base URL of the spawntree daemon, e.g. `http://127.0.0.1:2222`. */
  url: string;
  /** Optional Bearer token sent on every request. */
  authToken?: string;
  /** Override `fetch`, e.g. to inject headers or use an undici agent. */
  fetch?: typeof fetch;
  /** Path to mount the endpoint at. Defaults to `/api/v1/catalog`. */
  basePath?: string;
  /**
   * Route queries through `/query-readonly` instead of `/query`. The daemon
   * rejects anything that isn't a SELECT / WITH / EXPLAIN / read-only
   * PRAGMA, so the client can't accidentally (or maliciously) mutate the
   * catalog. Use this for browser-facing dashboards, public read mirrors,
   * or any consumer that shouldn't need write access.
   */
  readOnly?: boolean;
}

export type CatalogHttpDb = SqliteRemoteDatabase<Schema>;

export type CatalogHttpProxy = (
  sql: string,
  params: Array<unknown>,
  method: "run" | "all" | "values" | "get",
) => Promise<{ rows: Array<Array<unknown>> | Array<unknown> }>;

/**
 * Raw proxy callback for users who want to pass it to Drizzle themselves
 * (so they can add their own middleware, custom schema, custom logger, etc.).
 *
 * ```ts
 * import { drizzle } from "drizzle-orm/sqlite-proxy";
 * import { catalogHttpProxy, schema } from "spawntree-core";
 *
 * const db = drizzle(catalogHttpProxy({ url: "..." }), { schema });
 * ```
 */
export function catalogHttpProxy(options: CreateCatalogHttpDbOptions): CatalogHttpProxy {
  const base = options.url.replace(/\/+$/, "");
  const basePath = (options.basePath ?? "/api/v1/catalog").replace(/\/+$/, "");
  const endpoint = options.readOnly ? "/query-readonly" : "/query";
  const doFetch: typeof fetch = options.fetch ?? fetch;

  return async (sql, params, method) => {
    const res = await doFetch(`${base}${basePath}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
      },
      body: JSON.stringify({ sql, params, method }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`spawntree catalog query failed: ${res.status} ${res.statusText} ${body}`);
    }
    const json = (await res.json()) as { rows?: Array<Array<unknown>> | Array<unknown> };
    return { rows: json.rows ?? [] };
  };
}

/**
 * Convenience factory: build a typed Drizzle database backed by a spawntree
 * daemon's catalog HTTP endpoint. Equivalent to
 * `drizzle(catalogHttpProxy(options), { schema })`.
 */
export function createCatalogHttpDb(options: CreateCatalogHttpDbOptions): CatalogHttpDb {
  return drizzle(catalogHttpProxy(options), { schema });
}
