/**
 * Drizzle CRUD over the spawntree-browser SQLite catalog
 * (`picked_folders`, `clones`, `worktrees`, plus reads from `repos`).
 *
 * Every entry point takes the wrapped Drizzle handle the consumer
 * passed to `SpawntreeBrowser` so we don't keep a singleton DB
 * reference. Atomic writes use `db.transaction(...)` where supported
 * by the driver (PowerSync, wa-sqlite, libSQL all expose it).
 */
import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { uuidv7 } from "uuidv7";
import { browserSchema, clones, pickedFolders, worktrees } from "./schema.ts";
import type { CloneRow, PickedFolderRow, WorktreeRow } from "../types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = BaseSQLiteDatabase<"async", any, typeof browserSchema>;

// ─── picked_folders ────────────────────────────────────────────────

export async function createPickedFolder(
  db: Db,
  input: { displayName: string },
): Promise<PickedFolderRow> {
  const id = uuidv7();
  const now = new Date().toISOString();
  const row = {
    id,
    displayName: input.displayName,
    pickedAt: now,
    lastScannedAt: null as string | null,
    scanError: null as string | null,
  };
  await db.insert(pickedFolders).values(row);
  return row;
}

export async function listPickedFolders(db: Db): Promise<PickedFolderRow[]> {
  return db.select().from(pickedFolders).orderBy(asc(pickedFolders.pickedAt));
}

export async function getPickedFolder(db: Db, id: string): Promise<PickedFolderRow | null> {
  const rows = await db.select().from(pickedFolders).where(eq(pickedFolders.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updatePickedFolderScanResult(
  db: Db,
  id: string,
  patch: { lastScannedAt?: string | null; scanError?: string | null },
): Promise<void> {
  await db.update(pickedFolders).set(patch).where(eq(pickedFolders.id, id));
}

export async function deletePickedFolder(db: Db, id: string): Promise<void> {
  // Delete dependent rows first (worktrees → clones), then the folder.
  // Using two statements keeps the SQL portable — some sqlite drivers
  // (PowerSync) don't expose CASCADE-via-trigger for local-only tables.
  const folderClones = await db.select().from(clones).where(eq(clones.pickedFolderId, id));
  for (const clone of folderClones) {
    await db.delete(worktrees).where(eq(worktrees.cloneId, clone.id));
    await db.delete(clones).where(eq(clones.id, clone.id));
  }
  await db.delete(pickedFolders).where(eq(pickedFolders.id, id));
}

// ─── clones ────────────────────────────────────────────────────────

export type UpsertCloneInput = {
  id?: string;
  repoId: string;
  /**
   * For FSA-mode rows the path is synthesised from the picked folder
   * id and relative path. Callers can omit this and let
   * `replaceFsaClonesForFolder` produce it.
   */
  path?: string;
  pickedFolderId?: string | null;
  relativePath?: string | null;
  status?: string;
};

/**
 * Synthesise a unique `path` value for an FSA-mode clone. The form is
 * `fsa://<pickedFolderId>/<relativePath>` — stable across rescans (so
 * we don't churn unique-constraint conflicts), and clearly
 * distinguishable from the absolute paths the daemon writes.
 */
export function fsaPathFor(pickedFolderId: string, relativePath: string): string {
  return `fsa://${pickedFolderId}/${relativePath}`;
}

/**
 * Replace the set of FSA-mode clones belonging to a single picked
 * folder with a fresh list. Wraps the delete + inserts in a single
 * transaction so a mid-scan failure rolls back rather than leaving the
 * folder partially wiped.
 */
export async function replaceFsaClonesForFolder(
  db: Db,
  pickedFolderId: string,
  inserts: UpsertCloneInput[],
): Promise<CloneRow[]> {
  const now = new Date().toISOString();
  const stamped: CloneRow[] = inserts.map((r) => {
    const id = r.id ?? uuidv7();
    const relativePath = r.relativePath ?? "";
    return {
      id,
      repoId: r.repoId,
      path: r.path ?? fsaPathFor(pickedFolderId, relativePath),
      pickedFolderId,
      relativePath,
      status: r.status ?? "active",
      lastSeenAt: now,
      registeredAt: now,
    };
  });

  await db.transaction(async (tx) => {
    // Drop everything currently linked to this folder, then re-insert.
    const existing = await tx
      .select()
      .from(clones)
      .where(eq(clones.pickedFolderId, pickedFolderId));
    for (const clone of existing) {
      await tx.delete(worktrees).where(eq(worktrees.cloneId, clone.id));
      await tx.delete(clones).where(eq(clones.id, clone.id));
    }
    for (const r of stamped) {
      await tx.insert(clones).values(r);
    }
  });
  return stamped;
}

export async function listClones(
  db: Db,
  filter?: { pickedFolderId?: string },
): Promise<CloneRow[]> {
  const where = filter?.pickedFolderId
    ? eq(clones.pickedFolderId, filter.pickedFolderId)
    : undefined;
  const q = where ? db.select().from(clones).where(where) : db.select().from(clones);
  return q.orderBy(asc(clones.relativePath));
}

export async function getClone(db: Db, id: string): Promise<CloneRow | null> {
  const rows = await db.select().from(clones).where(eq(clones.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findClonesByPickedFolder(
  db: Db,
  pickedFolderId: string,
): Promise<CloneRow[]> {
  return db
    .select()
    .from(clones)
    .where(eq(clones.pickedFolderId, pickedFolderId))
    .orderBy(asc(clones.relativePath));
}

export async function listFsaClones(db: Db): Promise<CloneRow[]> {
  return db
    .select()
    .from(clones)
    .where(isNotNull(clones.pickedFolderId))
    .orderBy(asc(clones.relativePath));
}

// ─── worktrees ─────────────────────────────────────────────────────

export type UpsertWorktreeInput = {
  path: string;
  cloneId: string;
  branch?: string;
  headRef?: string;
};

export async function replaceWorktreesForClone(
  db: Db,
  cloneId: string,
  rows: UpsertWorktreeInput[],
): Promise<WorktreeRow[]> {
  const now = new Date().toISOString();
  const stamped: WorktreeRow[] = rows.map((r) => ({
    path: r.path,
    cloneId: r.cloneId,
    branch: r.branch ?? "",
    headRef: r.headRef ?? "",
    discoveredAt: now,
  }));
  await db.transaction(async (tx) => {
    await tx.delete(worktrees).where(eq(worktrees.cloneId, cloneId));
    for (const r of stamped) {
      await tx.insert(worktrees).values(r);
    }
  });
  return stamped;
}

export async function listWorktreesForClone(db: Db, cloneId: string): Promise<WorktreeRow[]> {
  return db
    .select()
    .from(worktrees)
    .where(eq(worktrees.cloneId, cloneId))
    .orderBy(asc(worktrees.path));
}

export async function findCloneByFolderAndRelativePath(
  db: Db,
  pickedFolderId: string,
  relativePath: string,
): Promise<CloneRow | null> {
  const rows = await db
    .select()
    .from(clones)
    .where(and(eq(clones.pickedFolderId, pickedFolderId), eq(clones.relativePath, relativePath)))
    .limit(1);
  return rows[0] ?? null;
}
