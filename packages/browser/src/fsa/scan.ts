/**
 * Folder scanner — given a `FileSystemDirectoryHandle`, walk it
 * (BFS, depth-limited) and find every git repo and worktree inside.
 *
 * The output is a flat list of `ScannedEntry` rows along with optional
 * scan warnings. The caller (`SpawntreeBrowser.scanFolder`) is
 * responsible for stitching worktrees back to their main repo via the
 * `mainGitDirHint` and persisting to the catalog.
 *
 * Recognised layouts:
 *   - normal repo: `<dir>/.git/` (a directory)
 *   - worktree:    `<dir>/.git`  (a file with content `gitdir: <abs>`)
 *   - bare repo:   `<dir>/HEAD` + `<dir>/objects` + `<dir>/refs`
 *   - linked worktrees: `<repo>/.git/worktrees/<name>/gitdir`
 */

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".idea",
  ".vscode",
  "vendor",
  ".terraform",
  ".gradle",
  ".m2",
  "coverage",
]);

// Dot-dirs we DO want to descend into (the rest are skipped).
const ALLOWED_DOTDIRS = new Set([".git", ".worktrees", ".gitenv-worktrees"]);

const DEFAULT_MAX_DEPTH = 3;

export type ScannedHead = { kind: "branch"; value: string } | { kind: "detached"; value: string };

export type ScannedEntry =
  | {
      kind: "repo";
      relativePath: string; // POSIX-style, "" for root itself
      gitDirRelativePath: string; // e.g. "foo/bar/.git"
      originUrl: string | null;
      head: ScannedHead | null;
    }
  | {
      kind: "worktree";
      relativePath: string;
      gitFileTarget: string; // raw `gitdir:` value
      mainGitDirHint: string | null; // best-effort path back to main `.git`
      originUrl: string | null;
      head: ScannedHead | null;
    }
  | {
      kind: "bare";
      relativePath: string;
      originUrl: string | null;
      head: ScannedHead | null;
    };

export type ScanWarning = { path: string; reason: string };

export type FolderScanResult = {
  entries: ScannedEntry[];
  warnings: ScanWarning[];
};

type DirHandle = FileSystemDirectoryHandle;
type FileHandle = FileSystemFileHandle;

async function tryGetDir(parent: DirHandle, name: string): Promise<DirHandle | null> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch {
    return null;
  }
}

async function tryGetFile(parent: DirHandle, name: string): Promise<FileHandle | null> {
  try {
    return await parent.getFileHandle(name);
  } catch {
    return null;
  }
}

