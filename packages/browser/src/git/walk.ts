/**
 * Tree walker — diffs two commit shas and emits a flat list of file
 * changes (`add` / `delete` / `modify`).
 *
 * Pulled out of `diff.ts` so the walk and the diff renderer can be
 * tested and reused independently. Renames are NOT detected
 * (isomorphic-git doesn't expose rename detection via walk); they
 * appear as paired delete + add. The diff renderer handles both cases.
 */
import git from "isomorphic-git";
import type { IsoFs } from "../fsa/fs-adapter.ts";

export type ChangedFile =
  | { kind: "add"; path: string; headOid: string; mode: string }
  | { kind: "delete"; path: string; baseOid: string; mode: string }
  | {
      kind: "modify";
      path: string;
      baseOid: string;
      headOid: string;
      baseMode: string;
      headMode: string;
    };

/**
 * Walk the two trees and collect file-level changes. Uses
 * isomorphic-git's `walk` API with two TREE walkers and compares blob
 * OIDs at every leaf.
 */
export async function collectChanges(
  fs: IsoFs,
  gitdir: string,
  baseSha: string,
  headSha: string,
): Promise<ChangedFile[]> {
  const TREE = git.TREE;
  const changes: ChangedFile[] = [];

  await git.walk({
    fs: fs as unknown as Parameters<typeof git.walk>[0]["fs"],
    gitdir,
    trees: [TREE({ ref: baseSha }), TREE({ ref: headSha })],
    map: async (path, [base, head]) => {
      if (path === ".") return;
      const baseType = base ? await base.type() : null;
      const headType = head ? await head.type() : null;
      // Skip non-leaf walks for trees (we'll get individual blobs).
      if (baseType === "tree" || headType === "tree") return;
      const baseOid = base ? await base.oid() : null;
      const headOid = head ? await head.oid() : null;
      if (baseOid === headOid) return;
      const baseMode = base ? (await base.mode()).toString(8) : "100644";
      const headMode = head ? (await head.mode()).toString(8) : "100644";

      if (baseOid && !headOid) {
        changes.push({ kind: "delete", path, baseOid, mode: baseMode });
      } else if (!baseOid && headOid) {
        changes.push({ kind: "add", path, headOid, mode: headMode });
      } else if (baseOid && headOid) {
        changes.push({ kind: "modify", path, baseOid, headOid, baseMode, headMode });
      }
    },
  });

  return changes;
}
