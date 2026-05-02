/**
 * Resolve the effective base sha for a PR-style diff.
 *
 * Naïve `baseSha..headSha` is wrong when `baseSha` has advanced past
 * the branch point (always true for merged PRs, sometimes true for
 * open PRs when base has had new commits). GitHub's PR diff uses the
 * merge base — `mergeBase(base, head)..head` — which is what we want.
 *
 * Returns the merge base when found, falls back to the original
 * `baseSha` when no common ancestor exists (degenerate case — likely
 * missing objects, in which case the caller should trigger a fetch).
 */
import git from "isomorphic-git";
import type { IsoFs } from "../fsa/fs-adapter.ts";

const SHA_RE = /^[0-9a-f]{40}$/i;

export async function effectiveBaseSha(
  fs: IsoFs,
  gitdir: string,
  baseSha: string,
  headSha: string,
): Promise<string> {
  if (baseSha === headSha) return baseSha;
  try {
    const merged = await git.findMergeBase({
      fs: fs as unknown as Parameters<typeof git.findMergeBase>[0]["fs"],
      gitdir,
      oids: [baseSha, headSha],
    });
    const first = merged[0];
    if (typeof first === "string" && SHA_RE.test(first)) {
      return first;
    }
  } catch {
    // Unreachable bases / missing objects — fall through to baseSha.
  }
  return baseSha;
}
