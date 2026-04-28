import { type Context, Hono } from "hono";
import {
  buildCorsHeaders,
  corsHeaderEntries,
  corsPolicyFromEnv,
  isAllowedBrowserOrigin,
  type CorsPolicy,
} from "../lib/cors.ts";
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
  const policy: CorsPolicy = {
    ...corsPolicyFromEnv("SPAWNTREE_CATALOG_TRUST_REMOTE"),
    trustRemote: options.trustRemoteOrigin
      ?? process.env.SPAWNTREE_CATALOG_TRUST_REMOTE === "1",
  };

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const pnaRequested = c.req.header("access-control-request-private-network") === "true";

    if (c.req.method === "OPTIONS") {
      if (!origin || !isAllowedBrowserOrigin(origin, policy)) {
        return c.text("Not Found", 404);
      }

      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(origin, { pnaRequested }),
      });
    }

    await next();

    if (origin && isAllowedBrowserOrigin(origin, policy)) {
      for (const [name, value] of corsHeaderEntries(origin, { pnaRequested })) {
        c.header(name, value);
      }
    }
  });

  const requireLocalOrigin = async (c: Context, next: () => Promise<void>) => {
    if (policy.trustRemote) return next();
    if (isLoopbackRequest(c)) return next();
    // The catalog write surface (`/query`) is loopback-only by default. The
    // public-Studio fallback uses `/query-readonly` which is gated by the
    // CORS allow-list above instead.
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

  /**
   * Read-only variant. Rejects anything that mutates the catalog — makes
   * this endpoint safe to open up to browsers and third-party consumers
   * in a future release that pairs it with per-client auth tokens. The
   * daemon's own writes continue to flow through `/query`, which stays
   * loopback-gated.
   *
   * Validation is prefix-based: after stripping comments and leading
   * whitespace, the statement must start with `SELECT`, `WITH` (CTEs),
   * `EXPLAIN`, or `PRAGMA` (read-only pragmas only — write pragmas are
   * rejected by value). We also reject multi-statement bodies so an
   * attacker can't sneak a trailing `DELETE` after a benign SELECT.
   */
  app.post("/query-readonly", requireLocalOrigin, async (c) => {
    const body = await parseBody<QueryBody>(c);
    const sql = typeof body?.sql === "string" ? body.sql : undefined;
    if (!sql) {
      return c.json({ error: "sql is required", code: "INVALID_BODY" }, 400);
    }
    const verdict = classifyReadOnlySql(sql);
    if (!verdict.ok) {
      return c.json(
        { error: verdict.reason, code: "READONLY_QUERY_REJECTED" },
        400,
      );
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

/**
 * Permissive-but-strict SQL classifier for the read-only endpoint.
 *
 * Exported so tests can exercise the edge cases directly. Not a
 * bulletproof SQL parser, but a single-pass scanner that treats comments
 * and string literals as opaque so tricks like
 * `SELECT '--' || id FROM x; DELETE FROM x` can't hide a semicolon from
 * the multi-statement check — which was possible with the earlier
 * regex-strip approach (flagged by Devin review of #25).
 *
 * The classifier operates on the ORIGINAL SQL, because that's what the
 * daemon is about to execute. It cannot afford to look at a sanitized
 * version that disagrees with what `runOne` will see.
 */
export function classifyReadOnlySql(raw: string): { ok: true } | { ok: false; reason: string } {
  const firstKeyword = findFirstKeyword(raw);
  if (!firstKeyword) {
    return { ok: false, reason: "empty statement" };
  }
  if (hasMultipleStatements(raw)) {
    return { ok: false, reason: "multiple statements are not allowed on the read-only endpoint" };
  }
  const upper = firstKeyword.toUpperCase();
  if (upper === "SELECT" || upper === "WITH" || upper === "EXPLAIN") {
    return { ok: true };
  }
  if (upper === "PRAGMA") {
    return classifyPragma(raw);
  }
  return {
    ok: false,
    reason: "only SELECT, WITH, EXPLAIN, and read-only PRAGMA statements are allowed",
  };
}

/**
 * The catalog-relevant subset of SQLite pragmas that mutate state.
 * Schema-qualified forms (`main.journal_mode`, `temp.foreign_keys`)
 * normalize to the unqualified name before the lookup.
 */
const WRITE_PRAGMAS = new Set([
  "foreign_keys",
  "journal_mode",
  "synchronous",
  "user_version",
  "application_id",
  "schema_version",
  "wal_checkpoint",
  "optimize",
  "shrink_memory",
  "vacuum",
]);

function classifyPragma(raw: string): { ok: true } | { ok: false; reason: string } {
  let i = skipTrivia(raw, 0);
  // We already know the first keyword is PRAGMA; advance past it.
  i += "PRAGMA".length;
  i = skipTrivia(raw, i);
  // The pragma name can include a schema qualifier (`main.journal_mode`).
  const start = i;
  while (i < raw.length && /[a-zA-Z0-9_.]/.test(raw[i]!)) i++;
  const fullName = raw.slice(start, i).toLowerCase();
  if (!fullName) {
    return { ok: false, reason: "PRAGMA name missing" };
  }
  // `main.journal_mode` → `journal_mode`. Anything before the last dot is
  // a schema identifier and doesn't change the pragma's effect.
  const baseName = fullName.includes(".")
    ? fullName.split(".").pop()!
    : fullName;
  if (WRITE_PRAGMAS.has(baseName)) {
    return {
      ok: false,
      reason: `PRAGMA ${fullName} is not allowed on the read-only endpoint`,
    };
  }
  return { ok: true };
}

/**
 * Return the first identifier token (letters + underscores) after
 * skipping leading whitespace and comments. Null if the statement is
 * empty or begins with something that isn't a keyword (a number, a
 * punctuation mark, a string literal).
 */
function findFirstKeyword(raw: string): string | null {
  const start = skipTrivia(raw, 0);
  let i = start;
  while (i < raw.length && /[a-zA-Z_]/.test(raw[i]!)) i++;
  return i > start ? raw.slice(start, i) : null;
}

/**
 * Walk the raw SQL exactly once and return true if we find any
 * non-whitespace / non-comment token AFTER an unquoted semicolon. This
 * is what makes the classifier immune to the `SELECT '--'; DELETE …`
 * family of bypasses — the semicolon inside the string literal is
 * skipped, but the real one between the two statements is caught.
 */
function hasMultipleStatements(raw: string): boolean {
  let i = 0;
  let sawSemi = false;
  while (i < raw.length) {
    const ch = raw[i]!;
    // Line comment.
    if (ch === "-" && raw[i + 1] === "-") {
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    // Block comment.
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      if (i < raw.length) i += 2;
      continue;
    }
    // Single-quoted string literal; SQLite escapes `'` by doubling it.
    if (ch === "'") {
      i++;
      while (i < raw.length) {
        if (raw[i] === "'" && raw[i + 1] === "'") { i += 2; continue; }
        if (raw[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    // Double-quoted identifier; `""` escapes a quote inside.
    if (ch === '"') {
      i++;
      while (i < raw.length) {
        if (raw[i] === '"' && raw[i + 1] === '"') { i += 2; continue; }
        if (raw[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    // Backtick-quoted identifier (MySQL-style, tolerated by SQLite).
    if (ch === "`") {
      i++;
      while (i < raw.length && raw[i] !== "`") i++;
      if (i < raw.length) i++;
      continue;
    }
    if (ch === ";") {
      sawSemi = true;
      i++;
      continue;
    }
    // Whitespace after a semicolon is fine (trailing `;  `), but
    // anything else means a second statement.
    if (sawSemi && !/\s/.test(ch)) {
      return true;
    }
    i++;
  }
  return false;
}

/**
 * Skip whitespace and comments starting at `pos`. Used for both the
 * first-keyword lookup and the PRAGMA-name extraction.
 */
function skipTrivia(raw: string, pos: number): number {
  let i = pos;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "-" && raw[i + 1] === "-") {
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      if (i < raw.length) i += 2;
      continue;
    }
    break;
  }
  return i;
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

// CORS / PNA helpers moved to packages/daemon/src/lib/cors.ts so they're
// shared between catalog and sessions routes (and any future browser-facing
// surface).
