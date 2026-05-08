# spawntree-browser

Browser-mode SpawnTree. A strict subset of `spawntree-daemon` that runs entirely in
a browser tab against folders the user picks via the File System Access API.

## What it does

- **Catalog** — typed Drizzle queries over `repos`, `clones`, `worktrees` (canonical
  spawntree schema from `spawntree-core`) plus a browser-only `picked_folders` table.
  The consumer brings the SQLite database; spawntree-browser provides the schema and
  migration helper.
- **Folder picker + scanner** — `showDirectoryPicker` wrapper that persists handles in
  IndexedDB, plus a depth-limited BFS scanner that finds repos, worktrees, and bare
  repos under each picked folder. Worktrees are stitched back to their main repo.
- **Git read layer** — `isomorphic-git`-backed `readObject`, `resolveRef`, `walk`,
  `findMergeBase`, and a unified-diff renderer compatible with GitHub's `application/
  vnd.github.diff` format.
- **Pack-fetch via a pluggable callback** — when an object is missing locally,
  spawntree-browser calls the consumer-provided `fetchPack` callback. The consumer
  decides where to fetch from (typically a CF Worker that proxies GitHub's
  `git-upload-pack`).
- **Spawntree config read/write** — read and write `spawntree.yaml` via the FSA
  handle, validated through `spawntree-core`'s parser.

## What it does NOT do

- No env spin-up, container management, or infrastructure orchestration.
- No `git worktree add/remove` (mutates working trees — too risky from a tab).
- No `git commit` or `git push`.
- No React or other UI framework — consumers bring their own hooks and components.

See the spawntree daemon for the full feature set when running on a host.

## Quick start

```ts
import { SpawntreeBrowser, migrateBrowserSchema } from "spawntree-browser";

// 1. Migrate the schema once at app boot. The db must be a Drizzle-wrapped
//    async SQLite database (e.g. wa-sqlite, PowerSync, OPFS-sqlite).
await migrateBrowserSchema(db);

// 2. Construct the orchestrator.
const sb = new SpawntreeBrowser({
  db,
  fetchPack: async ({ remoteUrl, wants, haves }) => {
    // Call your CF Worker / spawntree-host proxy that bypasses
    // GitHub's CORS block on git-upload-pack.
    const res = await fetch("/api/git/pack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remoteUrl, wants, haves }),
    });
    return new Uint8Array(await res.arrayBuffer());
  },
});

// 3. Pick a folder, scan it, list discovered repos.
const folder = await sb.pickFolder();
if (folder) await sb.scanFolder(folder.id);
const clones = await sb.listClones({ folderId: folder?.id });

// 4. Compute a PR diff against a connected clone.
const clone = await sb.findCloneByRemote({ ownerRepo: "ziahamza/spawntree" });
if (clone) {
  const diff = await sb.computeDiff({
    cloneId: clone.id,
    baseRef: "main",
    headSha: "abc123...",
    headRef: "feat/foo",
    remoteUrl: clone.remoteUrl,
  });
}
```

## Design notes

See [DESIGN.md](../../DESIGN.md) for general spawntree design rules, and the parent
[CLAUDE.md](../../CLAUDE.md) for code conventions.
