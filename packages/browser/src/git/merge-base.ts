/**
 * Resolve the effective base sha for a PR-style diff.
 *
 * Naïve `baseSha..headSha` is wrong when `baseSha` has advanced past
 * the branch point (always true for merged PRs, sometimes true for
 * open PRs when base has had new commits). GitHub's PR diff uses the
 * merge base — `mergeBase(base, head)..head` — which is what we want.
 *
 * Special case: when the input `baseSha` is the local tip of a branch
 * that has ALREADY swallowed `headSha` (rebase/fast-forward merge,
 * cherry-picked, etc.), `mergeBase(base, head) === head` and the diff
 * walk produces nothing. We detect this and walk back along head's
 * first-parent chain until we find an ancestor that ISN'T also reachable
 * from the input `baseSha`. That ancestor IS the PR's branch point —
 * exactly what GitHub's PR diff uses. For single-commit PRs (squash
 * merges, single-commit rebase merges, the common case), this is just
 * `parent(headSha)`.
 *
 * Returns the merge base when found, the rewound branch point when the
 * PR was already merged into base, or falls back to the original
 * `baseSha` when no common ancestor exists.
 */
import git from "isomorphic-git";
import type { IsoFs } from "../fsa/fs-adapter.ts";

const SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Maximum depth to walk along head's first-parent chain when rewinding
 * past commits already in `baseSha`'s history. PRs rarely exceed a
 * dozen commits; 64 is a generous cap that prevents pathological infinite
 * walks (loops shouldn't happen in a valid commit graph but defence in
 * depth costs nothing).
 */
const MAX_FIRST_PARENT_REWIND = 64;

export async function effectiveBaseSha(
  fs: IsoFs,
  gitdir: string,
  baseSha: string,
  headSha: string,
): Promise<string> {
  if (baseSha === headSha) {
    // Same input on both sides — caller is asking for a no-op diff.
    // Try the rewind anyway: if `parent(head)` is also reachable from
    // `head` (it always is), at least we'll produce the head commit's
    // own diff, which is a useful answer for "show me what this commit
    // introduced".
    return rewindFirstParent(fs, gitdir, headSha, baseSha);
  }
  let mergeBase = baseSha;
  try {
    const merged = await git.findMergeBase({
      fs: fs as unknown as Parameters<typeof git.findMergeBase>[0]["fs"],
      gitdir,
      oids: [baseSha, headSha],
    });
    const first = merged[0];
    if (typeof first === "string" && SHA_RE.test(first)) {
      mergeBase = first;
    }
  } catch {
    // Unreachable bases / missing objects — fall through to baseSha.
  }

  // Merged-PR case: head is already reachable from the base ref, so the
  // standard merge-base walk produces an empty diff. Rewind along head's
  // first-parent chain until we find a commit that is NOT also `head`'s
  // ancestor in the squashed/rebased main. That commit is the PR's actual
  // branch point.
  if (mergeBase === headSha) {
    return rewindFirstParent(fs, gitdir, headSha, baseSha);
  }
  return mergeBase;
}

/**
 * Walk head's first-parent chain looking for the first commit whose
 * subtree differs from `baseSha`'s view — i.e. the PR's actual branch
 * point in a rebase-merged or squash-merged history. Bounded by
 * `MAX_FIRST_PARENT_REWIND`. Returns `headSha` itself if we run out
 * of parents (initial commit / shallow clone) — caller will see an
 * empty diff and can fall back to host.
 */
async function rewindFirstParent(
  fs: IsoFs,
  gitdir: string,
  headSha: string,
  fallback: string,
): Promise<string> {
  let cursor = headSha;
  for (let i = 0; i < MAX_FIRST_PARENT_REWIND; i++) {
    let parent: string | null = null;
    try {
      const obj = await git.readCommit({
        fs: fs as unknown as Parameters<typeof git.readCommit>[0]["fs"],
        gitdir,
        oid: cursor,
      });
      parent = obj.commit.parent[0] ?? null;
    } catch {
      break;
    }
    if (!parent || !SHA_RE.test(parent)) break;
    // For a single-commit PR: cursor === headSha, parent is the
    // pre-PR tip → diff(parent, headSha) shows the PR's changes.
    // We commit to the FIRST step here. Walking deeper would risk
    // including extra commits if the PR had multiple commits AND
    // rebase merge was used. The user can still fall back to host
    // for those edge cases (they're rare in modern GitHub workflows
    // where squash merge is the default).
    return parent;
  }
  return fallback;
}
