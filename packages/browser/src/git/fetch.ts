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
 * Two modes:
 *
 *   1. **Wants** — caller already has the SHA(s). Pass `wants: [sha]`,
 *      optionally with `headRef` to write a remote-tracking ref to that
 *      sha after the pack indexes.
 *   2. **RefNames** — caller only knows ref names (e.g. base ref hasn't
 *      been fetched locally yet). Pass `refNames: ["main"]` and an
 *      empty `wants`. The consumer's proxy resolves names → SHAs via
 *      `ls-refs` server-side and returns `{ pack, refs }`. We write
 *      each `refs/remotes/origin/<name>` locally so subsequent
 *      `resolveRefSha` calls find the new commits.
 *
 * Either mode (or both) must produce at least one fetchable target —
 * `wants` and `refNames` empty together is a programming error and
 * fails fast with `missing-object`.
 *
 * On success we write the pack into `.git/objects/pack/`, run
 * `git.indexPack`, and update remote-tracking refs. All writes use the
 * `fetchOnly` adapter mode that restricts writes to those locations.
 */

import git from "isomorphic-git";
import type { IsoFs } from "../fsa/fs-adapter.ts";
import type { FetchPackFn, FetchPackInput, FetchPackResult } from "../types.ts";

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
  /**
   * Object SHAs to fetch directly. Either this OR `refNames` must be
   * non-empty after filtering; passing both empty fails fast with
   * `missing-object`.
   */
  wants: string[];
  haves: string[];
  /**
   * Ref names to resolve + fetch via the consumer's proxy (`ls-refs` +
   * `upload-pack`). The proxy reports back the resolved SHAs in the
   * `{ pack, refs }` response shape; we use them to update local
   * remote-tracking refs.
   */
  refNames?: string[];
  /**
   * Optional ref name to write into refs/remotes/origin/ on success
   * when in wants-mode. Pointed at `wants[0]`. Ignored in refNames-mode
   * — the consumer's resolved `refs` map drives ref writes there.
   */
  headRef?: string;
  signal?: AbortSignal;
  fetchPack: FetchPackFn;
};

export type TryFetchPackResult =
  | { ok: true; bytes: number; resolvedRefs?: Record<string, string> }
  | {
      ok: false;
      reason: "no-network" | "auth" | "blocked" | "missing-object" | "unknown";
      details?: string;
    };

/**
 * Fetch a packfile and integrate it into the on-disk gitdir.
 */
export async function tryFetchPack(input: TryFetchPackInput): Promise<TryFetchPackResult> {
  const { fs, gitdir, cloneId, remoteUrl, wants, haves, refNames, headRef, fetchPack } = input;
  const filteredWants = wants.filter((w) => SHA_RE.test(w));
  // Ref names are user-supplied strings — defend against empty / null
  // entries so a misbehaving caller can't smuggle them through to the
  // consumer's proxy. `git check-ref-format` is too strict for our
  // purposes (doesn't allow `HEAD`, etc.); we just demand non-empty.
  const filteredRefNames = (refNames ?? []).filter((n) => typeof n === "string" && n.length > 0);
  if (filteredWants.length === 0 && filteredRefNames.length === 0) {
    return { ok: false, reason: "missing-object", details: "no valid wants or refNames" };
  }

  const callbackInput: FetchPackInput = {
    cloneId,
    remoteUrl,
    wants: filteredWants,
    haves: haves.filter((h) => SHA_RE.test(h)),
    ...(filteredRefNames.length > 0 ? { refNames: filteredRefNames } : {}),
  };

  let response: FetchPackResult;
  try {
    response = await fetchPack(callbackInput);
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

  // Normalise the two possible callback shapes (`Uint8Array` for
  // wants-only legacy mode; `{ pack, refs }` when the proxy resolved
  // refs server-side).
  let buffer: Uint8Array;
  let resolvedRefs: Record<string, string> = {};
  if (response instanceof Uint8Array) {
    buffer = response;
  } else if (response && typeof response === "object" && response.pack instanceof Uint8Array) {
    buffer = response.pack;
    if (response.refs) {
      // Defensive copy: filter out malformed entries so we don't
      // write garbage to refs/.
      for (const [name, sha] of Object.entries(response.refs)) {
        if (typeof name === "string" && name.length > 0 && SHA_RE.test(sha)) {
          resolvedRefs[name] = sha;
        }
      }
    }
  } else {
    return {
      ok: false,
      reason: "unknown",
      details: "fetchPack did not return Uint8Array or { pack, refs }",
    };
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

  // Update remote-tracking refs so `resolveRefSha` picks new commits
  // up next time. Two sources:
  //
  //   1. `resolvedRefs` from the consumer's `{ pack, refs }` response —
  //      one entry per ref the proxy resolved. Used in refNames-mode.
  //   2. `headRef` + `wants[0]` — the legacy wants-mode ref write where
  //      the caller already knew the SHA. Skipped if `headRef` is
  //      empty or wants is empty (sha-only fetch with no name to
  //      attach).
  //
  // Writes are best-effort: failures don't fail the whole operation,
  // because the objects ARE in the DB and can be resolved by sha
  // lookup.
  for (const [refName, sha] of Object.entries(resolvedRefs)) {
    await writeRemoteTrackingRef(fs, gitdir, refName, sha);
  }
  if (headRef && filteredWants.length > 0 && !resolvedRefs[headRef]) {
    await writeRemoteTrackingRef(fs, gitdir, headRef, filteredWants[0]!);
  }

  return {
    ok: true,
    bytes: packBuffer.byteLength,
    ...(Object.keys(resolvedRefs).length > 0 ? { resolvedRefs } : {}),
  };
}

/**
 * Best-effort write of `refs/remotes/origin/<refName>` → `<sha>`. The
 * fetched objects are in the loose store either way, so a write
 * failure here is a soft error — we just lose the ergonomic name
 * lookup.
 */
async function writeRemoteTrackingRef(
  fs: IsoFs,
  gitdir: string,
  refName: string,
  sha: string,
): Promise<void> {
  // Strip a leading `refs/heads/` if the consumer reported the
  // fully-qualified server-side ref name; we always store under
  // `refs/remotes/origin/`.
  const local = refName.startsWith("refs/heads/") ? refName.slice("refs/heads/".length) : refName;
  const refPath = `${gitdir}/refs/remotes/origin/${local}`;
  try {
    // Make sure intermediate dirs exist (e.g. `refs/remotes/origin/foo/bar`).
    const dir = refPath.slice(0, refPath.lastIndexOf("/"));
    await fs.promises.mkdir(dir, { recursive: true });
  } catch {
    /* mkdir is best-effort */
  }
  try {
    await fs.promises.writeFile(refPath, `${sha}\n`);
  } catch {
    // Soft-fail; consumer can still resolve by sha.
  }
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
