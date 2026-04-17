import type { Client, InValue } from "@libsql/client";
import type { Clone, RegisteredRepo, Repo, WatchedPath, Worktree } from "spawntree-core";

type CloneRow = {
  id: string;
  repo_id: string;
  path: string;
  status: string;
  last_seen_at: string;
  registered_at: string;
};

type RegisteredRepoRow = {
  repo_id: string;
  repo_path: string;
  config_path: string;
  last_seen_at: string;
};

type RepoRow = {
  id: string;
  slug: string;
  name: string;
  provider: string;
  owner: string;
  remote_url: string;
  default_branch: string;
  description: string;
  registered_at: string;
  updated_at: string;
};

type WatchedPathRow = {
  path: string;
  scan_children: number | bigint;
  added_at: string;
  last_scanned_at: string;
  last_scan_error: string;
};

type WorktreeRow = {
  path: string;
  clone_id: string;
  branch: string;
  head_ref: string;
  discovered_at: string;
};

/**
 * Catalog schema statements, applied idempotently on every `open()`.
 *
 * Kept as individual statements rather than a single multi-statement blob
 * because libSQL's `client.execute()` expects one statement per call. Each
 * is `CREATE TABLE IF NOT EXISTS` so they're safe to re-run — no data loss
 * on daemon restart, no migrations needed for the initial version.
 *
 * libSQL file:// mode runs in WAL by default; we don't need to toggle it
 * explicitly. `PRAGMA foreign_keys = ON` still needs to be set per-connection.
 */
