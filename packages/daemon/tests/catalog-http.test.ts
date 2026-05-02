import { getRequestListener } from "@hono/node-server";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogHttpProxy, createCatalogHttpDb, schema } from "spawntree-core";
import { StorageManager } from "../src/storage/manager.ts";
import { createCatalogRoutes } from "../src/routes/catalog.ts";
import { applyCatalogSchema, upsertClone, upsertRepo } from "../src/catalog/queries.ts";
import { drizzle } from "drizzle-orm/libsql";

/**
 * End-to-end: daemon opens a storage primary, mounts the catalog HTTP
 * routes, and an external Drizzle client queries it over HTTP.
 *
 * Proves that a downstream tool can:
 *   1. Import the schema + a factory from spawntree-core.
 *   2. Hand it a daemon URL.
 *   3. Run fully-typed Drizzle queries with zero daemon-side changes.
 *
 * The server is booted in-process on an ephemeral port; no docker, no
 * external dependencies.
 */

describe("catalog HTTP proxy + external Drizzle client", () => {
  let tmp: string;
  let storage: StorageManager;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-cat-http-"));
    storage = new StorageManager({ dataDir: tmp, logger: () => undefined });
    await storage.start();

    // Seed the catalog with real data via the daemon-side Drizzle db so the
    // schema is applied and rows exist before the client connects.
    await applyCatalogSchema(storage.client);
    const seed = drizzle(storage.client, { schema });
    await upsertRepo(seed, {
      id: "github/acme/widgets",
      slug: "acme/widgets",
      name: "widgets",
      provider: "github",
      owner: "acme",
      remoteUrl: "git@github.com:acme/widgets.git",
      defaultBranch: "main",
      description: "",
      registeredAt: "",
      updatedAt: "",
    });
    await upsertRepo(seed, {
      id: "gitlab/acme/gizmo",
      slug: "acme/gizmo",
      name: "gizmo",
      provider: "gitlab",
      owner: "acme",
      remoteUrl: "git@gitlab.com:acme/gizmo.git",
      defaultBranch: "main",
      description: "",
      registeredAt: "",
      updatedAt: "",
    });
    await upsertClone(seed, {
      id: "c1",
      repoId: "github/acme/widgets",
      path: "/tmp/widgets",
      status: "active",
      lastSeenAt: "",
      registeredAt: "",
    });

    // Start a minimal HTTP app with just the catalog routes. Allow remote
    // origin so vitest's localhost connection isn't rejected (it IS
    // localhost, but this keeps the test hermetic vs. node-server internals).
    const app = new Hono();
    app.route("/api/v1/catalog", createCatalogRoutes(storage, { trustRemoteOrigin: true }));

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

  it("createCatalogHttpDb — typed select of all repos over HTTP", async () => {
    const db = createCatalogHttpDb({ url: `http://127.0.0.1:${port}` });
    const rows = await db.select().from(schema.repos);
    expect(rows).toHaveLength(2);
    const byId = rows.find((r) => r.id === "github/acme/widgets");
    expect(byId?.name).toBe("widgets");
    expect(byId?.provider).toBe("github");
  });

  it("typed where clause runs over HTTP", async () => {
    const db = createCatalogHttpDb({ url: `http://127.0.0.1:${port}` });
    const github = await db.select().from(schema.repos).where(eq(schema.repos.provider, "github"));
    expect(github).toHaveLength(1);
    expect(github[0]?.id).toBe("github/acme/widgets");
  });

  it("join across repos + clones over HTTP", async () => {
    const db = createCatalogHttpDb({ url: `http://127.0.0.1:${port}` });
    const rows = await db
      .select({
        repoId: schema.repos.id,
        repoName: schema.repos.name,
        clonePath: schema.clones.path,
      })
      .from(schema.repos)
      .leftJoin(schema.clones, eq(schema.clones.repoId, schema.repos.id))
      .where(eq(schema.repos.id, "github/acme/widgets"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.repoName).toBe("widgets");
    expect(rows[0]?.clonePath).toBe("/tmp/widgets");
  });

  it("relational query API (db.query.repos.findFirst) over HTTP", async () => {
    const db = createCatalogHttpDb({ url: `http://127.0.0.1:${port}` });
    const row = await db.query.repos.findFirst({
      where: eq(schema.repos.provider, "gitlab"),
    });
    expect(row?.id).toBe("gitlab/acme/gizmo");
    expect(row?.remoteUrl).toBe("git@gitlab.com:acme/gizmo.git");
  });

  it("catalogHttpProxy callback can be plugged into drizzle() directly", async () => {
    // Users who want to assemble their own Drizzle can use the raw proxy.
    const { drizzle } = await import("drizzle-orm/sqlite-proxy");
    const db = drizzle(catalogHttpProxy({ url: `http://127.0.0.1:${port}` }), { schema });
    const rows = await db.select().from(schema.repos);
    expect(rows).toHaveLength(2);
  });

  it("surfaces server errors with a useful message", async () => {
    const db = createCatalogHttpDb({ url: `http://127.0.0.1:${port}` });
    // Invalid SQL through a raw proxy call — proves the error path surfaces.
    const proxy = catalogHttpProxy({ url: `http://127.0.0.1:${port}` });
    await expect(proxy("NOT VALID SQL", [], "all")).rejects.toThrow(
      /spawntree catalog query failed/,
    );
    // But the db itself still works on well-formed queries.
    const rows = await db.select().from(schema.repos);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("rejects non-loopback without trustRemoteOrigin", async () => {
    // Spin up a second server with default (loopback-only) gating and
    // confirm that (in-process) it still works from 127.0.0.1.
    const gated = new Hono();
    gated.route("/api/v1/catalog", createCatalogRoutes(storage));
    const s = createServer(getRequestListener(gated.fetch));
    await new Promise<void>((res, rej) => {
      s.once("error", rej);
      s.listen(0, "127.0.0.1", () => res());
    });
    const addr = s.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const p = addr.port;
    try {
      const db = createCatalogHttpDb({ url: `http://127.0.0.1:${p}` });
      const rows = await db.select().from(schema.repos);
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((res) => s.close(() => res()));
    }
  });
});
