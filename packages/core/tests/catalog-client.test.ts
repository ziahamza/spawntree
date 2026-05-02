import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clones,
  createCatalogClient,
  createCatalogClientAsync,
  repos,
  schema,
  worktrees,
  type CatalogClient,
} from "../src/db/index.ts";

/**
 * Tests for the `createCatalogClient` / `createCatalogClientAsync` factories
 * that external consumers (CLIs, dashboards, backup verifiers) use to query
 * a spawntree catalog directly via libSQL.
 *
 * These tests prove:
 *   1. The schema exports are stable and usable end-to-end.
 *   2. A fresh database can be bootstrapped with `createCatalogClientAsync`.
 *   3. Typed queries (`db.select().from(repos)...`) return correctly-typed
 *      rows — TypeScript would catch shape mismatches at compile time, and
 *      the runtime data matches.
 *   4. Relational queries (joins, orderBy, where) work as expected.
 */

describe("createCatalogClient / schema", () => {
  let tmp: string;
  let catalog: CatalogClient;

  beforeEach(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-cat-client-"));
    catalog = await createCatalogClientAsync({
      url: `file:${resolve(tmp, "catalog.db")}`,
      bootstrap: true,
    });
  });

  afterEach(() => {
    catalog.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exposes typed db + client + schema", () => {
    expect(catalog.db).toBeDefined();
    expect(catalog.client).toBeDefined();
    expect(catalog.schema).toBe(schema);
    expect(catalog.schema.repos).toBeDefined();
    expect(catalog.schema.clones).toBeDefined();
    expect(catalog.schema.worktrees).toBeDefined();
    expect(catalog.schema.watchedPaths).toBeDefined();
    expect(catalog.schema.registeredRepos).toBeDefined();
  });

  it("bootstraps the schema on async open", async () => {
    const tables = await catalog.client.execute(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    );
    const names = tables.rows.map((r) => r["name"] as string);
    expect(names).toContain("repos");
    expect(names).toContain("clones");
    expect(names).toContain("worktrees");
    expect(names).toContain("watched_paths");
    expect(names).toContain("registered_repos");
  });

  it("insert + typed select round-trip", async () => {
    const now = new Date().toISOString();
    await catalog.db.insert(repos).values({
      id: "github/acme/widgets",
      slug: "acme/widgets",
      name: "widgets",
      provider: "github",
      owner: "acme",
      remoteUrl: "git@github.com:acme/widgets.git",
      defaultBranch: "main",
      description: "",
      registeredAt: now,
      updatedAt: now,
    });

    const rows = await catalog.db.select().from(repos);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // TypeScript narrows these to string — no `as` needed. The test proves
    // runtime matches the inferred shape.
    expect(row.id).toBe("github/acme/widgets");
    expect(row.slug).toBe("acme/widgets");
    expect(row.name).toBe("widgets");
    expect(row.provider).toBe("github");
    expect(row.owner).toBe("acme");
  });

  it("supports filtered queries (eq + and)", async () => {
    const now = new Date().toISOString();
    await catalog.db.insert(repos).values([
      {
        id: "a",
        slug: "github-a",
        name: "a",
        provider: "github",
        owner: "",
        remoteUrl: "",
        defaultBranch: "",
        description: "",
        registeredAt: now,
        updatedAt: now,
      },
      {
        id: "b",
        slug: "gitlab-b",
        name: "b",
        provider: "gitlab",
        owner: "",
        remoteUrl: "",
        defaultBranch: "",
        description: "",
        registeredAt: now,
        updatedAt: now,
      },
    ]);

    const githubOnly = await catalog.db.select().from(repos).where(eq(repos.provider, "github"));
    expect(githubOnly).toHaveLength(1);
    expect(githubOnly[0]?.id).toBe("a");
  });

  it("supports joins (repos left join clones)", async () => {
    const now = new Date().toISOString();
    await catalog.db.insert(repos).values({
      id: "r1",
      slug: "r1",
      name: "r1",
      provider: "github",
      owner: "",
      remoteUrl: "",
      defaultBranch: "",
      description: "",
      registeredAt: now,
      updatedAt: now,
    });
    await catalog.db.insert(clones).values({
      id: "c1",
      repoId: "r1",
      path: "/tmp/r1",
      status: "active",
      lastSeenAt: now,
      registeredAt: now,
    });
    await catalog.db.insert(clones).values({
      id: "c2",
      repoId: "r1",
      path: "/tmp/r1-feature",
      status: "active",
      lastSeenAt: now,
      registeredAt: now,
    });

    const rows = await catalog.db
      .select({
        repoId: repos.id,
        repoName: repos.name,
        clonePath: clones.path,
      })
      .from(repos)
      .leftJoin(clones, eq(clones.repoId, repos.id))
      .where(eq(repos.id, "r1"))
      .orderBy(desc(clones.path));

    expect(rows).toHaveLength(2);
    expect(rows[0]?.repoName).toBe("r1");
    expect(rows[0]?.clonePath).toBe("/tmp/r1-feature");
    expect(rows[1]?.clonePath).toBe("/tmp/r1");
  });

  it("relational query API (db.query)", async () => {
    const now = new Date().toISOString();
    await catalog.db.insert(repos).values({
      id: "r1",
      slug: "r1",
      name: "r1",
      provider: "github",
      owner: "",
      remoteUrl: "",
      defaultBranch: "",
      description: "",
      registeredAt: now,
      updatedAt: now,
    });

    const found = await catalog.db.query.repos.findFirst({
      where: eq(repos.id, "r1"),
    });
    expect(found?.name).toBe("r1");
  });

  it("FK cascade: deleting a repo removes its clones + worktrees", async () => {
    const now = new Date().toISOString();
    await catalog.db.insert(repos).values({
      id: "r1",
      slug: "r1",
      name: "r1",
      provider: "github",
      owner: "",
      remoteUrl: "",
      defaultBranch: "",
      description: "",
      registeredAt: now,
      updatedAt: now,
    });
    await catalog.db.insert(clones).values({
      id: "c1",
      repoId: "r1",
      path: "/tmp/r1",
      status: "active",
      lastSeenAt: now,
      registeredAt: now,
    });
    await catalog.db.insert(worktrees).values({
      path: "/tmp/r1",
      cloneId: "c1",
      branch: "main",
      headRef: "",
      discoveredAt: now,
    });

    await catalog.db.delete(repos).where(eq(repos.id, "r1"));

    expect(await catalog.db.select().from(clones)).toHaveLength(0);
    expect(await catalog.db.select().from(worktrees)).toHaveLength(0);
  });

  it("sync createCatalogClient works against an existing database", async () => {
    // Seed via async client, then reopen with the sync client (no bootstrap).
    const now = new Date().toISOString();
    await catalog.db.insert(repos).values({
      id: "persisted",
      slug: "p",
      name: "p",
      provider: "github",
      owner: "",
      remoteUrl: "",
      defaultBranch: "",
      description: "",
      registeredAt: now,
      updatedAt: now,
    });
    catalog.close();

    const readonly = createCatalogClient({
      url: `file:${resolve(tmp, "catalog.db")}`,
    });
    try {
      const rows = await readonly.db.select().from(repos);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("persisted");
    } finally {
      readonly.close();
    }

    // Re-open so afterEach's close() doesn't explode on a closed client.
    catalog = await createCatalogClientAsync({
      url: `file:${resolve(tmp, "catalog.db")}`,
      bootstrap: false,
    });
  });

  it("createCatalogClient with bootstrap:true throws (use Async variant)", () => {
    expect(() =>
      createCatalogClient({
        url: `file:${resolve(tmp, "bootstrap-sync.db")}`,
        bootstrap: true,
      }),
    ).toThrow(/createCatalogClientAsync/);
  });

  it("composed multi-table query returns typed nested-looking shape", async () => {
    // Prove the typical "get repo with active clones" query the daemon
    // runs in enrichRepo is expressible without handwriting joins.
    const now = new Date().toISOString();
    await catalog.db.insert(repos).values({
      id: "r1",
      slug: "r1",
      name: "r1",
      provider: "github",
      owner: "",
      remoteUrl: "",
      defaultBranch: "",
      description: "",
      registeredAt: now,
      updatedAt: now,
    });
    await catalog.db.insert(clones).values([
      {
        id: "c1",
        repoId: "r1",
        path: "/a",
        status: "active",
        lastSeenAt: now,
        registeredAt: now,
      },
      {
        id: "c2",
        repoId: "r1",
        path: "/b",
        status: "missing",
        lastSeenAt: now,
        registeredAt: now,
      },
    ]);

    const active = await catalog.db
      .select()
      .from(clones)
      .where(and(eq(clones.repoId, "r1"), eq(clones.status, "active")));
    expect(active).toHaveLength(1);
    expect(active[0]?.path).toBe("/a");
  });
});
