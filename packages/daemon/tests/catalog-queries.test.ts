import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clones as clonesTable,
  localStorageProvider,
  repos as reposTable,
  schema as catalogSchema,
  watchedPaths as watchedPathsTable,
  worktrees as worktreesTable,
  type CatalogDb,
  type PrimaryStorageHandle,
} from "spawntree-core";
import {
  applyCatalogSchema,
  registerRepo,
  replaceWorktrees,
  upsertClone,
  upsertRepo,
  upsertWatchedPath,
} from "../src/catalog/queries.ts";

/**
 * Tests for the handful of catalog query helpers that carry real business
 * logic (transactional upserts with stale-row eviction, bulk replace).
 *
 * Simple one-line Drizzle reads/writes live inline in daemon-service.ts
 * and don't need dedicated tests — if `db.select().from(repos)` ever stops
 * working, that's a Drizzle bug, and `catalog-client.test.ts` in core
 * already covers the Drizzle API surface end-to-end.
 */

describe("catalog/queries helpers", () => {
  let tmp: string;
  let handle: PrimaryStorageHandle;
  let db: CatalogDb;

  beforeEach(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-cat-q-"));
    handle = await localStorageProvider.create({}, { dataDir: tmp, logger: () => undefined });
    await applyCatalogSchema(handle.client);
    db = drizzle(handle.client, { schema: catalogSchema });
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("upsertRepo", () => {
    it("inserts a new repo", async () => {
      await upsertRepo(db, {
        id: "r1",
        slug: "o/r1",
        name: "r1",
        provider: "github",
        owner: "o",
        remoteUrl: "",
        defaultBranch: "",
        description: "",
        registeredAt: "",
        updatedAt: "",
      });
      const rows = await db.select().from(reposTable);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("r1");
      expect(rows[0]?.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(rows[0]?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("updates on id conflict, preserving registeredAt", async () => {
      await upsertRepo(db, {
        id: "r1",
        slug: "o/r1",
        name: "r1",
        provider: "github",
        owner: "",
        remoteUrl: "",
        defaultBranch: "",
        description: "",
        registeredAt: "2026-01-01T00:00:00Z",
        updatedAt: "",
      });
      await upsertRepo(db, {
        id: "r1",
        slug: "o/r1",
        name: "r1-renamed",
        provider: "github",
        owner: "",
        remoteUrl: "",
        defaultBranch: "",
        description: "",
        registeredAt: "",
        updatedAt: "",
      });
      const [row] = await db.select().from(reposTable);
      expect(row?.name).toBe("r1-renamed");
      expect(row?.registeredAt).toBe("2026-01-01T00:00:00Z");
    });

    it("evicts a stale row sharing the same slug under a different id", async () => {
      await upsertRepo(db, {
        id: "old-id",
        slug: "shared-slug",
        name: "old",
        provider: "github",
        owner: "",
        remoteUrl: "",
        defaultBranch: "",
        description: "",
        registeredAt: "",
        updatedAt: "",
      });
      await upsertRepo(db, {
        id: "new-id",
        slug: "shared-slug",
        name: "new",
        provider: "github",
        owner: "",
        remoteUrl: "",
        defaultBranch: "",
        description: "",
        registeredAt: "",
        updatedAt: "",
      });
      const rows = await db.select().from(reposTable);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("new-id");
    });
  });

  describe("upsertClone", () => {
    beforeEach(async () => {
      await upsertRepo(db, {
        id: "r1",
        slug: "r1",
        name: "r1",
        provider: "github",
        owner: "",
        remoteUrl: "",
        defaultBranch: "",
        description: "",
        registeredAt: "",
        updatedAt: "",
      });
    });

    it("inserts a clone", async () => {
      await upsertClone(db, {
        id: "c1",
        repoId: "r1",
        path: "/tmp/c1",
        status: "active",
        lastSeenAt: "",
        registeredAt: "",
      });
      const [row] = await db.select().from(clonesTable);
      expect(row?.id).toBe("c1");
    });

    it("evicts stale clones sharing the same path under a different id", async () => {
      await upsertClone(db, {
        id: "c-old",
        repoId: "r1",
        path: "/tmp/shared",
        status: "active",
        lastSeenAt: "",
        registeredAt: "",
      });
      await upsertClone(db, {
        id: "c-new",
        repoId: "r1",
        path: "/tmp/shared",
        status: "active",
        lastSeenAt: "",
        registeredAt: "",
      });
      const rows = await db.select().from(clonesTable);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("c-new");
    });
  });

  describe("replaceWorktrees", () => {
    beforeEach(async () => {
      await upsertRepo(db, {
        id: "r1",
        slug: "r1",
        name: "r1",
        provider: "github",
        owner: "",
        remoteUrl: "",
        defaultBranch: "",
        description: "",
        registeredAt: "",
        updatedAt: "",
      });
      await upsertClone(db, {
        id: "c1",
        repoId: "r1",
        path: "/tmp/c1",
        status: "active",
        lastSeenAt: "",
        registeredAt: "",
      });
    });

    it("replaces the full set of worktrees for a clone", async () => {
      await replaceWorktrees(db, "c1", [
        {
          path: "/tmp/c1",
          cloneId: "c1",
          branch: "main",
          headRef: "",
          discoveredAt: "2026-01-01T00:00:00Z",
        },
        {
          path: "/tmp/c1-feat",
          cloneId: "c1",
          branch: "feat",
          headRef: "",
          discoveredAt: "2026-01-01T00:00:00Z",
        },
      ]);
      const rows = await db.select().from(worktreesTable);
      expect(rows).toHaveLength(2);

      // Second call with a smaller set fully replaces the prior set.
      await replaceWorktrees(db, "c1", [
        {
          path: "/tmp/c1",
          cloneId: "c1",
          branch: "main",
          headRef: "",
          discoveredAt: "2026-01-01T00:00:00Z",
        },
      ]);
      const after = await db.select().from(worktreesTable);
      expect(after).toHaveLength(1);
      expect(after[0]?.path).toBe("/tmp/c1");
    });

    it("empty array clears worktrees for the clone", async () => {
      await replaceWorktrees(db, "c1", [
        {
          path: "/a",
          cloneId: "c1",
          branch: "main",
          headRef: "",
          discoveredAt: "2026-01-01T00:00:00Z",
        },
      ]);
      await replaceWorktrees(db, "c1", []);
      const after = await db.select().from(worktreesTable);
      expect(after).toHaveLength(0);
    });
  });

  describe("upsertWatchedPath + registerRepo", () => {
    it("upsertWatchedPath round-trips scanChildren as 0/1", async () => {
      await upsertWatchedPath(db, {
        path: "/w1",
        scanChildren: true,
        addedAt: new Date().toISOString(),
      });
      const [row] = await db.select().from(watchedPathsTable);
      expect(row?.scanChildren).toBe(1);

      await upsertWatchedPath(db, {
        path: "/w1",
        scanChildren: false,
        addedAt: new Date().toISOString(),
      });
      const [after] = await db
        .select()
        .from(watchedPathsTable)
        .where(eq(watchedPathsTable.path, "/w1"));
      expect(after?.scanChildren).toBe(0);
    });

    it("registerRepo inserts or updates on repo_id conflict", async () => {
      await registerRepo(db, {
        repoId: "r1",
        repoPath: "/a",
        configPath: "/a/spawntree.yaml",
        lastSeenAt: new Date().toISOString(),
      });
      await registerRepo(db, {
        repoId: "r1",
        repoPath: "/b",
        configPath: "/b/spawntree.yaml",
        lastSeenAt: new Date().toISOString(),
      });
      const rows = await db.select().from(catalogSchema.registeredRepos);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.repoPath).toBe("/b");
    });
  });
});
