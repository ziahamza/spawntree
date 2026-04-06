import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Clone, RegisteredRepo, Repo, WatchedPath, Worktree } from "spawntree-core";
import { spawntreeHome } from "../state/global-state.js";

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
  scan_children: number;
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

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repos (
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
);

CREATE TABLE IF NOT EXISTS clones (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  last_seen_at TEXT NOT NULL,
  registered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worktrees (
  path TEXT PRIMARY KEY,
  clone_id TEXT NOT NULL REFERENCES clones(id) ON DELETE CASCADE,
  branch TEXT NOT NULL DEFAULT '',
  head_ref TEXT NOT NULL DEFAULT '',
  discovered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watched_paths (
  path TEXT PRIMARY KEY,
  scan_children INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  last_scanned_at TEXT NOT NULL DEFAULT '',
  last_scan_error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS registered_repos (
  repo_id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  config_path TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
`;

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
    scanChildren: row.scan_children === 1,
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

export class CatalogDatabase {
  private readonly db: Database.Database;

  constructor(dbPath = resolve(spawntreeHome(), "catalog.db")) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(schema);
  }

  close() {
    this.db.close();
  }

  repoCount() {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM repos").get() as { count: number; };
    return row.count;
  }

  upsertRepo(repo: Repo) {
    const registeredAt = repo.registeredAt || nowIso();
    const updatedAt = nowIso();

    this.db.prepare("DELETE FROM repos WHERE slug = ? AND id != ?").run(repo.slug, repo.id);
    this.db.prepare(`
      INSERT INTO repos (id, slug, name, provider, owner, remote_url, default_branch, description, registered_at, updated_at)
      VALUES (@id, @slug, @name, @provider, @owner, @remote_url, @default_branch, @description, @registered_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug,
        name = excluded.name,
        provider = excluded.provider,
        owner = excluded.owner,
        remote_url = excluded.remote_url,
        default_branch = excluded.default_branch,
        description = excluded.description,
        updated_at = excluded.updated_at
    `).run({
      id: repo.id,
      slug: repo.slug,
      name: repo.name,
      provider: repo.provider,
      owner: repo.owner,
      remote_url: repo.remoteUrl ?? "",
      default_branch: repo.defaultBranch ?? "",
      description: repo.description ?? "",
      registered_at: registeredAt,
      updated_at: updatedAt,
    });
  }

  listRepos() {
    return this.db.prepare("SELECT * FROM repos ORDER BY updated_at DESC, name ASC").all().map((row: unknown) =>
      toRepo(row as RepoRow)
    );
  }

  getRepo(id: string) {
    const row = this.db.prepare("SELECT * FROM repos WHERE id = ? LIMIT 1").get(id) as RepoRow | undefined;
    return row ? toRepo(row) : undefined;
  }

  getRepoBySlug(slug: string) {
    const row = this.db.prepare("SELECT * FROM repos WHERE slug = ? LIMIT 1").get(slug) as RepoRow | undefined;
    return row ? toRepo(row) : undefined;
  }

  upsertClone(clone: Clone) {
    const registeredAt = clone.registeredAt || nowIso();
    const lastSeenAt = nowIso();
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM clones WHERE path = ? AND id != ?").run(clone.path, clone.id);
      this.db.prepare(`
        INSERT INTO clones (id, repo_id, path, status, last_seen_at, registered_at)
        VALUES (@id, @repo_id, @path, @status, @last_seen_at, @registered_at)
        ON CONFLICT(id) DO UPDATE SET
          repo_id = excluded.repo_id,
          path = excluded.path,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at
      `).run({
        id: clone.id,
        repo_id: clone.repoId,
        path: clone.path,
        status: clone.status,
        last_seen_at: lastSeenAt,
        registered_at: registeredAt,
      });
    });
    transaction();
  }

  listClones(repoId: string) {
    return this.db.prepare("SELECT * FROM clones WHERE repo_id = ? ORDER BY registered_at ASC").all(repoId).map((
      row: unknown,
    ) => toClone(row as CloneRow));
  }

  getClone(cloneId: string) {
    const row = this.db.prepare("SELECT * FROM clones WHERE id = ? LIMIT 1").get(cloneId) as CloneRow | undefined;
    return row ? toClone(row) : undefined;
  }

  updateClonePath(cloneId: string, path: string) {
    this.db.prepare("UPDATE clones SET path = ?, status = 'active', last_seen_at = ? WHERE id = ?").run(
      path,
      nowIso(),
      cloneId,
    );
  }

  updateCloneStatus(cloneId: string, status: string) {
    this.db.prepare("UPDATE clones SET status = ?, last_seen_at = ? WHERE id = ?").run(status, nowIso(), cloneId);
  }

  deleteClone(cloneId: string) {
    this.db.prepare("DELETE FROM clones WHERE id = ?").run(cloneId);
  }

  replaceWorktrees(cloneId: string, worktrees: Array<Worktree>) {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM worktrees WHERE clone_id = ?").run(cloneId);
      const insert = this.db.prepare(`
        INSERT INTO worktrees (path, clone_id, branch, head_ref, discovered_at)
        VALUES (@path, @clone_id, @branch, @head_ref, @discovered_at)
      `);
      for (const worktree of worktrees) {
        insert.run({
          path: worktree.path,
          clone_id: cloneId,
          branch: worktree.branch,
          head_ref: worktree.headRef,
          discovered_at: worktree.discoveredAt,
        });
      }
    });
    transaction();
  }

  listWorktrees(cloneId: string) {
    return this.db.prepare("SELECT * FROM worktrees WHERE clone_id = ? ORDER BY path ASC").all(cloneId).map((
      row: unknown,
    ) => toWorktree(row as WorktreeRow));
  }

  upsertWatchedPath(watchedPath: WatchedPath) {
    this.db.prepare(`
      INSERT INTO watched_paths (path, scan_children, added_at, last_scanned_at, last_scan_error)
      VALUES (@path, @scan_children, @added_at, @last_scanned_at, @last_scan_error)
      ON CONFLICT(path) DO UPDATE SET
        scan_children = excluded.scan_children,
        last_scanned_at = excluded.last_scanned_at,
        last_scan_error = excluded.last_scan_error
    `).run({
      path: watchedPath.path,
      scan_children: watchedPath.scanChildren ? 1 : 0,
      added_at: watchedPath.addedAt || nowIso(),
      last_scanned_at: watchedPath.lastScannedAt ?? "",
      last_scan_error: watchedPath.lastScanError ?? "",
    });
  }

  listWatchedPaths() {
    return this.db.prepare("SELECT * FROM watched_paths ORDER BY added_at ASC").all().map((row: unknown) =>
      toWatchedPath(row as WatchedPathRow)
    );
  }

  updateWatchedPathScan(path: string, lastScannedAt: string, lastScanError = "") {
    this.db.prepare(`
      UPDATE watched_paths
      SET last_scanned_at = ?, last_scan_error = ?
      WHERE path = ?
    `).run(lastScannedAt, lastScanError, path);
  }

  registerRepo(registeredRepo: RegisteredRepo) {
    this.db.prepare(`
      INSERT INTO registered_repos (repo_id, repo_path, config_path, last_seen_at)
      VALUES (@repo_id, @repo_path, @config_path, @last_seen_at)
      ON CONFLICT(repo_id) DO UPDATE SET
        repo_path = excluded.repo_path,
        config_path = excluded.config_path,
        last_seen_at = excluded.last_seen_at
    `).run({
      repo_id: registeredRepo.repoId,
      repo_path: registeredRepo.repoPath,
      config_path: registeredRepo.configPath,
      last_seen_at: registeredRepo.lastSeenAt || nowIso(),
    });
  }

  listRegisteredRepos() {
    return this.db.prepare("SELECT * FROM registered_repos ORDER BY last_seen_at DESC").all().map((row: unknown) =>
      toRegisteredRepo(row as RegisteredRepoRow)
    );
  }
}
