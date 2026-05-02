/**
 * spawntree-browser Drizzle schema.
 *
 * The canonical `repos`, `clones`, `worktrees`, and `picked_folders`
 * tables live in spawntree-core (`spawntree-core/browser`). The daemon
 * writes most of them server-side; `picked_folders` plus the FSA-mode
 * columns on `clones` (`picked_folder_id`, `relative_path`) are
 * browser-only but the table definitions still belong with the rest of
 * the catalog so external readers (Drizzle queries, Turso replicas, S3
 * snapshot replays) see one consistent shape.
 *
 * This module composes the relevant subset into a `browserSchema`
 * object that consumers hand to Drizzle:
 *
 * ```ts
 * import { drizzle } from "drizzle-orm/sqlite-proxy";
 * import { browserSchema } from "spawntree-browser";
 * const db = drizzle(executor, { schema: browserSchema });
 * ```
 */
import { clones, pickedFolders, repos, worktrees } from "spawntree-core/browser";

/**
 * Drizzle schema bundle. Pass this to `drizzle(client, { schema })` to
 * get the relational query API on top of the typed tables.
 */
export const browserSchema = {
  repos,
  clones,
  worktrees,
  pickedFolders,
};

export type BrowserSchema = typeof browserSchema;

// Re-export so consumers have a single import location for everything
// they need from spawntree-browser.
export { clones, pickedFolders, repos, worktrees };
