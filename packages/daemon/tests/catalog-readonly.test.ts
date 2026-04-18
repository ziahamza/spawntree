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
