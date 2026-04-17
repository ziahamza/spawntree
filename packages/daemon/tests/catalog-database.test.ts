import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clone, RegisteredRepo, Repo, WatchedPath, Worktree } from "spawntree-core";
import { localStorageProvider } from "spawntree-core";
import type { PrimaryStorageHandle } from "spawntree-core";
import { CatalogDatabase } from "../src/catalog/database.ts";

/**
 * Full behavior coverage for the async CatalogDatabase. Every method is
 * exercised on a real libSQL client (plain file://), so this also serves
 * as a smoke test that the async port preserves the sync version's semantics.
 *
 * When we later swap in a Turso-embedded primary, these exact tests should
 * still pass — that's the point of going through `StorageManager`'s client.
 */

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "github/acme/widgets",
    slug: "acme/widgets" as Repo["slug"],
    name: "widgets",
    provider: "github",
    owner: "acme",
    remoteUrl: "git@github.com:acme/widgets.git",
    defaultBranch: "main",
    description: "stuff",
    registeredAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function makeClone(overrides: Partial<Clone> = {}): Clone {
  return {
    id: "clone-1" as Clone["id"],
    repoId: "github/acme/widgets",
    path: "/tmp/widgets",
    status: "active",
    lastSeenAt: "",
    registeredAt: "",
    ...overrides,
  };
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    path: "/tmp/widgets",
    cloneId: "clone-1" as Worktree["cloneId"],
    branch: "main",
    headRef: "abc123",
    discoveredAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeWatchedPath(overrides: Partial<WatchedPath> = {}): WatchedPath {
  return {
    path: "/tmp/watch",
    scanChildren: true,
    addedAt: new Date().toISOString(),
    lastScannedAt: undefined,
    lastScanError: undefined,
    ...overrides,
  };
}

function makeRegisteredRepo(overrides: Partial<RegisteredRepo> = {}): RegisteredRepo {
  return {
    repoId: "github/acme/widgets" as RegisteredRepo["repoId"],
    repoPath: "/tmp/widgets",
    configPath: "/tmp/widgets/spawntree.yaml",
    lastSeenAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("CatalogDatabase (async libSQL-backed)", () => {
  let tmp: string;
  let handle: PrimaryStorageHandle;
  let catalog: CatalogDatabase;

  beforeEach(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-cat-test-"));
    handle = await localStorageProvider.create(
      {},
      { dataDir: tmp, logger: () => undefined },
    );
    catalog = await CatalogDatabase.open(handle.client);
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("schema bootstrap", () => {
    it("creates all catalog tables on open", async () => {
      const res = await handle.client.execute(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      );
      const names = res.rows.map((r) => r["name"] as string);
      expect(names).toContain("repos");
      expect(names).toContain("clones");
      expect(names).toContain("worktrees");
      expect(names).toContain("watched_paths");
      expect(names).toContain("registered_repos");
    });

    it("is idempotent — open() twice on the same client is safe", async () => {
      const again = await CatalogDatabase.open(handle.client);
      await again.upsertRepo(makeRepo());
      const repos = await catalog.listRepos();
      expect(repos).toHaveLength(1);
    });
  });

  describe("repos", () => {
    it("upsert + get by id + get by slug", async () => {
      await catalog.upsertRepo(makeRepo());
      const byId = await catalog.getRepo("github/acme/widgets");
      expect(byId?.name).toBe("widgets");
      const bySlug = await catalog.getRepoBySlug("acme/widgets");
      expect(bySlug?.id).toBe("github/acme/widgets");
    });

    it("upsert updates fields on id conflict", async () => {
      await catalog.upsertRepo(makeRepo());
      await catalog.upsertRepo(makeRepo({ description: "new desc" }));
      const repo = await catalog.getRepo("github/acme/widgets");
      expect(repo?.description).toBe("new desc");
    });

    it("upsert removes stale entries with same slug but different id", async () => {
      await catalog.upsertRepo(makeRepo({ id: "old-id" }));
      await catalog.upsertRepo(makeRepo({ id: "new-id" }));
      expect(await catalog.getRepo("old-id")).toBeUndefined();
      expect(await catalog.getRepo("new-id")).toBeDefined();
      const all = await catalog.listRepos();
      expect(all).toHaveLength(1);
    });

    it("listRepos orders by updated_at DESC then name ASC", async () => {
      await catalog.upsertRepo(makeRepo({ id: "a", slug: "o/a" as Repo["slug"], name: "a" }));
      // Small delay to ensure distinct timestamps.
      await new Promise((r) => setTimeout(r, 10));
      await catalog.upsertRepo(makeRepo({ id: "b", slug: "o/b" as Repo["slug"], name: "b" }));
      const repos = await catalog.listRepos();
      expect(repos[0]?.id).toBe("b");
      expect(repos[1]?.id).toBe("a");
    });

    it("repoCount returns the correct number", async () => {
      expect(await catalog.repoCount()).toBe(0);
      await catalog.upsertRepo(makeRepo({ id: "a", slug: "o/a" as Repo["slug"] }));
      await catalog.upsertRepo(makeRepo({ id: "b", slug: "o/b" as Repo["slug"] }));
      expect(await catalog.repoCount()).toBe(2);
    });

    it("populates registered_at / updated_at ISO strings", async () => {
      await catalog.upsertRepo(makeRepo());
      const repo = await catalog.getRepo("github/acme/widgets");
      expect(repo?.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(repo?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("clones", () => {
    beforeEach(async () => {
      await catalog.upsertRepo(makeRepo());
    });

    it("upsert + list + get", async () => {
      await catalog.upsertClone(makeClone());
      const list = await catalog.listClones("github/acme/widgets");
      expect(list).toHaveLength(1);
      expect(list[0]?.path).toBe("/tmp/widgets");
      const one = await catalog.getClone("clone-1");
      expect(one?.repoId).toBe("github/acme/widgets");
    });

    it("updateClonePath reactivates and updates path", async () => {
      await catalog.upsertClone(makeClone({ status: "missing" }));
      await catalog.updateClonePath("clone-1", "/new/path");
      const updated = await catalog.getClone("clone-1");
      expect(updated?.path).toBe("/new/path");
      expect(updated?.status).toBe("active");
    });

    it("updateCloneStatus changes status in place", async () => {
      await catalog.upsertClone(makeClone());
      await catalog.updateCloneStatus("clone-1", "missing");
      const updated = await catalog.getClone("clone-1");
      expect(updated?.status).toBe("missing");
    });

    it("deleteClone removes the clone", async () => {
      await catalog.upsertClone(makeClone());
      await catalog.deleteClone("clone-1");
      expect(await catalog.getClone("clone-1")).toBeUndefined();
    });

    it("foreign key: deleting repo cascades to clones", async () => {
      await catalog.upsertClone(makeClone());
      await handle.client.execute({
        sql: "DELETE FROM repos WHERE id = ?",
        args: ["github/acme/widgets"],
      });
      expect(await catalog.getClone("clone-1")).toBeUndefined();
    });

    it("upsertClone removes stale entries sharing the same path", async () => {
      await catalog.upsertClone(makeClone({ id: "old-clone" as Clone["id"] }));
      await catalog.upsertClone(makeClone({ id: "new-clone" as Clone["id"] }));
      expect(await catalog.getClone("old-clone")).toBeUndefined();
      expect(await catalog.getClone("new-clone")).toBeDefined();
    });
  });

  describe("worktrees", () => {
    beforeEach(async () => {
      await catalog.upsertRepo(makeRepo());
      await catalog.upsertClone(makeClone());
    });

    it("replaceWorktrees overwrites the full set for a clone", async () => {
      await catalog.replaceWorktrees("clone-1", [
        makeWorktree({ path: "/tmp/widgets" }),
        makeWorktree({ path: "/tmp/widgets-feature", branch: "feature" }),
      ]);
      const wts = await catalog.listWorktrees("clone-1");
      expect(wts).toHaveLength(2);
      expect(wts.map((w) => w.path).sort()).toEqual([
        "/tmp/widgets",
        "/tmp/widgets-feature",
      ]);
    });

    it("replaceWorktrees with empty array clears the clone's worktrees", async () => {
      await catalog.replaceWorktrees("clone-1", [makeWorktree()]);
      await catalog.replaceWorktrees("clone-1", []);
      const wts = await catalog.listWorktrees("clone-1");
      expect(wts).toHaveLength(0);
    });

    it("deleting a clone cascades to its worktrees", async () => {
      await catalog.replaceWorktrees("clone-1", [makeWorktree()]);
      await catalog.deleteClone("clone-1");
      const wts = await catalog.listWorktrees("clone-1");
      expect(wts).toHaveLength(0);
    });
  });

  describe("watched_paths", () => {
    it("upsert + list + updateScan", async () => {
      await catalog.upsertWatchedPath(makeWatchedPath());
      const list = await catalog.listWatchedPaths();
      expect(list).toHaveLength(1);
      expect(list[0]?.scanChildren).toBe(true);

      await catalog.updateWatchedPathScan(
        "/tmp/watch",
        "2026-01-01T00:00:00Z",
        "oops",
      );
      const afterUpdate = await catalog.listWatchedPaths();
      expect(afterUpdate[0]?.lastScannedAt).toBe("2026-01-01T00:00:00Z");
      expect(afterUpdate[0]?.lastScanError).toBe("oops");
    });

    it("scanChildren=false stored as 0 and round-trips", async () => {
      await catalog.upsertWatchedPath(makeWatchedPath({ scanChildren: false }));
      const list = await catalog.listWatchedPaths();
      expect(list[0]?.scanChildren).toBe(false);
    });

    it("upsert updates in place on conflict (same path)", async () => {
      await catalog.upsertWatchedPath(makeWatchedPath({ scanChildren: true }));
      await catalog.upsertWatchedPath(makeWatchedPath({ scanChildren: false }));
      const list = await catalog.listWatchedPaths();
      expect(list).toHaveLength(1);
      expect(list[0]?.scanChildren).toBe(false);
    });
  });

  describe("registered_repos", () => {
    it("register + list", async () => {
      await catalog.registerRepo(makeRegisteredRepo());
      const list = await catalog.listRegisteredRepos();
      expect(list).toHaveLength(1);
      expect(list[0]?.configPath).toBe("/tmp/widgets/spawntree.yaml");
    });

    it("register upserts on conflict", async () => {
      await catalog.registerRepo(makeRegisteredRepo({ configPath: "/old.yaml" }));
      await catalog.registerRepo(makeRegisteredRepo({ configPath: "/new.yaml" }));
      const list = await catalog.listRegisteredRepos();
      expect(list).toHaveLength(1);
      expect(list[0]?.configPath).toBe("/new.yaml");
    });

    it("list orders by last_seen_at DESC", async () => {
      await catalog.registerRepo(
        makeRegisteredRepo({
          repoId: "a" as RegisteredRepo["repoId"],
          lastSeenAt: "2026-01-01T00:00:00Z",
        }),
      );
      await catalog.registerRepo(
        makeRegisteredRepo({
          repoId: "b" as RegisteredRepo["repoId"],
          lastSeenAt: "2026-06-01T00:00:00Z",
        }),
      );
      const list = await catalog.listRegisteredRepos();
      expect(list[0]?.repoId).toBe("b");
      expect(list[1]?.repoId).toBe("a");
    });
  });

  describe("works end-to-end against StorageManager's S3 snapshot", () => {
    it("data written via catalog survives a VACUUM INTO snapshot", async () => {
      // Verify that VACUUM INTO (the core operation the S3 replicator uses)
      // produces a file that contains the catalog's rows. This is the key
      // invariant the provider system relies on.
      await catalog.upsertRepo(makeRepo());
      await catalog.upsertClone(makeClone());

      const snapshotPath = resolve(tmp, "snapshot.db");
      await handle.client.execute({
        sql: "VACUUM INTO ?",
        args: [snapshotPath],
      });

      // Open the snapshot as a second client and verify rows are present.
      const { createClient } = await import("@libsql/client");
      const snap = createClient({ url: `file:${snapshotPath}` });
      try {
        const repos = await snap.execute("SELECT id, name FROM repos");
        expect(repos.rows).toHaveLength(1);
        expect(repos.rows[0]?.["id"]).toBe("github/acme/widgets");

        const clones = await snap.execute("SELECT id, path FROM clones");
        expect(clones.rows).toHaveLength(1);
        expect(clones.rows[0]?.["path"]).toBe("/tmp/widgets");
      } finally {
        snap.close();
      }
    });
  });
});
