/**
 * Compute a unified diff between two commit shas in a local git repo,
 * using isomorphic-git's tree walker (via `./walk`) and the `diff`
 * package for the actual line-level hunk generation.
 *
 * Output format matches what GitHub returns from
 * `Accept: application/vnd.github.diff` so the same parser/renderer
 * can consume both:
 *
 *     diff --git a/<path> b/<path>
 *     <similarity / mode lines if applicable>
 *     index <baseSha7>..<headSha7> <mode>
 *     --- a/<path>
 *     +++ b/<path>
 *     @@ -<a>,<b> +<c>,<d> @@
 *     <hunk lines>
 *
 * Binary files are emitted as `Binary files differ` (matching git).
 */

import { createPatch } from "diff";
import type { IsoFs } from "../fsa/fs-adapter.ts";
import { effectiveBaseSha } from "./merge-base.ts";
import { readBlob } from "./read.ts";
import { collectChanges, type ChangedFile } from "./walk.ts";

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

const MAX_TOTAL_BLOB_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_FILES = 5_000;

export type ComputeDiffOptions = {
  fs: IsoFs;
  gitdir: string;
  baseSha: string;
  headSha: string;
};

export type ComputeDiffResult =
  | { ok: true; unifiedDiff: string; effectiveBase: string }
  | { ok: false; reason: "too-large" | "missing-object" | "unknown"; details?: string };

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function isBinary(buf: Uint8Array): boolean {
  // Standard heuristic: presence of NUL byte in the first 8KB.
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function decodeText(buf: Uint8Array): string | null {
  if (isBinary(buf)) return null;
  return TEXT_DECODER.decode(buf);
}

function fmtMode(m: string): string {
  // Pad/normalise a mode string to git's 6-digit form.
  return m.padStart(6, "0").slice(-6);
}

/**
 * Build a single file's section of a unified diff. Mirrors the format
 * that `git diff` (and GitHub) emits.
 */
function buildFileDiff(
  change: ChangedFile,
  baseText: string | null,
  headText: string | null,
): string {
  const path = change.path;
  const header: string[] = [];
  header.push(`diff --git a/${path} b/${path}`);

  if (change.kind === "add") {
    header.push(`new file mode ${fmtMode(change.mode)}`);
    header.push(`index 0000000..${shortSha(change.headOid)}`);
    header.push(`--- /dev/null`);
    header.push(`+++ b/${path}`);
  } else if (change.kind === "delete") {
    header.push(`deleted file mode ${fmtMode(change.mode)}`);
    header.push(`index ${shortSha(change.baseOid)}..0000000`);
    header.push(`--- a/${path}`);
    header.push(`+++ /dev/null`);
  } else {
    if (change.baseMode !== change.headMode) {
      header.push(`old mode ${fmtMode(change.baseMode)}`);
      header.push(`new mode ${fmtMode(change.headMode)}`);
    }
    header.push(
      `index ${shortSha(change.baseOid)}..${shortSha(change.headOid)} ${fmtMode(change.headMode)}`,
    );
    header.push(`--- a/${path}`);
    header.push(`+++ b/${path}`);
  }

  // Binary?
  if (baseText === null && headText === null) {
    header.push(`Binary files differ`);
    return header.join("\n") + "\n";
  }
  if (baseText === null || headText === null) {
    header.push(`Binary files differ`);
    return header.join("\n") + "\n";
  }

  // Build hunks using the `diff` package. createPatch returns a full
  // patch including its own --- / +++ header lines. We strip those
  // (we already wrote our own).
  const patch = createPatch(path, baseText, headText, "", "", { context: 3 });
  const lines = patch.split("\n");
  // Skip lines until the first hunk (`@@`) — the diff package emits
  // an "Index: ..." header and our own --- / +++ that we don't want.
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
  const body = firstHunk >= 0 ? lines.slice(firstHunk).join("\n") : "";
  if (!body.trim()) {
    // No textual change despite different OIDs (e.g. line-ending only
    // change with crlf normalisation) — emit just the header.
    return header.join("\n") + "\n";
  }
  return header.join("\n") + "\n" + body + (body.endsWith("\n") ? "" : "\n");
}

export async function computeDiff(opts: ComputeDiffOptions): Promise<ComputeDiffResult> {
  const { fs, gitdir, baseSha, headSha } = opts;
  // GitHub PR diffs are merge-base..head, not base..head. When base has
  // moved past the branch point (always true for merged PRs), the naïve
  // diff includes unrelated changes — we explicitly use the merge base.
  const effectiveBase = await effectiveBaseSha(fs, gitdir, baseSha, headSha);
  let changes: ChangedFile[];
  try {
    changes = await collectChanges(fs, gitdir, effectiveBase, headSha);
  } catch (err) {
    return { ok: false, reason: "missing-object", details: (err as Error).message ?? String(err) };
  }

  if (changes.length > MAX_FILES) {
    return { ok: false, reason: "too-large", details: `${changes.length} files exceeds limit` };
  }

  // Stable order: alphabetical by path (matches `git diff` default).
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  let totalBytes = 0;
  const out: string[] = [];
  for (const change of changes) {
    let baseText: string | null = null;
    let headText: string | null = null;
    if (change.kind !== "add") {
      const buf = await readBlob({ fs, gitdir }, (change as { baseOid: string }).baseOid);
      if (buf) {
        totalBytes += buf.byteLength;
        baseText = decodeText(buf);
      }
    }
    if (change.kind !== "delete") {
      const buf = await readBlob({ fs, gitdir }, (change as { headOid: string }).headOid);
      if (buf) {
        totalBytes += buf.byteLength;
        headText = decodeText(buf);
      }
    }
    if (totalBytes > MAX_TOTAL_BLOB_BYTES) {
      return { ok: false, reason: "too-large", details: `>${MAX_TOTAL_BLOB_BYTES} bytes` };
    }
    out.push(buildFileDiff(change, baseText, headText));
  }

  return { ok: true, unifiedDiff: out.join(""), effectiveBase };
}
