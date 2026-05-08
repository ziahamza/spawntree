/**
 * Validate-then-write `<repoPath>/spawntree.yaml` via the FSA handle.
 *
 * The write goes through the `configWrite` adapter mode, which permits
 * writes only to the exact `<relativePath>/spawntree.yaml` path inside
 * the wrapped directory handle. Any attempt to write elsewhere is
 * rejected at the adapter layer — this guards against a buggy code
 * path corrupting the working tree.
 *
 * Validation runs through spawntree-core's `parseConfig` +
 * `validateConfig` BEFORE the write. We refuse to persist YAML that
 * doesn't parse or validate, so the file on disk is always in a known
 * good state. Consumers that want to preserve a partially-valid draft
 * should keep their own buffer in memory.
 */
import { parseConfig, validateConfig } from "spawntree-core/browser";
import { createFsFromHandle } from "../fsa/fs-adapter.ts";
import type { ConfigWriteResult } from "../types.ts";
import { CONFIG_FILENAME } from "./read.ts";

export type WriteConfigInput = {
  handle: FileSystemDirectoryHandle;
  /** Relative path of the clone within the picked folder, "" for root. */
  relativePath: string;
  /** YAML text to validate and write. */
  yaml: string;
};

export async function writeConfigViaHandle(input: WriteConfigInput): Promise<ConfigWriteResult> {
  const { handle, relativePath, yaml } = input;
  const configPath = relativePath ? `/${relativePath}/${CONFIG_FILENAME}` : `/${CONFIG_FILENAME}`;

  // Validate before touching disk. Fail fast on parse and shape errors.
  let parsed: unknown;
  try {
    parsed = parseConfig(yaml, {});
  } catch (err) {
    return {
      ok: false,
      reason: "validation-failed",
      details: (err as Error).message ?? String(err),
    };
  }
  const validation = validateConfig(parsed);
  if ("errors" in validation) {
    return {
      ok: false,
      reason: "validation-failed",
      details: validation.errors.map((e) => `${e.path}: ${e.message}`).join("\n"),
    };
  }

  // Permission probe — `requestPermission({ mode: "readwrite" })` is
  // the user-facing prompt. We don't invoke it here; spawntree-browser
  // does that via `reattachFolder` before any write. If the underlying
  // FSA write throws, surface as `no-permission`.
  const fs = createFsFromHandle(handle, {
    mode: "configWrite",
    configWritePath: configPath,
  });
  try {
    await fs.promises.writeFile(configPath, yaml);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (/EACCES|permission|notallowed/i.test(message)) {
      return { ok: false, reason: "no-permission", details: message };
    }
    return { ok: false, reason: "unknown", details: message };
  }

  return {
    ok: true,
    path: configPath,
    bytesWritten: new TextEncoder().encode(yaml).byteLength,
  };
}
