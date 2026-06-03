/**
 * Public types for spawntree-browser.
 *
 * Catalog row types are re-exported from spawntree-core's schema (the
 * canonical definition) so consumers and the daemon agree on shapes.
 */
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { browserSchema } from "./db/schema.ts";

export type SpawntreeBrowserOptions = {
  /**
   * BYO sqlite — wrapped Drizzle async database. The consumer migrates
   * the schema once at boot via `migrateBrowserSchema(db)` before
   * constructing.
   *
   * In gitenv this is the PowerSync sqlite wrapped by
   * `wrapPowerSyncWithDrizzle`. In a desktop spawntree-web variant it
   * would be wa-sqlite or similar.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: BaseSQLiteDatabase<"async", any, typeof browserSchema>;

  /**
   * Pluggable pack-fetch. Called when an object isn't local AND the
   * caller needs it for a diff. Returns the raw packfile bytes (without
   * side-band wrapping). spawntree-browser writes them into
   * `.git/objects/pack/` and runs `git.indexPack`.
   *
   * Consumers typically wire this to a CF Worker / spawntree-host
   * endpoint that proxies GitHub's `git-upload-pack` (since GitHub
   * doesn't allow CORS on smart HTTP).
   *
   * Omit for read-only-no-fetch mode: `computeDiff` will fail with
   * `missing-base` / `missing-head` instead of attempting a fetch.
   */
  fetchPack?: FetchPackFn;
};

export type FetchPackInput = {
  cloneId: string;
  /** Origin URL of the clone, normalized form unspecified. */
  remoteUrl: string;
  /**
   * Object SHAs the caller needs (typically the PR head sha). The
   * consumer's proxy resolves these directly via `upload-pack`.
   *
   * At least one of `wants` or `refNames` must be non-empty.
   */
  wants: string[];
  /**
   * Ref names (e.g. `main`, `release/2026-04`) the caller wants
   * resolved AND fetched. Used when the caller doesn't yet know the
   * SHA — typically because the base ref hasn't been fetched into the
   * local clone. The consumer's proxy is expected to do `ls-refs` to
   * resolve the names → SHAs server-side, then `upload-pack` to deliver
   * the corresponding packfile.
   *
   * The consumer signals successful resolution by returning the richer
   * `{ pack, refs }` shape from `FetchPackFn` (see below) so we can
   * write `refs/remotes/origin/<refName>` locally and let
   * `resolveRefSha` find the new commit on the next call.
   */
  refNames?: string[];
  /** Object SHAs the caller already has (for thin packs). */
  haves: string[];
};

/**
 * Successful pack response.
 *
 * Two shapes for backwards compatibility:
 *
 *   - **Bare `Uint8Array`** — the consumer just returns the pack
 *     bytes. Used in the original `wants`-only flow where the caller
 *     supplied the SHA upfront.
 *
 *   - **`{ pack, refs }`** — the consumer resolved one or more refs
 *     server-side (typically because the caller passed `refNames`)
 *     and is reporting back the `<refName, sha>` mappings alongside
 *     the pack. spawntree-browser writes each into
 *     `refs/remotes/origin/<refName>` so subsequent ref-resolution
 *     finds the new commit.
 */
export type FetchPackResult = Uint8Array | { pack: Uint8Array; refs?: Record<string, string> };

export type FetchPackFn = (input: FetchPackInput) => Promise<FetchPackResult>;

// ─── Diff results ────────────────────────────────────────────────────

export type GitDiffSource = "local" | "fetched";

export type GitDiffOk = {
  ok: true;
  /** Unified-diff text in `git diff` format. */
  unifiedDiff: string;
  /** The merge-base sha actually diffed against (may differ from `baseRef`). */
  baseSha: string;
  /** Echo of input.headSha. */
  headSha: string;
  /**
   * `local` — both base and head were already in `.git/objects` at
   * compute time. `fetched` — `fetchPack` was called to land at least
   * one object before the diff completed.
   */
  source: GitDiffSource;
};

export type GitDiffErr = {
  ok: false;
  reason: "missing-base" | "missing-head" | "no-permission" | "no-clone" | "too-large" | "unknown";
  details?: string;
};

export type GitDiffResult = GitDiffOk | GitDiffErr;

// ─── Scan output ─────────────────────────────────────────────────────

export type ScanWarning = {
  path: string;
  reason: string;
};

export type ScanProgress = {
  folderId: string;
  status: "scanning" | "matching" | "done" | "error";
};

export type ScanResult =
  | { ok: true; clonesFound: number; worktreesFound: number; warnings: string[] }
  | { ok: false; error: string };

// ─── Config (spawntree.yaml) ─────────────────────────────────────────

export type ConfigReadResult =
  | { ok: true; yaml: string; parsed: unknown; path: string }
  | {
      ok: false;
      reason: "no-config" | "parse-error" | "no-permission" | "unknown";
      details?: string;
    };

export type ConfigWriteResult =
  | { ok: true; path: string; bytesWritten: number }
  | { ok: false; reason: "validation-failed" | "no-permission" | "unknown"; details?: string };

// ─── Catalog row types (from spawntree-core schema) ─────────────────

export type { CloneRow, PickedFolderRow, RepoRow, WorktreeRow } from "spawntree-core/browser";
