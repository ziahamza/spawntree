import { getRequestListener } from "@hono/node-server";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  catalogHttpProxy,
  createCatalogHttpDb,
  schema,
} from "spawntree-core";
import { StorageManager } from "../src/storage/manager.ts";
import { classifyReadOnlySql, createCatalogRoutes } from "../src/routes/catalog.ts";
import { applyCatalogSchema, upsertRepo } from "../src/catalog/queries.ts";

/**
 * Cover the read-only catalog endpoint end-to-end:
 *   - the classifier correctly accepts SELECT/WITH/EXPLAIN and read-only
 *     PRAGMAs, and rejects everything else (writes, multi-statement,
 *     write pragmas, empty input).
 *   - `/query-readonly` HTTP wire layer returns 400 for rejected queries
 *     and 200 for valid reads, with the exact same row format as `/query`.
 *   - `createCatalogHttpDb({ readOnly: true })` routes to the right
 *     endpoint, so external consumers get a Drizzle client that can't
 *     mutate the catalog even if they try (the server rejects).
 */

describe("classifyReadOnlySql", () => {
  it.each([
    "SELECT 1",
    "select * from repos",
    "  SELECT * FROM repos",
    "/* comment */ SELECT 1",
    "-- line comment\nSELECT 1",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "with recursive t(n) as (select 1 union select n+1 from t) select * from t limit 5",
    "EXPLAIN QUERY PLAN SELECT * FROM repos",
    "PRAGMA table_info(repos)",
    "PRAGMA cache_size",
    "SELECT 1;",
  ])("accepts: %s", (sql) => {
    const v = classifyReadOnlySql(sql);
    expect(v.ok, `${sql} should be accepted: ${v.ok ? "" : v.reason}`).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["INSERT INTO repos (id) VALUES (?)", "INSERT rejected"],
    ["UPDATE repos SET name = ?", "UPDATE rejected"],
    ["DELETE FROM repos", "DELETE rejected"],
    ["DROP TABLE repos", "DROP rejected"],
    ["CREATE TABLE t (x INT)", "CREATE rejected"],
    ["ALTER TABLE repos ADD COLUMN x INT", "ALTER rejected"],
    ["VACUUM", "VACUUM rejected"],
    ["VACUUM INTO 'x.db'", "VACUUM INTO rejected"],
    ["PRAGMA foreign_keys = OFF", "write pragma rejected"],
    ["PRAGMA journal_mode = DELETE", "write pragma rejected"],
    ["SELECT 1; DELETE FROM repos", "multi-statement rejected"],
    ["SELECT 1;-- benign\nDROP TABLE repos", "hidden second statement rejected"],
  ])("rejects: %s (%s)", (sql, _label) => {
    const v = classifyReadOnlySql(sql);
    expect(v.ok).toBe(false);
  });

  it("tolerates semicolons inside string literals", () => {
    const v = classifyReadOnlySql("SELECT 'a;b' AS x");
    expect(v.ok).toBe(true);
  });

  it("tolerates double-quoted identifiers with semicolons", () => {
    const v = classifyReadOnlySql('SELECT "col;name" FROM repos');
    expect(v.ok).toBe(true);
  });

  // Regression tests for bypasses flagged in Devin's review of PR #25.
  describe("string-literal / comment bypass protection", () => {
    it("rejects SELECT '--' || id followed by a real DELETE", () => {
      // The old regex stripper would match `--'` as a line comment
      // starting inside the string literal, eat through end-of-line
      // (including the `;` and DELETE), and let the classifier see a
      // benign-looking `SELECT '`.
      const v = classifyReadOnlySql("SELECT '--' || id FROM repos; DELETE FROM repos");
      expect(v.ok).toBe(false);
    });

    it("rejects SELECT '/*' ... DELETE '... --*/' block-comment smuggle", () => {
      // The old stripper would match from `/*` inside the string to
      // `*/` at the very end, eating the whole DELETE statement.
      const v = classifyReadOnlySql("SELECT '/*' FROM repos; DELETE FROM repos --*/");
      expect(v.ok).toBe(false);
    });

    it("still accepts a legitimate SELECT that happens to contain '--' in a literal", () => {
      const v = classifyReadOnlySql("SELECT '--safe' AS marker");
      expect(v.ok).toBe(true);
    });

    it("still accepts a legitimate SELECT that happens to contain '/*' in a literal", () => {
      const v = classifyReadOnlySql("SELECT '/*safe*/' AS marker");
      expect(v.ok).toBe(true);
    });

    it("accepts double-quoted identifiers with embedded comment markers", () => {
      const v = classifyReadOnlySql('SELECT "weird--col", "/*col*/" FROM repos');
      expect(v.ok).toBe(true);
    });
  });

  describe("schema-qualified PRAGMA protection", () => {
    it.each([
      "PRAGMA main.journal_mode = DELETE",
      "PRAGMA temp.foreign_keys = OFF",
      "PRAGMA MAIN.synchronous = 0",
      "  PRAGMA main.wal_checkpoint",
    ])("rejects schema-qualified write pragma: %s", (sql) => {
      const v = classifyReadOnlySql(sql);
      expect(v.ok).toBe(false);
    });

    it.each([
      "PRAGMA main.table_info(repos)",
      "PRAGMA main.cache_size",
      "PRAGMA main.index_list(repos)",
    ])("accepts schema-qualified read pragma: %s", (sql) => {
      const v = classifyReadOnlySql(sql);
      expect(v.ok).toBe(true);
    });
  });

  // Regression tests for bypasses flagged in Devin's review of PR #34.
  describe("writable CTE protection (Devin BUG_0002 on #34)", () => {
    it.each([
      [
        "WITH d AS (SELECT 1) INSERT INTO repos(id) VALUES('x')",
        "CTE-then-INSERT",
      ],
      [
        "WITH d(x) AS (VALUES('hacked')) INSERT INTO repos(id, slug, name, provider, owner) SELECT x, x, x, x, '' FROM d",
        "CTE-with-VALUES then INSERT",
      ],
      [
        "WITH d AS (SELECT 1) UPDATE repos SET name='hacked'",
        "CTE-then-UPDATE",
      ],
      [
        "WITH d AS (SELECT 1) DELETE FROM repos",
        "CTE-then-DELETE",
      ],
      [
        "WITH d AS (SELECT 1) REPLACE INTO repos(id) VALUES('x')",
        "CTE-then-REPLACE",
      ],
      [
        "with recursive r(n) as (select 1) insert into repos(id) select cast(n as text) from r",
        "lowercase recursive CTE-then-insert",
      ],
    ])("rejects writable CTE: %s (%s)", (sql, _label) => {
      const v = classifyReadOnlySql(sql);
      expect(v.ok, `expected ${sql} to be rejected`).toBe(false);
    });

    it("still accepts pure-read CTEs", () => {
      expect(classifyReadOnlySql("WITH d AS (SELECT 1) SELECT * FROM d").ok).toBe(true);
      expect(
        classifyReadOnlySql(
          "WITH RECURSIVE t(n) AS (SELECT 1 UNION SELECT n+1 FROM t) SELECT * FROM t LIMIT 5",
        ).ok,
      ).toBe(true);
    });

    it("does not false-positive on a string literal that contains 'INSERT'", () => {
      // The keyword scanner runs over a strings/comments-stripped version
      // of the SQL, so DML keywords inside literals don't match.
      const v = classifyReadOnlySql(
        "WITH d AS (SELECT 'INSERT INTO foo' AS hint) SELECT hint FROM d",
      );
      expect(v.ok).toBe(true);
    });

    it("does not false-positive on a column literally named INSERT", () => {
      // `"INSERT"` is a quoted identifier — also stripped.
      const v = classifyReadOnlySql('WITH d AS (SELECT "INSERT" FROM repos) SELECT * FROM d');
      expect(v.ok).toBe(true);
    });
  });

  describe("PRAGMA allow-list protection (Devin BUG_0001 on #34, BUG_0001 on #36)", () => {
    it.each([
      // BUG_0001 on #34 — `=` write form
      ["PRAGMA cache_size = 0", "cache_size = … rejected"],
      ["PRAGMA locking_mode = EXCLUSIVE", "locking_mode = … rejected"],
      ["PRAGMA writable_schema = ON", "writable_schema = … rejected"],
      ["PRAGMA temp_store = MEMORY", "temp_store = … rejected"],
      ["PRAGMA trusted_schema = OFF", "trusted_schema = … rejected"],
      ["pragma cache_size=0", "lowercase + no spaces"],
      ["PRAGMA   cache_size   =   0", "extra whitespace"],
      ["PRAGMA main.cache_size = 0", "schema-qualified write"],

      // BUG_0001 on #36 — function-call form is also a write for stateful pragmas.
      // SQLite treats `PRAGMA cache_size(0)` as equivalent to `PRAGMA cache_size = 0`.
      ["PRAGMA cache_size(0)", "cache_size(…) write rejected"],
      ["PRAGMA cache_size(1000000)", "cache_size(huge) — would allocate ~4 GB"],
      ["PRAGMA auto_vacuum(2)", "auto_vacuum(…) rejected"],
      ["PRAGMA busy_timeout(60000)", "busy_timeout(…) rejected"],
      ["PRAGMA journal_mode(WAL)", "journal_mode(…) rejected"],
      ["PRAGMA synchronous(OFF)", "synchronous(…) rejected"],
      ["PRAGMA main.cache_size(0)", "schema-qualified function-call write"],
    ])("rejects write form: %s (%s)", (sql, _label) => {
      const v = classifyReadOnlySql(sql);
      expect(v.ok, `expected ${sql} to be rejected`).toBe(false);
    });

    it.each([
      // Allow-listed bare-form reads.
      "PRAGMA cache_size",
      "PRAGMA database_list",
      "PRAGMA compile_options",
      "PRAGMA application_id",
      "PRAGMA user_version",
      // Allow-listed function-form introspection reads.
      "PRAGMA table_info(repos)",
      "PRAGMA table_xinfo(repos)",
      "PRAGMA index_list(repos)",
      "PRAGMA index_info(my_idx)",
      "PRAGMA foreign_key_list(repos)",
      "PRAGMA table_list(repos)",
      // Bare-form introspection that supports it.
      "PRAGMA table_list",
    ])("accepts read-form: %s", (sql) => {
      const v = classifyReadOnlySql(sql);
      expect(v.ok, `expected ${sql} to be accepted`).toBe(true);
    });

    it.each([
      // Pragmas not on the allow-list are rejected outright. This is the
      // "fail closed" property — anything SQLite adds in the future that
      // we haven't reviewed gets blocked by default.
      "PRAGMA writable_schema",
      "PRAGMA trusted_schema",
      "PRAGMA locking_mode",
      "PRAGMA query_only",
      "PRAGMA wal_checkpoint",
      "PRAGMA optimize",
      "PRAGMA shrink_memory",
      "PRAGMA integrity_check",
      // Made-up pragma name a future SQLite version might add.
      "PRAGMA fingerprint_identity",
    ])("rejects pragma not on allow-list: %s", (sql) => {
      const v = classifyReadOnlySql(sql);
      expect(v.ok, `expected ${sql} to be rejected`).toBe(false);
    });

    it.each([
      // "bare"-only pragmas: function form is rejected even though the
      // pragma is allow-listed. `cache_size(0)` would set the value.
      "PRAGMA cache_size(0)",
      "PRAGMA application_id(42)",
      "PRAGMA user_version(1)",
    ])("rejects function form for bare-only pragma: %s", (sql) => {
      const v = classifyReadOnlySql(sql);
      expect(v.ok, `expected ${sql} to be rejected`).toBe(false);
    });

    it.each([
      // "function"-only pragmas: bare form is rejected (would error out
      // anyway in SQLite, but we reject early for a clearer message).
      "PRAGMA table_info",
      "PRAGMA index_list",
      "PRAGMA foreign_key_list",
    ])("rejects bare form for function-only pragma: %s", (sql) => {
      const v = classifyReadOnlySql(sql);
      expect(v.ok, `expected ${sql} to be rejected`).toBe(false);
    });
  });
});

