/**
 * spawntree-browser — public surface.
 *
 * See README.md for what this package does and quickstart usage.
 */
export { SpawntreeBrowser } from "./SpawntreeBrowser.ts";
export { isFsaSupported, fsaSupported } from "./capability.ts";
export { migrateBrowserSchema } from "./db/migrate.ts";
export { browserSchema, clones, pickedFolders, repos, worktrees } from "./db/schema.ts";
export { normalizeRemoteUrl, ownerRepoFromNormalized } from "./fsa/normalize.ts";
export type {
  SpawntreeBrowserOptions,
  FetchPackInput,
  FetchPackFn,
  FetchPackResult,
  GitDiffOk,
  GitDiffErr,
  GitDiffResult,
  GitDiffSource,
  ScanResult,
  ScanWarning,
  ScanProgress,
  ConfigReadResult,
  ConfigWriteResult,
  PickedFolderRow,
  CloneRow,
  WorktreeRow,
  RepoRow,
} from "./types.ts";
