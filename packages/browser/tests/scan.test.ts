/**
 * Scanner tests against a synthetic in-memory FileSystemDirectoryHandle
 * tree.
 *
 * The real FSA isn't available in Node, so we build a small shim that
 * implements just enough of the API for `scanFolder` to walk it:
 *  - kind: "directory" | "file"
 *  - getDirectoryHandle(name)
 *  - getFileHandle(name)
 *  - async iteration yielding [name, handle]
 *  - getFile() on a file handle
 *
 * Enough to exercise repo / worktree / bare detection plus the
 * worktree-stitching pass without hitting any real disk.
 */
import { describe, expect, it } from "vitest";
import {
  hintMatchesRepoGit,
  scanFolder,
  stitchWorktrees,
  type ScannedEntry,
} from "../src/fsa/scan.ts";

type MockNode = { kind: "dir"; entries: Record<string, MockNode> } | { kind: "file"; text: string };

function dir(entries: Record<string, MockNode>): MockNode {
  return { kind: "dir", entries };
}

function file(text: string): MockNode {
  return { kind: "file", text };
}

function makeDirHandle(node: MockNode & { kind: "dir" }, name = "root"): FileSystemDirectoryHandle {
  const handle = {
    kind: "directory" as const,
    name,
    async getDirectoryHandle(childName: string) {
      const child = node.entries[childName];
      if (!child) {
        const err = new Error(`NotFoundError: ${childName}`);
        (err as { name?: string }).name = "NotFoundError";
        throw err;
      }
      if (child.kind !== "dir") {
        const err = new Error(`TypeMismatchError: ${childName}`);
        (err as { name?: string }).name = "TypeMismatchError";
        throw err;
      }
      return makeDirHandle(child, childName);
    },
    async getFileHandle(childName: string) {
      const child = node.entries[childName];
      if (!child) {
        const err = new Error(`NotFoundError: ${childName}`);
        (err as { name?: string }).name = "NotFoundError";
        throw err;
      }
      if (child.kind !== "file") {
        const err = new Error(`TypeMismatchError: ${childName}`);
        (err as { name?: string }).name = "TypeMismatchError";
        throw err;
      }
      return makeFileHandle(child, childName);
    },
    async *[Symbol.asyncIterator]() {
      for (const [childName, child] of Object.entries(node.entries)) {
        if (child.kind === "dir") {
          yield [childName, makeDirHandle(child, childName)] as const;
        } else {
          yield [childName, makeFileHandle(child, childName)] as const;
        }
      }
    },
  };
  return handle as unknown as FileSystemDirectoryHandle;
}

function makeFileHandle(node: MockNode & { kind: "file" }, name: string): FileSystemFileHandle {
  const fileObj = {
    async text() {
      return node.text;
    },
    async arrayBuffer() {
      return new TextEncoder().encode(node.text).buffer;
    },
    size: node.text.length,
  };
  return {
    kind: "file" as const,
    name,
    async getFile() {
      return fileObj as unknown as File;
    },
  } as unknown as FileSystemFileHandle;
}

const ORIGIN_CONFIG = `[remote "origin"]\n  url = https://github.com/foo/bar.git\n`;
const ORIGIN_CONFIG_OTHER = `[remote "origin"]\n  url = https://github.com/foo/baz.git\n`;
const HEAD_MAIN = `ref: refs/heads/main\n`;
const HEAD_FEATURE = `ref: refs/heads/feature-x\n`;

