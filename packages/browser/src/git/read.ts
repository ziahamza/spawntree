/**
 * Thin wrappers around isomorphic-git's object-store reads.
 *
 * Pulled out as their own module so the diff path doesn't need to
 * import the larger ref-resolver or the fetcher just to ask "is this
 * sha present locally?".
 */
import git from "isomorphic-git";
import type { IsoFs } from "../fsa/fs-adapter.ts";

const SHA_RE = /^[0-9a-f]{40}$/i;

export type ReadOptions = {
  fs: IsoFs;
  gitdir: string;
};

/**
 * Cheap presence check for a sha in the object DB.
 *
 * Tries the loose-object path first (`.git/objects/<2>/<38>`), then
 * falls back to `git.readObject` which transparently consults pack
 * indexes. Returns `true` when the object exists in any form.
 */
export async function hasObject(opts: ReadOptions, sha: string): Promise<boolean> {
  if (!SHA_RE.test(sha)) return false;
  const { fs, gitdir } = opts;
  const lower = sha.toLowerCase();
  // Loose object: .git/objects/<2>/<38>
  try {
    await fs.promises.stat(`${gitdir}/objects/${lower.slice(0, 2)}/${lower.slice(2)}`);
    return true;
  } catch {
    /* not loose */
  }
  // Pack: scan all .idx files in objects/pack/. We use isomorphic-git's
  // readObject which transparently consults pack indexes.
  try {
    await git.readObject({
      fs: fs as unknown as Parameters<typeof git.readObject>[0]["fs"],
      gitdir,
      oid: lower,
      format: "content",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a blob's bytes by oid. Returns `null` on any error (missing,
 * not a blob, etc.) — the caller's responsibility to interpret.
 */
export async function readBlob(opts: ReadOptions, oid: string): Promise<Uint8Array | null> {
  const { fs, gitdir } = opts;
  try {
    const obj = await git.readBlob({
      fs: fs as unknown as Parameters<typeof git.readBlob>[0]["fs"],
      gitdir,
      oid,
    });
    return obj.blob;
  } catch {
    return null;
  }
}
