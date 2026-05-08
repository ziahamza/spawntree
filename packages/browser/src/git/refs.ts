/**
 * Resolve a ref name (branch, tag, packed ref, or sha) to a 40-char
 * SHA-1 by reading directly from the on-disk ref structure.
 *
 * Lookup order:
 *
 *   1. `refs/remotes/origin/<ref>` — most likely place since GitHub
 *      base refs almost always come from origin.
 *   2. `refs/heads/<ref>` — local branch fallback.
 *   3. `refs/tags/<ref>` — tags.
 *   4. `packed-refs` — large repos pack refs together.
 *   5. As a last resort, isomorphic-git's `resolveRef` (handles a few
 *      extra cases like `ORIG_HEAD`, abbreviated names, etc.).
 *
 * Returns null when nothing matches; the caller can then attempt a
 * fetch via `tryFetchPack`.
 */
import git from "isomorphic-git";
import type { IsoFs } from "../fsa/fs-adapter.ts";

const SHA_RE = /^[0-9a-f]{40}$/i;

export type ResolveOptions = {
  fs: IsoFs;
  /** gitdir path relative to FS root, e.g. `/foo/.git` or `/.git`. */
  gitdir: string;
};

async function readRefFile(fs: IsoFs, gitdir: string, refPath: string): Promise<string | null> {
  try {
    const text = (await fs.promises.readFile(`${gitdir}/${refPath}`, "utf8")) as string;
    const trimmed = text.trim();
    if (SHA_RE.test(trimmed)) return trimmed.toLowerCase();
    // Symbolic ref `ref: refs/heads/foo` — recurse once.
    const m = trimmed.match(/^ref:\s*(.+)$/);
    if (m && m[1]) return readRefFile(fs, gitdir, m[1].trim());
    return null;
  } catch {
    return null;
  }
}

async function readPackedRef(fs: IsoFs, gitdir: string, refPath: string): Promise<string | null> {
  try {
    const text = (await fs.promises.readFile(`${gitdir}/packed-refs`, "utf8")) as string;
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const idx = line.indexOf(" ");
      if (idx < 0) continue;
      const sha = line.slice(0, idx).trim();
      const name = line.slice(idx + 1).trim();
      if (name === refPath && SHA_RE.test(sha)) return sha.toLowerCase();
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveRefSha(opts: ResolveOptions, ref: string): Promise<string | null> {
  const { fs, gitdir } = opts;
  // Already a sha?
  if (SHA_RE.test(ref)) return ref.toLowerCase();

  // Try common ref locations.
  const candidates = [`refs/remotes/origin/${ref}`, `refs/heads/${ref}`, `refs/tags/${ref}`];

  for (const c of candidates) {
    const sha = await readRefFile(fs, gitdir, c);
    if (sha) return sha;
  }

  for (const c of candidates) {
    const sha = await readPackedRef(fs, gitdir, c);
    if (sha) return sha;
  }

  // Last resort: isomorphic-git's resolveRef.
  try {
    const resolved = await git.resolveRef({
      fs: fs as unknown as Parameters<typeof git.resolveRef>[0]["fs"],
      gitdir,
      ref,
    });
    if (SHA_RE.test(resolved)) return resolved.toLowerCase();
  } catch {
    /* fall through */
  }
  return null;
}