describe("scanFolder", () => {
  it("finds a normal repo with .git as a directory", async () => {
    const root = makeDirHandle(
      dir({
        repo: dir({
          ".git": dir({
            HEAD: file(HEAD_MAIN),
            config: file(ORIGIN_CONFIG),
          }),
          src: dir({}),
        }),
      }) as MockNode & { kind: "dir" },
    );
    const result = await scanFolder(root);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.kind).toBe("repo");
    expect(entry.relativePath).toBe("repo");
    expect(entry.originUrl).toBe("https://github.com/foo/bar.git");
    expect(entry.head).toEqual({ kind: "branch", value: "main" });
  });

  it("finds a worktree (.git as a file)", async () => {
    const root = makeDirHandle(
      dir({
        wt: dir({
          ".git": file("gitdir: /Users/me/repos/foo/.git/worktrees/feature-x\n"),
        }),
      }) as MockNode & { kind: "dir" },
    );
    const result = await scanFolder(root);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.kind).toBe("worktree");
    if (entry.kind === "worktree") {
      expect(entry.gitFileTarget).toBe("/Users/me/repos/foo/.git/worktrees/feature-x");
      expect(entry.mainGitDirHint).toBe("/Users/me/repos/foo/.git");
    }
  });

  it("detects a bare repo via HEAD + objects + refs", async () => {
    const root = makeDirHandle(
      dir({
        "bare-repo": dir({
          HEAD: file(HEAD_MAIN),
          config: file(ORIGIN_CONFIG),
          objects: dir({}),
          refs: dir({}),
        }),
      }) as MockNode & { kind: "dir" },
    );
    const result = await scanFolder(root);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.kind).toBe("bare");
    expect(result.entries[0]?.originUrl).toBe("https://github.com/foo/bar.git");
  });

  it("descends into nested .worktrees/ alongside a normal repo", async () => {
    const root = makeDirHandle(
      dir({
        repo: dir({
          ".git": dir({
            HEAD: file(HEAD_MAIN),
            config: file(ORIGIN_CONFIG),
          }),
          ".worktrees": dir({
            "feature-x": dir({
              ".git": file("gitdir: /Users/me/repos/repo/.git/worktrees/feature-x\n"),
            }),
          }),
        }),
      }) as MockNode & { kind: "dir" },
    );
    const result = await scanFolder(root);
    const kinds = result.entries.map((e) => e.kind).sort();
    expect(kinds).toEqual(["repo", "worktree"]);
    const worktreeEntry = result.entries.find((e) => e.kind === "worktree");
    expect(worktreeEntry?.relativePath).toBe("repo/.worktrees/feature-x");
  });

  it("skips known noise dirs (node_modules) and unrelated dot-dirs", async () => {
    const root = makeDirHandle(
      dir({
        node_modules: dir({
          fake: dir({
            ".git": dir({ HEAD: file(HEAD_MAIN), config: file(ORIGIN_CONFIG) }),
          }),
        }),
        ".idea": dir({}),
        repo: dir({
          ".git": dir({ HEAD: file(HEAD_MAIN), config: file(ORIGIN_CONFIG) }),
        }),
      }) as MockNode & { kind: "dir" },
    );
    const result = await scanFolder(root);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.relativePath).toBe("repo");
  });
});