const SCHEMA_STATEMENTS: ReadonlyArray<string> = [
  "PRAGMA foreign_keys = ON",
  `CREATE TABLE IF NOT EXISTS repos (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT '',
    remote_url TEXT NOT NULL DEFAULT '',
    default_branch TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS clones (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    last_seen_at TEXT NOT NULL,
    registered_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS worktrees (
    path TEXT PRIMARY KEY,
    clone_id TEXT NOT NULL REFERENCES clones(id) ON DELETE CASCADE,
    branch TEXT NOT NULL DEFAULT '',
    head_ref TEXT NOT NULL DEFAULT '',
    discovered_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS watched_paths (
    path TEXT PRIMARY KEY,
    scan_children INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL,
    last_scanned_at TEXT NOT NULL DEFAULT '',
    last_scan_error TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS registered_repos (
    repo_id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    config_path TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
];

function nowIso() {
  return new Date().toISOString();
}

function toRepo(row: RepoRow): Repo {
  return {
    id: row.id,
    slug: row.slug as Repo["slug"],
    name: row.name,
    provider: row.provider,
    owner: row.owner,
    remoteUrl: row.remote_url,
    defaultBranch: row.default_branch,
    description: row.description,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
  };
}

function toClone(row: CloneRow): Clone {
  return {
    id: row.id as Clone["id"],
    repoId: row.repo_id,
    path: row.path,
    status: row.status,
    lastSeenAt: row.last_seen_at,
    registeredAt: row.registered_at,
  };
}

function toWorktree(row: WorktreeRow): Worktree {
  return {
    path: row.path,
    cloneId: row.clone_id as Worktree["cloneId"],
    branch: row.branch,
    headRef: row.head_ref,
    discoveredAt: row.discovered_at,
  };
}

function toWatchedPath(row: WatchedPathRow): WatchedPath {
  return {
    path: row.path,
    scanChildren: Number(row.scan_children) === 1,
    addedAt: row.added_at,
    lastScannedAt: row.last_scanned_at || undefined,
    lastScanError: row.last_scan_error || undefined,
  };
}

function toRegisteredRepo(row: RegisteredRepoRow): RegisteredRepo {
  return {
    repoId: row.repo_id as RegisteredRepo["repoId"],
    repoPath: row.repo_path,
    configPath: row.config_path,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Daemon-facing view of the spawntree catalog (repos, clones, worktrees,
 * registered repos, watched paths). Reads and writes through the libSQL
 * `Client` handed to it by the `StorageManager`, so whichever primary the
 * user configures (plain local, Turso-embedded, a third-party provider)
 * is transparently the source of truth and is what the replicators see.
 *
 * All methods are async — libSQL is async-only. Multi-statement operations
 * use `client.batch(..., "write")` so they run atomically inside a single
 * transaction. Callers must treat the public API as Promise-returning.
 */
export class CatalogDatabase {
  private readonly client: Client;

  private constructor(client: Client) {
    this.client = client;
  }

  /**
   * Open a catalog on an already-connected libSQL client. Runs the schema
   * idempotently. The client lifecycle belongs to the caller (usually the
   * `StorageManager`) — `close()` does not tear it down.
   */
  static async open(client: Client): Promise<CatalogDatabase> {
    const db = new CatalogDatabase(client);
    for (const stmt of SCHEMA_STATEMENTS) {
      await client.execute(stmt);
    }
    return db;
  }

  async close(): Promise<void> {
    // The libSQL client is owned by the StorageManager — shutting it down
    // there avoids closing it twice if the daemon has multiple consumers
    // pointing at the same client.
  }

  async repoCount(): Promise<number> {
    const res = await this.client.execute("SELECT COUNT(*) AS count FROM repos");
    const raw = res.rows[0]?.["count"];
    return typeof raw === "bigint" ? Number(raw) : Number(raw ?? 0);
  }

  async upsertRepo(repo: Repo): Promise<void> {
    const registeredAt = repo.registeredAt || nowIso();
    const updatedAt = nowIso();
    await this.client.batch(
      [
        {
          sql: "DELETE FROM repos WHERE slug = ? AND id != ?",
          args: [repo.slug, repo.id],
        },
        {
          sql: `INSERT INTO repos (id, slug, name, provider, owner, remote_url, default_branch, description, registered_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  slug = excluded.slug,
                  name = excluded.name,
                  provider = excluded.provider,
                  owner = excluded.owner,
                  remote_url = excluded.remote_url,
                  default_branch = excluded.default_branch,
                  description = excluded.description,
                  updated_at = excluded.updated_at`,
          args: [
            repo.id,
            repo.slug,
            repo.name,
            repo.provider,
            repo.owner,
            repo.remoteUrl ?? "",
            repo.defaultBranch ?? "",
            repo.description ?? "",
            registeredAt,
            updatedAt,
          ],
        },
      ],
      "write",
    );
  }

  async listRepos(): Promise<Array<Repo>> {
    const res = await this.client.execute(
      "SELECT * FROM repos ORDER BY updated_at DESC, name ASC",
    );
    return res.rows.map((row) => toRepo(row as unknown as RepoRow));
  }

  async getRepo(id: string): Promise<Repo | undefined> {
    const res = await this.client.execute({
      sql: "SELECT * FROM repos WHERE id = ? LIMIT 1",
      args: [id],
    });
    const row = res.rows[0];
    return row ? toRepo(row as unknown as RepoRow) : undefined;
  }

  async getRepoBySlug(slug: string): Promise<Repo | undefined> {
    const res = await this.client.execute({
      sql: "SELECT * FROM repos WHERE slug = ? LIMIT 1",
      args: [slug],
    });
    const row = res.rows[0];
    return row ? toRepo(row as unknown as RepoRow) : undefined;
  }

  async upsertClone(clone: Clone): Promise<void> {
    const registeredAt = clone.registeredAt || nowIso();
    const lastSeenAt = nowIso();
    await this.client.batch(
      [
        {
          sql: "DELETE FROM clones WHERE path = ? AND id != ?",
          args: [clone.path, clone.id],
        },
        {
          sql: `INSERT INTO clones (id, repo_id, path, status, last_seen_at, registered_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  repo_id = excluded.repo_id,
                  path = excluded.path,
                  status = excluded.status,
                  last_seen_at = excluded.last_seen_at`,
          args: [
            clone.id,
            clone.repoId,
            clone.path,
            clone.status,
            lastSeenAt,
            registeredAt,
          ],
        },
      ],
      "write",
    );
  }

  async listClones(repoId: string): Promise<Array<Clone>> {
    const res = await this.client.execute({
      sql: "SELECT * FROM clones WHERE repo_id = ? ORDER BY registered_at ASC",
      args: [repoId],
    });
    return res.rows.map((row) => toClone(row as unknown as CloneRow));
  }

  async getClone(cloneId: string): Promise<Clone | undefined> {
    const res = await this.client.execute({
      sql: "SELECT * FROM clones WHERE id = ? LIMIT 1",
      args: [cloneId],
    });
    const row = res.rows[0];
    return row ? toClone(row as unknown as CloneRow) : undefined;
  }

  async updateClonePath(cloneId: string, path: string): Promise<void> {
    await this.client.execute({
      sql: "UPDATE clones SET path = ?, status = 'active', last_seen_at = ? WHERE id = ?",
      args: [path, nowIso(), cloneId],
    });
  }

  async updateCloneStatus(cloneId: string, status: string): Promise<void> {
    await this.client.execute({
      sql: "UPDATE clones SET status = ?, last_seen_at = ? WHERE id = ?",
      args: [status, nowIso(), cloneId],
    });
  }

  async deleteClone(cloneId: string): Promise<void> {
    await this.client.execute({
      sql: "DELETE FROM clones WHERE id = ?",
      args: [cloneId],
    });
  }

  async replaceWorktrees(cloneId: string, worktrees: Array<Worktree>): Promise<void> {
    const statements: Array<{ sql: string; args: Array<InValue> }> = [
      {
        sql: "DELETE FROM worktrees WHERE clone_id = ?",
        args: [cloneId],
      },
    ];
    for (const worktree of worktrees) {
      statements.push({
        sql: `INSERT INTO worktrees (path, clone_id, branch, head_ref, discovered_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          worktree.path,
          cloneId,
          worktree.branch,
          worktree.headRef,
          worktree.discoveredAt,
        ],
      });
    }
    await this.client.batch(statements, "write");
  }

  async listWorktrees(cloneId: string): Promise<Array<Worktree>> {
    const res = await this.client.execute({
      sql: "SELECT * FROM worktrees WHERE clone_id = ? ORDER BY path ASC",
      args: [cloneId],
    });
    return res.rows.map((row) => toWorktree(row as unknown as WorktreeRow));
  }

  async upsertWatchedPath(watchedPath: WatchedPath): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO watched_paths (path, scan_children, added_at, last_scanned_at, last_scan_error)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
              scan_children = excluded.scan_children,
              last_scanned_at = excluded.last_scanned_at,
              last_scan_error = excluded.last_scan_error`,
      args: [
        watchedPath.path,
        watchedPath.scanChildren ? 1 : 0,
        watchedPath.addedAt || nowIso(),
        watchedPath.lastScannedAt ?? "",
        watchedPath.lastScanError ?? "",
      ],
    });
  }

  async listWatchedPaths(): Promise<Array<WatchedPath>> {
    const res = await this.client.execute(
      "SELECT * FROM watched_paths ORDER BY added_at ASC",
    );
    return res.rows.map((row) => toWatchedPath(row as unknown as WatchedPathRow));
  }

  async updateWatchedPathScan(
    path: string,
    lastScannedAt: string,
    lastScanError = "",
  ): Promise<void> {
    await this.client.execute({
      sql: `UPDATE watched_paths
            SET last_scanned_at = ?, last_scan_error = ?
            WHERE path = ?`,
      args: [lastScannedAt, lastScanError, path],
    });
  }

  async registerRepo(registeredRepo: RegisteredRepo): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO registered_repos (repo_id, repo_path, config_path, last_seen_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(repo_id) DO UPDATE SET
              repo_path = excluded.repo_path,
              config_path = excluded.config_path,
              last_seen_at = excluded.last_seen_at`,
      args: [
        registeredRepo.repoId,
        registeredRepo.repoPath,
        registeredRepo.configPath,
        registeredRepo.lastSeenAt || nowIso(),
      ],
    });
  }

  async listRegisteredRepos(): Promise<Array<RegisteredRepo>> {
    const res = await this.client.execute(
      "SELECT * FROM registered_repos ORDER BY last_seen_at DESC",
    );
    return res.rows.map((row) => toRegisteredRepo(row as unknown as RegisteredRepoRow));
  }
}
