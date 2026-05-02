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

export function createCatalogRoutes(storage: StorageManager, options: CatalogRoutesOptions = {}) {
  const app = new Hono();
  const policy: CorsPolicy = {
    ...corsPolicyFromEnv("SPAWNTREE_CATALOG_TRUST_REMOTE"),
    trustRemote: options.trustRemoteOrigin ?? process.env.SPAWNTREE_CATALOG_TRUST_REMOTE === "1",
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

  /**
   * Loopback gate for the unrestricted write surfaces (`/query`, `/batch`).
   * `/query-readonly` deliberately does NOT use this — public Studio (or
   * any allow-listed browser origin) reaches it through the CORS allow-list
   * above, with the SQL classifier providing the safety net.
   */
  const requireLocalOrigin = async (c: Context, next: () => Promise<void>) => {
    if (policy.trustRemote) return next();
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

  /**
   * Read-only variant. Rejects anything that mutates the catalog — makes
   * this endpoint safe to expose to browsers and third-party consumers
   * via the CORS allow-list (no `requireLocalOrigin` gate). The daemon's
   * own writes continue to flow through `/query`, which stays loopback-only.
   *
   * Validation is prefix-based: after stripping comments and leading
   * whitespace, the statement must start with `SELECT`, `WITH` (CTEs),
   * `EXPLAIN`, or `PRAGMA` (read-only pragmas only — write pragmas are
   * rejected by value). We also reject multi-statement bodies so an
   * attacker can't sneak a trailing `DELETE` after a benign SELECT.
   */
  app.post("/query-readonly", async (c) => {
    const body = await parseBody<QueryBody>(c);
    const sql = typeof body?.sql === "string" ? body.sql : undefined;
    if (!sql) {
      return c.json({ error: "sql is required", code: "INVALID_BODY" }, 400);
    }
    const verdict = classifyReadOnlySql(sql);
    if (!verdict.ok) {
      return c.json({ error: verdict.reason, code: "READONLY_QUERY_REJECTED" }, 400);
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
        rows: projectRows(
          rs.rows as ReadonlyArray<Record<string, unknown>>,
          rs.columns,
          queries[i]!.method,
        ),
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
  if (upper === "SELECT" || upper === "EXPLAIN") {
    return { ok: true };
  }
  if (upper === "WITH") {
    // SQLite supports writable CTEs:
    //   WITH d AS (SELECT 1) INSERT INTO repos(id) VALUES('x')
    // is a single valid statement that starts with `WITH` but performs a
    // write. The multi-statement check can't catch it (no `;` between the
    // CTE and the DML). With `/query-readonly` exposed to public origins
    // (this is the whole point of dropping `requireLocalOrigin`), an
    // attacker on an allow-listed origin could mutate the catalog this
    // way. Scan the body for any DML keyword as a whole word outside
    // strings/comments — if found, this is a write-via-CTE and we reject.
    if (containsWriteKeyword(raw)) {
      return {
        ok: false,
        reason: "writable CTEs (WITH … INSERT/UPDATE/DELETE/…) are not allowed",
      };
    }
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
 * Whole-word scan for SQL DML keywords on the trivia-stripped statement.
 * Used by the WITH branch of `classifyReadOnlySql` to catch writable CTEs.
 *
 * `replaceStringsAndComments` is a string/comment-aware filter — keywords
 * that appear inside `'…'`, `"…"`, ` `…` `, line comments, or block
 * comments are blanked out. Without that filter a CTE that selects the
 * literal string `'INSERT'` would be misclassified as a write.
 */
const WRITE_KEYWORDS = ["INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE", "UPSERT"];

function containsWriteKeyword(raw: string): boolean {
  const cleaned = replaceStringsAndComments(raw).toUpperCase();
  for (const kw of WRITE_KEYWORDS) {
    // \b in JS regex treats `_` as a word char, which is fine for SQL keywords
    // (no SQL keyword has a leading or trailing underscore).
    const re = new RegExp(`\\b${kw}\\b`);
    if (re.test(cleaned)) return true;
  }
  return false;
}

/**
 * Replace SQL string literals and comments with spaces so a downstream
 * keyword scan sees only real SQL tokens. Spaces (rather than removal) are
 * used so the keyword boundary regex still correctly identifies the gap.
 *
 * Recognises:
 *   - `--` line comments through end-of-line
 *   - `/* … *\/` block comments (non-nesting, matching SQLite)
 *   - `' … '` strings with `''` escape
 *   - `" … "` identifiers with `""` escape (quoted identifiers can contain
 *     anything including write keywords like a column literally named "INSERT")
 *   - `` ` … ` `` MySQL-style quoted identifiers (tolerated by SQLite)
 *
 * Unterminated literals/comments are spaced through to end of input, which
 * makes any check fail open by reducing the searchable text — but the
 * `hasMultipleStatements` check would have already blocked obviously
 * malformed multi-statement payloads upstream.
 */
function replaceStringsAndComments(sql: string): string {
  const out: string[] = [];
  const n = sql.length;
  let i = 0;
  const space = (count: number): void => {
    out.push(" ".repeat(count));
  };
  while (i < n) {
    const c = sql.charAt(i);
    const next = i + 1 < n ? sql.charAt(i + 1) : "";

    if (c === "-" && next === "-") {
      const eol = sql.indexOf("\n", i);
      const end = eol === -1 ? n : eol;
      space(end - i);
      i = end;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      space(end - i);
      i = end;
      continue;
    }
    if (c === "'") {
      space(1);
      i++;
      while (i < n) {
        if (sql.charAt(i) === "'") {
          if (sql.charAt(i + 1) === "'") {
            space(2);
            i += 2;
            continue;
          }
          space(1);
          i++;
          break;
        }
        space(1);
        i++;
      }
      continue;
    }
    if (c === '"') {
      space(1);
      i++;
      while (i < n) {
        if (sql.charAt(i) === '"') {
          if (sql.charAt(i + 1) === '"') {
            space(2);
            i += 2;
            continue;
          }
          space(1);
          i++;
          break;
        }
        space(1);
        i++;
      }
      continue;
    }
    if (c === "`") {
      space(1);
      i++;
      while (i < n && sql.charAt(i) !== "`") {
        space(1);
        i++;
      }
      if (i < n) {
        space(1);
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

/**
 * Allow-list of read-safe SQLite pragmas, with the form each is allowed in:
 *
 *   "bare"     →  `PRAGMA name`        (returns current value)
 *   "function" →  `PRAGMA name(arg)`   (introspection — takes object name,
 *                                       returns rows)
 *   "both"     →  either form
 *
 * Pragmas NOT in this map are rejected entirely. The `=` write form
 * (`PRAGMA name = value`) is rejected universally regardless of pragma.
 *
 * Why allow-list (Devin's review of #34 + #36 both pushed for this):
 * SQLite's function-call form `PRAGMA name(value)` is semantically
 * equivalent to `PRAGMA name = value` for STATEFUL pragmas. So
 * `PRAGMA cache_size(0)` sets cache to zero (DoS), `PRAGMA cache_size(1000000)`
 * allocates ~4 GB, etc. A deny-list will always miss something — every
 * future SQLite release that adds a stateful pragma is a new bypass
 * waiting to happen. An allow-list fails closed: a new pragma is
 * blocked by default until reviewed and added here.
 *
 * Schema-qualified forms (`main.cache_size`) normalize to the
 * unqualified base name before lookup.
 */
type PragmaForm = "bare" | "function" | "both";

const ALLOWED_PRAGMAS = new Map<string, PragmaForm>([
  // Introspection — function form takes an object name and returns rows.
  ["table_info", "function"],
  ["table_xinfo", "function"],
  ["table_list", "both"],
  ["index_info", "function"],
  ["index_list", "function"],
  ["index_xinfo", "function"],
  ["foreign_key_list", "function"],
  ["collation_list", "bare"],
  ["compile_options", "bare"],
  ["database_list", "bare"],
  ["function_list", "bare"],
  ["module_list", "bare"],
  ["pragma_list", "bare"],

  // Read-only counters / current-value queries (bare-name only — the
  // function and `=` forms set state, which we never allow).
  ["application_id", "bare"],
  ["auto_vacuum", "bare"],
  ["busy_timeout", "bare"],
  ["cache_size", "bare"],
  ["cache_spill", "bare"],
  ["data_version", "bare"],
  ["encoding", "bare"],
  ["foreign_keys", "bare"],
  ["freelist_count", "bare"],
  ["journal_mode", "bare"],
  ["journal_size_limit", "bare"],
  ["max_page_count", "bare"],
  ["page_count", "bare"],
  ["page_size", "bare"],
  ["recursive_triggers", "bare"],
  ["schema_version", "bare"],
  ["synchronous", "bare"],
  ["temp_store", "bare"],
  ["threads", "bare"],
  ["user_version", "bare"],
  ["wal_autocheckpoint", "bare"],
]);

function classifyPragma(raw: string): { ok: true } | { ok: false; reason: string } {
  let i = skipTrivia(raw, 0);
  // We already know the first keyword is PRAGMA; advance past it.
  i += "PRAGMA".length;
  i = skipTrivia(raw, i);
  // The pragma name can include a schema qualifier (`main.cache_size`).
  const start = i;
  while (i < raw.length && /[a-zA-Z0-9_.]/.test(raw[i]!)) i++;
  const fullName = raw.slice(start, i).toLowerCase();
  if (!fullName) {
    return { ok: false, reason: "PRAGMA name missing" };
  }
  // `main.cache_size` → `cache_size`. Anything before the last dot is
  // a schema identifier and doesn't change the pragma's effect.
  const baseName = fullName.includes(".") ? fullName.split(".").pop()! : fullName;

  const allowedForm = ALLOWED_PRAGMAS.get(baseName);
  if (!allowedForm) {
    return {
      ok: false,
      reason: `PRAGMA ${fullName} is not on the read-only allow-list`,
    };
  }

  // Decide which form was invoked by the next non-trivia character:
  //   `=` → write form, ALWAYS rejected
  //   `(` → function form, allowed only for "function" / "both" pragmas
  //   anything else (eof, ws, `;`) → bare form
  //
  // Devin's review of #36 (BUG_0001): for stateful pragmas the
  // function form `PRAGMA cache_size(0)` is a write equivalent to
  // `PRAGMA cache_size = 0`. The previous fix only blocked `=` and let
  // the `(arg)` form through. The allow-list above — combined with this
  // per-form check — closes that gap.
  const after = skipTrivia(raw, i);
  const ch = after < raw.length ? raw[after] : "";

  if (ch === "=") {
    return {
      ok: false,
      reason: `PRAGMA ${fullName} = … (write form) is not allowed on the read-only endpoint`,
    };
  }

  const invokedForm: "bare" | "function" = ch === "(" ? "function" : "bare";

  if (allowedForm === "both") return { ok: true };
  if (allowedForm === invokedForm) return { ok: true };

  return {
    ok: false,
    reason:
      invokedForm === "function"
        ? `PRAGMA ${fullName}(…) is not allowed (only the bare form is read-safe for this pragma)`
        : `PRAGMA ${fullName} alone is not allowed (this pragma requires the function-call form, e.g. ${fullName}(<arg>))`,
  };
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
        if (raw[i] === "'" && raw[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (raw[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Double-quoted identifier; `""` escapes a quote inside.
    if (ch === '"') {
      i++;
      while (i < raw.length) {
        if (raw[i] === '"' && raw[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (raw[i] === '"') {
          i++;
          break;
        }
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

function errorResponse(c: Context, status: 400 | 403 | 404 | 500, code: string, err: unknown) {
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
    addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr.startsWith("127.")
  );
}

// CORS / PNA helpers moved to packages/daemon/src/lib/cors.ts so they're
// shared between catalog and sessions routes (and any future browser-facing
// surface).