async function readFileText(parent: DirHandle, name: string): Promise<string | null> {
  const handle = await tryGetFile(parent, name);
  if (!handle) return null;
  try {
    const file = await handle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

function parseConfigOriginUrl(configText: string | null): string | null {
  if (!configText) return null;
  // Tiny purpose-built parser — gitconfig is INI-ish but has nested
  // sections like `[remote "origin"]`. We only care about the url field
  // under that exact section.
  const lines = configText.split(/\r?\n/);
  let inOrigin = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    if (inOrigin) {
      const m = line.match(/^url\s*=\s*(.+)$/);
      if (m && m[1]) return m[1].trim();
    }
  }
  return null;
}

function parseHeadFile(headText: string | null): ScannedHead | null {
  if (!headText) return null;
  const trimmed = headText.trim();
  const refMatch = trimmed.match(/^ref:\s*(.+)$/);
  if (refMatch && refMatch[1]) {
    const ref = refMatch[1].trim();
    // refs/heads/main -> main (we keep the prefix for clarity in storage,
    // but store the short value).
    const short = ref.replace(/^refs\/heads\//, "");
    return { kind: "branch", value: short };
  }
  if (/^[0-9a-f]{40}$/i.test(trimmed)) {
    return { kind: "detached", value: trimmed.toLowerCase() };
  }
  return null;
}

async function readGitMeta(
  gitDir: DirHandle,
): Promise<{ originUrl: string | null; head: ScannedHead | null }> {
  const [config, head] = await Promise.all([
    readFileText(gitDir, "config"),
    readFileText(gitDir, "HEAD"),
  ]);
  return {
    originUrl: parseConfigOriginUrl(config),
    head: parseHeadFile(head),
  };
}

async function readGitFileTarget(parent: DirHandle): Promise<string | null> {
  const text = await readFileText(parent, ".git");
  if (text === null) return null;
  const m = text.match(/^gitdir:\s*(.+)$/m);
  return m && m[1] ? m[1].trim() : null;
}

/**
 * Resolve the worktree's `gitdir:` target back to the *main* repo's
 * `.git` directory path. Standard layout puts the worktree's gitdir at
 * `<main>/.git/worktrees/<name>/`. We just take the parent twice.
 *
 * Returns the absolute (or relative-to-something) string of the main
 * `.git` directory, or null if we can't determine it. We don't try
 * to resolve through the FSA root here — that happens later in
 * `stitchWorktrees`.
 */
function resolveMainGitDirHint(gitFileTarget: string): string | null {
  // gitFileTarget typically looks like:
  //   /Users/.../repo/.git/worktrees/feature-x
  // The main `.git` is two segments up.
  const cleaned = gitFileTarget.replace(/\/+$/, "");
  const parts = cleaned.split("/");
  const idx = parts.lastIndexOf("worktrees");
  if (idx <= 0) return null;
  // Up to (and including) `.git`
  return parts.slice(0, idx).join("/");
}

/**
 * Detect whether a directory is a *bare* repository.
 *
 * Heuristic: it has a `HEAD` file, an `objects` directory, and a `refs`
 * directory. We don't check `core.bare` because reading config is more
 * work and the heuristic is robust enough.
 */
async function looksLikeBareRepo(dir: DirHandle): Promise<boolean> {
  const [head, objects, refs] = await Promise.all([
    tryGetFile(dir, "HEAD"),
    tryGetDir(dir, "objects"),
    tryGetDir(dir, "refs"),
  ]);
  return Boolean(head && objects && refs);
}

/**
 * Enumerate all directory child entries (skipping files) of `dir`.
 */
async function listDirChildren(
  dir: DirHandle,
): Promise<Array<{ name: string; handle: DirHandle }>> {
  const out: Array<{ name: string; handle: DirHandle }> = [];
  const iter = dir as unknown as AsyncIterable<[string, FileSystemHandle]>;
  for await (const [name, handle] of iter) {
    if (handle.kind === "directory") {
      out.push({ name, handle: handle as DirHandle });
    }
  }
  return out;
}

/**
 * After finding a repo with `<repoDir>/.git/`, also peek inside
 *   - `<repoDir>/.git/worktrees/<name>/` — linked worktrees registered with this main repo
 *   - `<repoDir>/.worktrees/` and `<repoDir>/worktrees/` — community convention for grouping worktrees
 *
 * The first set is *registered* metadata — each subdir's `gitdir` file
 * points at the corresponding worktree's working tree. We don't yet
 * know if that working tree falls under the picked root, so we surface
 * the hint and let the caller stitch.
 */
async function discoverLinkedWorktrees(
  gitDir: DirHandle,
  ownRepoRelative: string,
): Promise<Array<{ workingTreeAbsHint: string | null; mainGitDirHint: string }>> {
  const worktreesDir = await tryGetDir(gitDir, "worktrees");
  if (!worktreesDir) return [];
  const out: Array<{ workingTreeAbsHint: string | null; mainGitDirHint: string }> = [];
  for (const child of await listDirChildren(worktreesDir)) {
    const gitdirFile = await readFileText(child.handle, "gitdir");
    if (!gitdirFile) continue;
    const workingTreeGitfile = gitdirFile.trim();
    // workingTreeGitfile is the absolute path to the .git FILE inside
    // the worktree's working tree. The working tree itself is its
    // parent. We surface it as a hint; we can't resolve it through FSA.
    const workingTreeAbs = workingTreeGitfile.replace(/\/\.git$/, "") || null;
    out.push({
      workingTreeAbsHint: workingTreeAbs,
      mainGitDirHint: ownRepoRelative,
    });
  }
  return out;
}

export type ScanOptions = {
  maxDepth?: number;
  signal?: AbortSignal;
};

/**
 * Walk a `FileSystemDirectoryHandle` BFS, finding repos / worktrees /
 * bare repos. Returns a flat list with relative paths from the root.
 */
export async function scanFolder(
  root: FileSystemDirectoryHandle,
  opts: ScanOptions = {},
): Promise<FolderScanResult> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const entries: ScannedEntry[] = [];
  const warnings: ScanWarning[] = [];

  type QueueItem = { handle: DirHandle; rel: string; depth: number };
  const queue: QueueItem[] = [{ handle: root, rel: "", depth: 0 }];

  while (queue.length > 0) {
    if (opts.signal?.aborted) {
      warnings.push({ path: "", reason: "scan aborted" });
      break;
    }

    const next = queue.shift();
    if (!next) break;
    const { handle, rel, depth } = next;

    // 1) Is THIS directory a worktree (has `.git` as a FILE)?
    const gitFileTarget = await readGitFileTarget(handle);
    if (gitFileTarget) {
      const meta = await readGitMeta(handle).catch(() => ({ originUrl: null, head: null }));
      const mainHint = resolveMainGitDirHint(gitFileTarget);
      entries.push({
        kind: "worktree",
        relativePath: rel,
        gitFileTarget,
        mainGitDirHint: mainHint,
        originUrl: meta.originUrl,
        head: meta.head,
      });
      continue;
    }

    // 2) Is THIS directory a normal repo (`.git` as a DIRECTORY)?
    const gitDir = await tryGetDir(handle, ".git");
    if (gitDir) {
      const meta = await readGitMeta(gitDir).catch(() => ({ originUrl: null, head: null }));
      const gitDirRel = rel ? `${rel}/.git` : ".git";
      entries.push({
        kind: "repo",
        relativePath: rel,
        gitDirRelativePath: gitDirRel,
        originUrl: meta.originUrl,
        head: meta.head,
      });

      // Linked-worktree discovery is best-effort; non-fatal.
      try {
        await discoverLinkedWorktrees(gitDir, gitDirRel);
      } catch {
        /* ignore */
      }

      // Also peek for sibling/child `.worktrees/` and `worktrees/` dirs
      // that might contain working-tree dirs with their own `.git` file.
      // We DO descend those even though we just hit a repo (depth budget
      // permitting), because the user explicitly mentioned this layout.
      if (depth + 1 <= maxDepth) {
        for (const dotName of [".worktrees", "worktrees"]) {
          const sub = await tryGetDir(handle, dotName);
          if (!sub) continue;
          for (const child of await listDirChildren(sub)) {
            queue.push({
              handle: child.handle,
              rel: rel ? `${rel}/${dotName}/${child.name}` : `${dotName}/${child.name}`,
              depth: depth + 2,
            });
          }
        }
      }

      continue; // do not descend into a regular repo's working tree
    }

    // 3) Bare repo at this level?
    if (rel !== "" && (await looksLikeBareRepo(handle))) {
      const meta = await readGitMeta(handle).catch(() => ({ originUrl: null, head: null }));
      entries.push({
        kind: "bare",
        relativePath: rel,
        originUrl: meta.originUrl,
        head: meta.head,
      });
      continue; // do not descend into a bare repo
    }

    // 4) Otherwise, descend if budget allows.
    if (depth >= maxDepth) {
      continue;
    }

    let children: Array<{ name: string; handle: DirHandle }>;
    try {
      children = await listDirChildren(handle);
    } catch (err) {
      warnings.push({
        path: rel || ".",
        reason: `failed to list children: ${(err as Error).message ?? err}`,
      });
      continue;
    }

    for (const child of children) {
      if (SKIP_DIRS.has(child.name)) continue;
      if (child.name.startsWith(".") && !ALLOWED_DOTDIRS.has(child.name)) continue;
      queue.push({
        handle: child.handle,
        rel: rel ? `${rel}/${child.name}` : child.name,
        depth: depth + 1,
      });
    }
  }

  return { entries, warnings };
}

/**
 * Stitch worktree entries to their main repo entries (within the same
 * scan result). Returns a mapping
 * `worktreeRelativePath -> mainRepoRelativePath`.
 *
 * We can't do absolute-path resolution because FSA doesn't expose
 * absolute paths. Heuristic:
 *
 *   1. For each worktree entry, take `mainGitDirHint`. If it ends with
 *      a path segment that matches a repo's `relativePath/.git`, we
 *      have a match.
 *   2. As a weaker fallback: same `originUrl` and the worktree's path
 *      is a sibling/child of the repo's path.
 */

/**
 * Path-boundary aware suffix match. `hint.endsWith(repoGit)` alone
 * permits a substring tail match, e.g. `/abs/other-main-repo/.git`
 * vs `main-repo/.git`. We require that the character immediately
 * before the matched suffix is either the start-of-string or a path
 * separator, so the suffix aligns with a real path component.
 *
 * Exported only for test access.
 */
export function hintMatchesRepoGit(hint: string, repoGit: string): boolean {
  if (!hint.endsWith(repoGit)) return false;
  const startIdx = hint.length - repoGit.length;
  return startIdx === 0 || hint[startIdx - 1] === "/";
}

export function stitchWorktrees(
  entries: ScannedEntry[],
): Map<string, string /* main repo relativePath */> {
  const repoByRel = new Map<string, ScannedEntry & { kind: "repo" }>();
  for (const e of entries) {
    if (e.kind === "repo") repoByRel.set(e.relativePath, e);
  }

  const result = new Map<string, string>();
  for (const e of entries) {
    if (e.kind !== "worktree") continue;
    let matched: string | null = null;

    // Strategy 1: hint suffix match.
    //
    // We want the hint's path to END at a path-boundary aligned with
    // the repo's relative path — NOT a substring suffix. Plain
    // `.endsWith(repoGit)` would falsely match `/abs/other-main-repo/.git`
    // against the repo `main-repo` (because `other-main-repo/.git` ends
    // with `main-repo/.git`). Caught in PR #51 review.
    //
    // `hintMatchesRepoGit` enforces that the position immediately
    // before the matched suffix is either the start of the hint or a
    // path separator.
    if (e.mainGitDirHint) {
      const hint = e.mainGitDirHint;
      for (const [rel] of repoByRel) {
        const repoGit = rel ? `${rel}/.git` : ".git";
        if (hintMatchesRepoGit(hint, repoGit)) {
          matched = rel;
          break;
        }
      }
    }

    // Strategy 2: same origin URL + sibling path
    if (!matched && e.originUrl) {
      for (const [rel, repo] of repoByRel) {
        if (
          repo.originUrl &&
          repo.originUrl === e.originUrl &&
          // worktree is a sibling or child of the repo's parent
          (e.relativePath.startsWith(rel + "/") ||
            rel.split("/").slice(0, -1).join("/") ===
              e.relativePath.split("/").slice(0, -1).join("/"))
        ) {
          matched = rel;
          break;
        }
      }
    }

    if (matched !== null) result.set(e.relativePath, matched);
  }

  return result;
}
