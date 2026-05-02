/**
 * Fetch missing git objects via the consumer-supplied `fetchPack`
 * callback.
 *
 * The CORS limitation of GitHub's `git-upload-pack` endpoint means a
 * browser cannot call it directly. spawntree-browser punts on the
 * network entirely: the consumer (gitenv-studio, future spawntree-web)
 * provides a `fetchPack` callback that returns the raw pack bytes (no
 * pkt-line wrapping required, but tolerated). Where the pack comes
 * from is the consumer's problem — typically a CF Worker / host
 * endpoint that proxies upload-pack with auth.
 *
 * On success we write the pack into `.git/objects/pack/`, run
 * `git.indexPack`, and update `refs/remotes/origin/<headRef>` so
 * subsequent diffs can resolve the new commit. All writes use the
 * `fetchOnly` adapter mode that restricts writes to those locations.
 */

import git from "isomorphic-git";
import type { IsoFs } from "../fsa/fs-adapter.ts";
import type { FetchPackFn, FetchPackInput } from "../types.ts";

const SHA_RE = /^[0-9a-f]{40}$/i;

export type TryFetchPackInput = {
  fs: IsoFs;
  gitdir: string;
  /**
   * Identity of the clone we're fetching for — opaque to us, passed
   * straight through to `fetchPack` so the consumer can resolve auth.
   */
  cloneId: string;
  remoteUrl: string;
  wants: string[];
  haves: string[];
  /** Optional ref name to write into refs/remotes/origin/ on success. */
  headRef?: string;
  signal?: AbortSignal;
  fetchPack: FetchPackFn;
};

export type TryFetchPackResult =
  | { ok: true; bytes: number }
  | {
      ok: false;
      reason: "no-network" | "auth" | "blocked" | "missing-object" | "unknown";
      details?: string;
    };

/**
 * Fetch a packfile and integrate it into the on-disk gitdir.
 */
export async function tryFetchPack(input: TryFetchPackInput): Promise<TryFetchPackResult> {
  const { fs, gitdir, cloneId, remoteUrl, wants, haves, headRef, fetchPack } = input;
  const filteredWants = wants.filter((w) => SHA_RE.test(w));
  if (filteredWants.length === 0) {
    return { ok: false, reason: "missing-object", details: "no valid wants" };
  }

  const callbackInput: FetchPackInput = {
    cloneId,
    remoteUrl,
    wants: filteredWants,
    haves: haves.filter((h) => SHA_RE.test(h)),
  };

  let buffer: Uint8Array;
  try {
    buffer = await fetchPack(callbackInput);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // Distinguish auth-style failures from generic network noise so the
    // consumer's chip / error UI can react appropriately.
    if (/401|403|auth|permission/i.test(message)) {
      return { ok: false, reason: "auth", details: message };
    }
    if (/404|missing|not found/i.test(message)) {
      return { ok: false, reason: "missing-object", details: message };
    }
    return { ok: false, reason: "no-network", details: message };
  }

  if (!(buffer instanceof Uint8Array)) {
    return { ok: false, reason: "unknown", details: "fetchPack did not return Uint8Array" };
  }

  // Strip pkt-line wrapping if present — the proxy may return either
  // the raw pack body or the upload-pack response wrapper. Look for
  // `PACK` magic and slice from there.
  const packStart = findPackStart(buffer);
  if (packStart < 0) {
    return { ok: false, reason: "unknown", details: "PACK magic not found in response" };
  }
  const packBuffer = packStart === 0 ? buffer : buffer.slice(packStart);

  // Write to a deterministic temp filename inside .git/objects/pack/,
  // then ask isomorphic-git to index it. `indexPack` writes the
  // matching `.idx` file alongside.
  const packName = `pack-incoming-${Date.now()}.pack`;
  const packPath = `${gitdir}/objects/pack/${packName}`;
  try {
    await fs.promises.mkdir(`${gitdir}/objects/pack`, { recursive: true });
  } catch {
    /* mkdir is best-effort; readFile/stat will report real failures */
  }
  try {
    await fs.promises.writeFile(packPath, packBuffer);
  } catch (err) {
    return { ok: false, reason: "blocked", details: (err as Error).message ?? String(err) };
  }

  try {
    await git.indexPack({
      fs: fs as unknown as Parameters<typeof git.indexPack>[0]["fs"],
      // isomorphic-git's indexPack requires both `dir` (working tree)
      // and `gitdir`. We use the gitdir for both since we never touch
      // the working tree on the fetch path.
      dir: gitdir,
      gitdir,
      filepath: `objects/pack/${packName}`,
    });
  } catch (err) {
    return { ok: false, reason: "unknown", details: (err as Error).message ?? String(err) };
  }

  // Update the remote-tracking ref so resolveRefSha picks the new
  // commit up next time. We point it at the first want — the head sha
  // the caller asked for. If headRef is omitted we skip the ref write
  // (the object is now in the DB and can be resolved by sha lookup).
  if (headRef) {
    const refPath = `${gitdir}/refs/remotes/origin/${headRef}`;
    try {
      await fs.promises.writeFile(refPath, `${filteredWants[0]}\n`);
    } catch {
      // Ref-write failure is non-fatal — diff lookup uses the sha directly.
    }
  }

  return { ok: true, bytes: packBuffer.byteLength };
}

function findPackStart(buf: Uint8Array): number {
  // ASCII "PACK" = 0x50 0x41 0x43 0x4B
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x41 && buf[i + 2] === 0x43 && buf[i + 3] === 0x4b) {
      return i;
    }
  }
  return -1;
}
