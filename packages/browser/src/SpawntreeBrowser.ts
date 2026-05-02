/**
 * SpawntreeBrowser — the public orchestrator.
 *
 * Composes the FSA picker + scanner, the isomorphic-git read layer,
 * the sqlite catalog, and (in Phase 5) the spawntree config read/write
 * API into a single class consumers wire into their app at startup.
 *
 * Side-effect import: `./buffer-polyfill.ts` installs a global Buffer
 * shim for isomorphic-git. Importing it from the orchestrator means
 * any consumer that touches `SpawntreeBrowser` automatically gets the
 * polyfill, so iso-git's `FileSystem.read()` doesn't trip the silent
 * `ReferenceError: Buffer is not defined` failure mode.
 *
 * See `README.md` for the high-level shape and `types.ts` for the
 * `SpawntreeBrowserOptions` and result types.
 */
import "./buffer-polyfill.ts";

import { isFsaSupported } from "./capability.ts";
import {
  createPickedFolder,
  deletePickedFolder,
  findCloneByFolderAndRelativePath,
  getClone,
  getPickedFolder,
  listClones as listClonesQuery,
  listFsaClones,
  listPickedFolders,
  listWorktreesForClone,
  replaceFsaClonesForFolder,
  replaceWorktreesForClone,
  updatePickedFolderScanResult,
  type Db,
  type UpsertCloneInput,
} from "./db/queries.ts";
import { readConfigFromHandle } from "./config/read.ts";
import { writeConfigViaHandle } from "./config/write.ts";
import { createFsFromHandle } from "./fsa/fs-adapter.ts";
import { deleteHandle, getHandle as getStoredHandle, putHandle } from "./fsa/handle-store.ts";
import { normalizeRemoteUrl, ownerRepoFromNormalized } from "./fsa/normalize.ts";
import { scanFolder, stitchWorktrees, type ScannedEntry } from "./fsa/scan.ts";
import { computeDiff } from "./git/diff.ts";
import { tryFetchPack } from "./git/fetch.ts";
import { hasObject } from "./git/read.ts";
import { resolveRefSha } from "./git/refs.ts";
import type {
  CloneRow,
  ConfigReadResult,
  ConfigWriteResult,
  GitDiffResult,
  PickedFolderRow,
  ScanResult,
  SpawntreeBrowserOptions,
  WorktreeRow,
} from "./types.ts";

type ListClonesFilter = {
  folderId?: string;
  remoteUrl?: string;
};

export class SpawntreeBrowser {
  readonly #options: SpawntreeBrowserOptions;
  readonly #handleCache = new Map<string, FileSystemDirectoryHandle>();

  constructor(options: SpawntreeBrowserOptions) {
    this.#options = options;
  }

  /** `true` when the browser exposes the File System Access APIs. */
  isSupported(): boolean {
    return isFsaSupported();
  }

  // ─── Picker + folder lifecycle ────────────────────────────────────