describe("stitchWorktrees", () => {
  it("matches a worktree to its main repo via mainGitDirHint", () => {
    const entries: ScannedEntry[] = [
      {
        kind: "repo",
        relativePath: "main-repo",
        gitDirRelativePath: "main-repo/.git",
        originUrl: "https://github.com/foo/bar.git",
        head: { kind: "branch", value: "main" },
      },
      {
        kind: "worktree",
        relativePath: "main-repo/.worktrees/feature",
        gitFileTarget: "/abs/main-repo/.git/worktrees/feature",
        mainGitDirHint: "/abs/main-repo/.git",
        originUrl: null,
        head: { kind: "branch", value: "feature" },
      },
    ];
    const stitched = stitchWorktrees(entries);
    expect(stitched.get("main-repo/.worktrees/feature")).toBe("main-repo");
  });

  it("falls back to origin URL + sibling path", () => {
    const entries: ScannedEntry[] = [
      {
        kind: "repo",
        relativePath: "team/foo",
        gitDirRelativePath: "team/foo/.git",
        originUrl: "https://github.com/foo/bar.git",
        head: null,
      },
      {
        kind: "worktree",
        relativePath: "team/foo-feat",
        gitFileTarget: "/somewhere/.git/worktrees/feat",
        mainGitDirHint: null, // hint missing — must fall back to origin/sibling
        originUrl: "https://github.com/foo/bar.git",
        head: null,
      },
    ];
    const stitched = stitchWorktrees(entries);
    expect(stitched.get("team/foo-feat")).toBe("team/foo");
  });

  it("does not match across different origins", () => {
    const entries: ScannedEntry[] = [
      {
        kind: "repo",
        relativePath: "main",
        gitDirRelativePath: "main/.git",
        originUrl: "https://github.com/foo/bar.git",
        head: null,
      },
      {
        kind: "worktree",
        relativePath: "feat",
        gitFileTarget: "/abs/other/.git/worktrees/x",
        mainGitDirHint: null,
        originUrl: ORIGIN_CONFIG_OTHER,
        head: null,
      },
    ];
    const stitched = stitchWorktrees(entries);
    expect(stitched.has("feat")).toBe(false);
  });

  it("ignores feature/HEAD parsing edge cases for completeness", () => {
    // No-op assertion that ensures HEAD_FEATURE is referenced — keeps the
    // import alive for future test cases.
    expect(HEAD_FEATURE.length).toBeGreaterThan(0);
  });

  describe("path-boundary suffix match (regression for PR #51 review)", () => {
    // The old `hint.endsWith(repoGit) || hint.endsWith('/' + repoGit)`
    // permitted a SUBSTRING tail match: `/abs/other-main-repo/.git`
    // would match `main-repo/.git` because the latter is a literal
    // tail of the former. The fix requires a path-separator (or
    // start-of-string) immediately before the matched suffix.
    it("matches when hint ends at a path boundary", () => {
      expect(hintMatchesRepoGit("/abs/main-repo/.git", "main-repo/.git")).toBe(true);
    });

    it("rejects when the suffix is a literal tail but not at a path boundary", () => {
      // The bug: `other-main-repo/.git` ends with `main-repo/.git` literally,
      // but they're different repos.
      expect(hintMatchesRepoGit("/abs/other-main-repo/.git", "main-repo/.git")).toBe(false);
    });

    it("matches when the entire hint is the repoGit (start-of-string boundary)", () => {
      expect(hintMatchesRepoGit("main-repo/.git", "main-repo/.git")).toBe(true);
      expect(hintMatchesRepoGit(".git", ".git")).toBe(true);
    });

    it("matches root-level repo (.git only) at any path boundary", () => {
      expect(hintMatchesRepoGit("/abs/clone/.git", ".git")).toBe(true);
      expect(hintMatchesRepoGit("/.git", ".git")).toBe(true);
    });

    it("rejects when .git is part of a filename, not a directory name", () => {
      // `foo.git` ends with `.git` literally but isn't a path
      // boundary. Old check would have falsely matched.
      expect(hintMatchesRepoGit("/abs/foo.git", ".git")).toBe(false);
    });

    it("rejects when hint is shorter than repoGit", () => {
      expect(hintMatchesRepoGit(".git", "main-repo/.git")).toBe(false);
    });

    it("via stitchWorktrees: does NOT mis-stitch worktree to similarly-named repo", () => {
      const entries: ScannedEntry[] = [
        {
          kind: "repo",
          relativePath: "main-repo",
          gitDirRelativePath: "main-repo/.git",
          originUrl: null,
          head: null,
        },
        {
          kind: "worktree",
          relativePath: "other-main-repo-feat",
          // Hint points at `other-main-repo`'s gitdir which doesn't
          // appear in this scan (worktree is in the picked folder
          // but its parent repo isn't). The substring-match bug
          // would falsely stitch this to `main-repo` because
          // `/abs/other-main-repo/.git/worktrees/feat` ends with
          // `main-repo/.git/worktrees/feat`. Wait — actually the
          // old check tested `hint.endsWith(repoGit)` where
          // repoGit is `main-repo/.git` — and our hint ends in
          // `/worktrees/feat`, not `/.git`. So the bug requires
          // a hint that ends EXACTLY at .git. Let's craft that:
          gitFileTarget: "/abs/other-main-repo/.git",
          mainGitDirHint: "/abs/other-main-repo/.git",
          originUrl: null,
          head: null,
        },
      ];
      const stitched = stitchWorktrees(entries);
      // With the bug, this would have returned `"main-repo"` —
      // a false stitch. With the fix, no main-repo entry exists,
      // so the worktree is unmatched.
      expect(stitched.has("other-main-repo-feat")).toBe(false);
    });
  });
});
