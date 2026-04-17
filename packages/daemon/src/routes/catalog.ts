import { type Context, Hono } from "hono";
import type { StorageManager } from "../storage/manager.ts";

/**
 * HTTP catalog query endpoints.
 *
 *   POST /api/v1/catalog/query    body: { sql, params, method }
 *     → { rows: unknown[][] }
 *
 *   POST /api/v1/catalog/batch    body: { queries: Array<{ sql, params, method }> }
 *     → { results: Array<{ rows: unknown[][] }> }
 *
 * Designed as the server side of Drizzle's `sqlite-proxy` driver so external
 * consumers import `drizzle-orm/sqlite-proxy` with our `catalogHttpProxy`
 * callback from `spawntree-core` and run fully-typed SQL against a live
 * daemon catalog without reimplementing a single read endpoint.
 *
 * Same loopback-origin gate as the storage admin routes. Not a read-only
 * surface: the catalog is the daemon's live DB, so treat this endpoint like
 * direct DB access — locked to localhost unless `SPAWNTREE_CATALOG_TRUST_REMOTE=1`.
 */
export interface CatalogRoutesOptions {
  trustRemoteOrigin?: boolean;
}

type ProxyMethod = "all" | "get" | "run" | "values";

interface QueryBody {
  sql?: unknown;
  params?: unknown;
  method?: unknown;
}

interface BatchBody {
  queries?: unknown;
}

export function createCatalogRoutes(
  storage: StorageManager,
  options: CatalogRoutesOptions = {},
) {
  const app = new Hono();
  const trustRemote = options.trustRemoteOrigin
    ?? process.env.SPAWNTREE_CATALOG_TRUST_REMOTE === "1";

  const requireLocalOrigin = async (c: Context, next: () => Promise<void>) => {
    if (trustRemote) return next();
    if (isLoopbackRequest(c)) return next();
    return c.json(
      {
        error: "catalog query endpoint is restricted to loopback clients",
        code: "CATALOG_REMOTE_DENIED",
      },
      403,
    );
  };

  app.post("/query", requireLocalOrigin, async (c) => {
    const body = await parseBody<QueryBody>(c);
    const sql = typeof body?.sql === "string" ? body.sql : undefined;
    if (!sql) {
      return c.json({ error: "sql is required", code: "INVALID_BODY" }, 400);
    }
    const params = Array.isArray(body?.params) ? (body.params as Array<unknown>) : [];
    const method = normalizeMethod(body?.method);

    try {
      const rows = await runOne(storage, sql, params, method);
      return c.json({ rows });
    } catch (err) {
      return errorResponse(c, 400, "CATALOG_QUERY_FAILED", err);
    }
  });

  app.post("/batch", requireLocalOrigin, async (c) => {
    const body = await parseBody<BatchBody>(c);
    if (!Array.isArray(body?.queries)) {
      return c.json({ error: "queries must be an array", code: "INVALID_BODY" }, 400);
    }
    const queries = (body.queries as Array<QueryBody>).map((q) => ({
      sql: typeof q?.sql === "string" ? q.sql : "",
      params: Array.isArray(q?.params) ? (q.params as Array<unknown>) : [],
      method: normalizeMethod(q?.method),
    }));
    if (queries.some((q) => !q.sql)) {
      return c.json({ error: "each query needs a sql string", code: "INVALID_BODY" }, 400);
    }

    try {
      // libSQL batch wraps all statements in a single transaction.
      const statements = queries.map((q) => ({
        sql: q.sql,
        args: q.params as never,
      }));
      const resultSets = await storage.client.batch(statements, "write");
      const results = resultSets.map((rs, i) => ({
        rows: projectRows(rs.rows as ReadonlyArray<Record<string, unknown>>, rs.columns, queries[i]!.method),
      }));
      return c.json({ results });
    } catch (err) {
      return errorResponse(c, 400, "CATALOG_BATCH_FAILED", err);
    }
  });

  return app;
}

async function runOne(
  storage: StorageManager,
  sql: string,
  params: Array<unknown>,
  method: ProxyMethod,
): Promise<Array<Array<unknown>> | Array<unknown>> {
  const rs = await storage.client.execute({ sql, args: params as never });
  return projectRows(rs.rows as ReadonlyArray<Record<string, unknown>>, rs.columns, method);
}

/**
 * Convert libSQL's row-as-object result into the format Drizzle's
 * sqlite-proxy driver expects:
 *
 *   - `all` / `values`: `Array<Array<value>>` — rows as arrays, ordered by columns.
 *   - `get`:            `Array<value>` — first row as an array (or empty).
 *   - `run`:            `[]` — mutations don't return rows.
 */
function projectRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: ReadonlyArray<string>,
  method: ProxyMethod,
): Array<Array<unknown>> | Array<unknown> {
  if (method === "run") return [];
  const projected = rows.map((row) => columns.map((col) => serialize(row[col])));
  if (method === "get") {
    return projected[0] ?? [];
  }
  return projected;
}

/**
 * libSQL may hand us `bigint`, `Uint8Array`, or `undefined` for column
 * values. JSON can't carry those, so normalise to JSON-safe wire values.
 * The Drizzle client on the other side decodes them back via the schema.
 */
function serialize(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) return Array.from(value);
  return value;
}

function normalizeMethod(raw: unknown): ProxyMethod {
  if (raw === "get" || raw === "run" || raw === "values" || raw === "all") {
    return raw;
  }
  return "all";
}

async function parseBody<T>(c: Context): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

function errorResponse(
  c: Context,
  status: 400 | 403 | 404 | 500,
  code: string,
  err: unknown,
) {
  return c.json(
    {
      error: err instanceof Error ? err.message : String(err),
      code,
    },
    status,
  );
}

function isLoopbackRequest(c: Context): boolean {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } };
  const addr = env?.incoming?.socket?.remoteAddress ?? "";
  return (
    addr === "127.0.0.1"
    || addr === "::1"
    || addr === "::ffff:127.0.0.1"
    || addr.startsWith("127.")
  );
}