  async pickFolder(): Promise<PickedFolderRow | null> {
    if (!this.isSupported()) return null;
    const showDirectoryPicker = (
      window as unknown as {
        showDirectoryPicker: (opts?: {
          mode?: "read" | "readwrite";
          id?: string;
        }) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;
    let handle: FileSystemDirectoryHandle;
    try {
      // Request "readwrite" because the fetch path needs to write into
      // `.git/objects/pack/`. The fs-adapter still enforces path-level
      // write restrictions; this just unlocks the API.
      handle = await showDirectoryPicker({ mode: "readwrite", id: "spawntree-browser-folder" });
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === "AbortError") return null;
      throw err;
    }

    // Dedupe: if the user picked the same folder again, reuse the
    // existing row.
    for (const existing of await listPickedFolders(this.#db())) {
      const cached = this.#handleCache.get(existing.id) ?? (await getStoredHandle(existing.id));
      if (cached && (await cached.isSameEntry(handle).catch(() => false))) {
        this.#handleCache.set(existing.id, handle);
        return existing;
      }
    }

    const row = await createPickedFolder(this.#db(), { displayName: handle.name });
    await putHandle(row.id, handle);
    this.#handleCache.set(row.id, handle);
    return row;
  }

  async listFolders(): Promise<PickedFolderRow[]> {
    return listPickedFolders(this.#db());
  }

  async getFolder(folderId: string): Promise<PickedFolderRow | null> {
    return getPickedFolder(this.#db(), folderId);
  }

  /**
   * Re-request permission for a previously-picked folder. Will surface
   * the browser's permission prompt when the current state is not
   * already `granted`. Use `queryFolderPermission` for a peek-only
   * status read that never prompts.
   */
  async reattachFolder(folderId: string): Promise<PermissionState> {
    const handle = await this.#getHandle(folderId);
    if (!handle) return "denied";
    const state = await (
      handle as unknown as {
        queryPermission(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
      }
    ).queryPermission({ mode: "readwrite" });
    if (state === "granted") return state;
    try {
      const requested = await (
        handle as unknown as {
          requestPermission(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
        }
      ).requestPermission({ mode: "readwrite" });
      return requested;
    } catch {
      return "denied";
    }
  }

  /**
   * Read the current permission state for a folder WITHOUT prompting
   * the user. Returns `"denied"` if the handle is missing entirely so
   * UI can render a single "needs reconnect" affordance.
   */
  async queryFolderPermission(folderId: string): Promise<PermissionState> {
    const handle = await this.#getHandle(folderId);
    if (!handle) return "denied";
    return (
      handle as unknown as {
        queryPermission(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
      }
    )
      .queryPermission({ mode: "readwrite" })
      .catch(() => "denied" as PermissionState);
  }

  async forgetFolder(folderId: string): Promise<void> {
    await deletePickedFolder(this.#db(), folderId);
    await deleteHandle(folderId);
    this.#handleCache.delete(folderId);
  }

  // ─── Scan ──────────────────────────────────────────────────────────

  async scanFolder(folderId: string, opts: { signal?: AbortSignal } = {}): Promise<ScanResult> {
    const handle = await this.#getHandle(folderId);
    if (!handle) {
      return { ok: false, error: "no handle stored for this folder" };
    }
    const permission = await this.reattachFolder(folderId);
    if (permission !== "granted") {
      const error = `permission state: ${permission}`;
      await updatePickedFolderScanResult(this.#db(), folderId, {
        scanError: error,
        lastScannedAt: new Date().toISOString(),
      });
      return { ok: false, error };
    }

    let scanResult: Awaited<ReturnType<typeof scanFolder>>;
    try {
      scanResult = await scanFolder(handle, { signal: opts.signal });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      await updatePickedFolderScanResult(this.#db(), folderId, {
        scanError: message,
        lastScannedAt: new Date().toISOString(),
      });
      return { ok: false, error: message };
    }

    const stitch = stitchWorktrees(scanResult.entries);

    // Clones: one per scanned entry. Use a deterministic synthetic
    // path (`fsa://...`) so re-scans are idempotent.
    const cloneInputs: UpsertCloneInput[] = scanResult.entries.map((e) => {
      const normalized = normalizeRemoteUrl(e.originUrl);
      const ownerRepo = ownerRepoFromNormalized(normalized);
      return {
        // We use the normalised remote (or owner/repo, or empty) as
        // `repo_id` for FSA-mode rows. The catalog's real `repos`
        // table is daemon-managed; for browser-mode we store the
        // normalised slug as a stable foreign-key surrogate. Consumers
        // that hydrate `repos` themselves can join later.
        repoId: ownerRepo ?? normalized ?? "",
        relativePath: e.relativePath,
      };
    });

    const inserted = await replaceFsaClonesForFolder(this.#db(), folderId, cloneInputs);
    const cloneByRel = new Map<string, CloneRow>();
    inserted.forEach((row) => {
      if (row.relativePath !== null) cloneByRel.set(row.relativePath, row);
    });

    // Worktrees: emit one row per `worktree`-kind scan entry, attached
    // to its main repo's clone id. Unstitched worktrees are skipped —
    // we surface them via the catalog as bare clones with no main.
    const worktreesByMain = new Map<string, WorktreeRow[]>();
    for (const e of scanResult.entries) {
      if (e.kind !== "worktree") continue;
      const mainRel = stitch.get(e.relativePath);
      if (!mainRel) continue;
      const mainClone = cloneByRel.get(mainRel);
      if (!mainClone) continue;
      const list = worktreesByMain.get(mainClone.id) ?? [];
      list.push({
        path: `fsa://${folderId}/${e.relativePath}`,
        cloneId: mainClone.id,
        branch: e.head?.kind === "branch" ? e.head.value : "",
        headRef: e.head?.kind === "detached" ? e.head.value : "",
        discoveredAt: new Date().toISOString(),
      });
      worktreesByMain.set(mainClone.id, list);
    }
    for (const [cloneId, rows] of worktreesByMain) {
      await replaceWorktreesForClone(
        this.#db(),
        cloneId,
        rows.map((r) => ({
          path: r.path,
          cloneId: r.cloneId,
          branch: r.branch,
          headRef: r.headRef,
        })),
      );
    }

    await updatePickedFolderScanResult(this.#db(), folderId, {
      scanError: null,
      lastScannedAt: new Date().toISOString(),
    });

    return {
      ok: true,
      clonesFound: inserted.length,
      worktreesFound: Array.from(worktreesByMain.values()).reduce(
        (sum, list) => sum + list.length,
        0,
      ),
      warnings: scanResult.warnings.map((w) => `${w.path}: ${w.reason}`),
    };
  }

  // ─── Catalog reads ─────────────────────────────────────────────────

  async listClones(filter?: ListClonesFilter): Promise<CloneRow[]> {
    const db = this.#db();
    if (filter?.folderId) {
      return listClonesQuery(db, { pickedFolderId: filter.folderId });
    }
    if (filter?.remoteUrl) {
      // We don't index by remoteUrl directly — fall back to scanning
      // FSA clones and filtering. Volume is small enough (a few dozen
      // rows in practice) that this is fine.
      const all = await listFsaClones(db);
      const target = normalizeRemoteUrl(filter.remoteUrl);
      const targetOwnerRepo = ownerRepoFromNormalized(target);
      return all.filter((c) => {
        if (!targetOwnerRepo) return false;
        return c.repoId === targetOwnerRepo;
      });
    }
    return listFsaClones(db);
  }

  async getClone(cloneId: string): Promise<CloneRow | null> {
    return getClone(this.#db(), cloneId);
  }

  async findCloneByRemote(input: {
    ownerRepo?: string;
    remoteUrl?: string;
  }): Promise<CloneRow | null> {
    const target = input.ownerRepo
      ? input.ownerRepo.toLowerCase()
      : ownerRepoFromNormalized(normalizeRemoteUrl(input.remoteUrl ?? null));
    if (!target) return null;
    const all = await listFsaClones(this.#db());
    return all.find((c) => c.repoId === target) ?? null;
  }

  async listWorktrees(cloneId: string): Promise<WorktreeRow[]> {
    return listWorktreesForClone(this.#db(), cloneId);
  }

  // ─── Git ops ───────────────────────────────────────────────────────

  async computeDiff(input: {
    cloneId: string;
    baseRef: string;
    headSha: string;
    headRef?: string;
    remoteUrl?: string;
  }): Promise<GitDiffResult> {
    const db = this.#db();
    const clone = await getClone(db, input.cloneId);
    if (!clone) return { ok: false, reason: "no-clone" };
    if (!clone.pickedFolderId) {
      return {
        ok: false,
        reason: "no-clone",
        details: "computeDiff only supports FSA-mode clones in v1",
      };
    }

    // Worktree-as-file routing: when the row corresponds to a worktree
    // (not a main repo), the working tree's `.git` is a FILE pointing
    // at the main repo's `.git/worktrees/<name>/`. We can't navigate
    // through that file via FSA — so we route the diff through the
    // main repo's gitdir, which shares the same object store.
    //
    // Resolution: look up the main clone via the matching scan-time
    // synthesised path. If the clone has `relativePath` set to
    // something the scan recognised as a worktree, find the sibling
    // `repo`-kind clone in the same picked folder and use its gitdir.
    //
    // For now we support the common case: clone is itself a `repo`
    // with `.git/` dir. Worktree rows are surfaced via `listWorktrees`
    // and the caller picks the main clone explicitly.

    const folderId = clone.pickedFolderId;
    const handle = await this.#getHandle(folderId);
    if (!handle) {
      return { ok: false, reason: "no-permission", details: "handle missing" };
    }

    const permission = await (
      handle as unknown as {
        queryPermission(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
      }
    )
      .queryPermission({ mode: "readwrite" })
      .catch(() => "denied" as PermissionState);
    if (permission !== "granted") {
      return {
        ok: false,
        reason: "no-permission",
        details: `permission state: ${permission}`,
      };
    }

    const fs = createFsFromHandle(handle, { mode: "fetchOnly" });
    const repoRel = clone.relativePath ?? "";
    // For browser-scope repos the gitdir is `<rel>/.git`. Bare repos
    // would set the gitdir to `<rel>` directly, but those aren't
    // surfaced for diffing in v1.
    const gitdir = repoRel ? `/${repoRel}/.git` : `/.git`;

    // Resolve the base ref → sha. Try local refs first; fetch on miss.
    let baseSha = await resolveRefSha({ fs, gitdir }, input.baseRef);
    if (!baseSha && this.#options.fetchPack) {
      const fetched = await tryFetchPack({
        fs,
        gitdir,
        cloneId: input.cloneId,
        remoteUrl: input.remoteUrl ?? "",
        wants: [],
        haves: [],
        headRef: input.baseRef,
        fetchPack: this.#options.fetchPack,
      });
      if (fetched.ok) {
        baseSha = await resolveRefSha({ fs, gitdir }, input.baseRef);
      }
    }
    if (!baseSha) {
      return {
        ok: false,
        reason: "missing-base",
        details: `cannot resolve base ref ${input.baseRef}`,
      };
    }

    let source: "local" | "fetched" = "local";

    // Strict head-sha presence check. We ONLY trust the exact PR head
    // sha — falling back to a local branch tip with the same name
    // would silently produce an incorrect diff if the branch has
    // diverged (different fork, force-push gc'd the upstream sha,
    // stale local checkout). Branch names are not unique identifiers.
    const headPresent = await hasObject({ fs, gitdir }, input.headSha);
    if (!headPresent) {
      if (!this.#options.fetchPack) {
        return {
          ok: false,
          reason: "missing-head",
          details: "head sha not present and no fetchPack configured",
        };
      }
      const fetched = await tryFetchPack({
        fs,
        gitdir,
        cloneId: input.cloneId,
        remoteUrl: input.remoteUrl ?? "",
        wants: [input.headSha],
        haves: baseSha ? [baseSha] : [],
        headRef: input.headRef,
        fetchPack: this.#options.fetchPack,
      });
      if (!fetched.ok) {
        return {
          ok: false,
          reason: "missing-head",
          details: `head sha ${input.headSha} not present locally and fetch failed (${fetched.reason})`,
        };
      }
      source = "fetched";
    }

    const result = await computeDiff({ fs, gitdir, baseSha, headSha: input.headSha });
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason === "too-large" ? "too-large" : "unknown",
        details: result.details,
      };
    }
    return {
      ok: true,
      unifiedDiff: result.unifiedDiff,
      baseSha: result.effectiveBase,
      headSha: input.headSha,
      source,
    };
  }

  // ─── Config read + write ──────────────────────────────────────────

  async readConfig(cloneId: string): Promise<ConfigReadResult> {
    const clone = await getClone(this.#db(), cloneId);
    if (!clone) {
      return { ok: false, reason: "no-config", details: "no clone with that id" };
    }
    if (!clone.pickedFolderId) {
      return {
        ok: false,
        reason: "unknown",
        details: "readConfig only supports FSA-mode clones",
      };
    }
    const handle = await this.#getHandle(clone.pickedFolderId);
    if (!handle) {
      return { ok: false, reason: "no-permission", details: "handle missing" };
    }
    return readConfigFromHandle({
      handle,
      relativePath: clone.relativePath ?? "",
    });
  }

  async writeConfig(cloneId: string, yaml: string): Promise<ConfigWriteResult> {
    const clone = await getClone(this.#db(), cloneId);
    if (!clone) {
      return { ok: false, reason: "unknown", details: "no clone with that id" };
    }
    if (!clone.pickedFolderId) {
      return {
        ok: false,
        reason: "unknown",
        details: "writeConfig only supports FSA-mode clones",
      };
    }
    const handle = await this.#getHandle(clone.pickedFolderId);
    if (!handle) {
      return { ok: false, reason: "no-permission", details: "handle missing" };
    }
    return writeConfigViaHandle({
      handle,
      relativePath: clone.relativePath ?? "",
      yaml,
    });
  }

  // ─── internals ────────────────────────────────────────────────────

  #db(): Db {
    return this.#options.db;
  }

  async #getHandle(folderId: string): Promise<FileSystemDirectoryHandle | null> {
    const cached = this.#handleCache.get(folderId);
    if (cached) return cached;
    const stored = await getStoredHandle(folderId);
    if (stored) this.#handleCache.set(folderId, stored);
    return stored;
  }

  /**
   * Internal helper: locate the FSA clone row whose
   * `(pickedFolderId, relativePath)` matches the given pair. Exposed
   * for consumers that compose extra metadata atop spawntree-browser
   * but want to look up canonical rows by location.
   */
  async findCloneByLocation(folderId: string, relativePath: string): Promise<CloneRow | null> {
    return findCloneByFolderAndRelativePath(this.#db(), folderId, relativePath);
  }
}