describe("POST /api/v1/catalog/query-readonly", () => {
  let tmp: string;
  let storage: StorageManager;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-ro-"));
    storage = new StorageManager({ dataDir: tmp, logger: () => undefined });
    await storage.start();
    await applyCatalogSchema(storage.client);
    const seed = drizzle(storage.client, { schema });
    await upsertRepo(seed, {
      id: "github/acme/w",
      slug: "acme/w",
      name: "w",
      provider: "github",
      owner: "acme",
      remoteUrl: "",
      defaultBranch: "",
      description: "",
      registeredAt: "",
      updatedAt: "",
    });

    const app = new Hono();
    app.route(
      "/api/v1/catalog",
      createCatalogRoutes(storage, { trustRemoteOrigin: true }),
    );
    server = createServer(getRequestListener(app.fetch));
    await new Promise<void>((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    port = addr.port;
  });

  afterEach(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    await storage.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns rows for a valid SELECT", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/catalog/query-readonly`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sql: "SELECT id, name FROM repos",
        params: [],
        method: "all",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<Array<unknown>> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toEqual(["github/acme/w", "w"]);
  });

  it("rejects a DELETE with 400 + READONLY_QUERY_REJECTED", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/catalog/query-readonly`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sql: "DELETE FROM repos",
        params: [],
        method: "run",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("READONLY_QUERY_REJECTED");

    // Confirm no rows actually got deleted.
    const check = drizzle(storage.client, { schema });
    const rows = await check.select().from(schema.repos);
    expect(rows).toHaveLength(1);
  });

  it("rejects a trailing DROP sneaked after a SELECT", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/catalog/query-readonly`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sql: "SELECT 1; DROP TABLE repos",
        params: [],
        method: "all",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("READONLY_QUERY_REJECTED");

    const check = drizzle(storage.client, { schema });
    const rows = await check.select().from(schema.repos);
    expect(rows).toHaveLength(1);
  });

  it("createCatalogHttpDb({ readOnly: true }) routes SELECTs through", async () => {
    const db = createCatalogHttpDb({ url: `http://127.0.0.1:${port}`, readOnly: true });
    const rows = await db.select().from(schema.repos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("github/acme/w");
  });

  it("createCatalogHttpDb({ readOnly: true }) INSERT raises at the server", async () => {
    const db = createCatalogHttpDb({ url: `http://127.0.0.1:${port}`, readOnly: true });
    // Drizzle wraps the proxy's thrown error with a `Failed query:` prefix,
    // so we just assert that the write rejects AND nothing landed server-side.
    await expect(
      db.insert(schema.repos).values({
        id: "x",
        slug: "x",
        name: "x",
        provider: "x",
        owner: "",
        remoteUrl: "",
        defaultBranch: "",
        description: "",
        registeredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow();
    const check = drizzle(storage.client, { schema });
    const rows = await check
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.id, "x"));
    expect(rows).toHaveLength(0);
  });

  it("raw catalogHttpProxy({ readOnly: true }) + drizzle-proxy also routes correctly", async () => {
    const { drizzle: drizzleProxy } = await import("drizzle-orm/sqlite-proxy");
    const db = drizzleProxy(
      catalogHttpProxy({ url: `http://127.0.0.1:${port}`, readOnly: true }),
      { schema },
    );
    const rows = await db.select().from(schema.sessions);
    expect(rows).toHaveLength(0);
  });
});

/**
 * Regression test for Devin review of PR #33: `/query-readonly` MUST be
 * reachable from a public CORS-allow-listed origin without `trustRemote`,
 * because that's the whole point of the public-Studio fallback. Before this
 * fix the route was guarded by `requireLocalOrigin`, so the CORS preflight
 * would succeed but the actual POST would 403 from any non-loopback IP.
 *
 * `/query` and `/batch` still need the loopback gate (they're the unrestricted
 * write surfaces), so we assert both behaviors in the same suite.
 */
describe("POST /api/v1/catalog/query-readonly without trustRemote", () => {
  let tmp: string;
  let storage: StorageManager;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-ro-no-trust-"));
    storage = new StorageManager({ dataDir: tmp, logger: () => undefined });
    await storage.start();
    await applyCatalogSchema(storage.client);

    const app = new Hono();
    // No `trustRemoteOrigin` — exercise the default deployment posture.
    app.route("/api/v1/catalog", createCatalogRoutes(storage));
    server = createServer(getRequestListener(app.fetch));
    await new Promise<void>((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    port = addr.port;
  });

  afterEach(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    await storage.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("/query-readonly accepts SELECT from a public allow-listed origin", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/catalog/query-readonly`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://gitenv.dev",
      },
      body: JSON.stringify({ sql: "SELECT 1", params: [], method: "all" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://gitenv.dev");
  });

  it("/query still rejects writes from a non-loopback origin (defense in depth)", async () => {
    // The request originates from 127.0.0.1 (the test loopback socket), so
    // requireLocalOrigin's IP check passes. To reach the case we care about
    // we'd need to spoof a remote socket, which the test harness can't do
    // without rewriting Node's HTTP layer. So instead assert what we CAN:
    // /query rejects without trustRemote when an unknown origin is used,
    // since the CORS allow-list covers loopback + gitenv.dev only.
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/catalog/query`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(404);
  });

  it("/query-readonly rejects a write from a public origin via SQL classifier", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/catalog/query-readonly`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://gitenv.dev",
      },
      body: JSON.stringify({
        sql: "DELETE FROM repos",
        params: [],
        method: "run",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("READONLY_QUERY_REJECTED");
  });
});
