/**
 * Read `<repoPath>/spawntree.yaml` via the FSA handle for an FSA-mode
 * clone, parse it through spawntree-core's parser + validator, and
 * surface a structured result.
 *
 * This module is browser-only — it reads through the FS adapter, so
 * it doesn't depend on any Node fs APIs. Any errors get folded into
 * the `ConfigReadResult` discriminated union so consumers can render
 * a useful message without try/catch.
 */
import { parseConfig, validateConfig, type SpawntreeConfig } from "spawntree-core/browser";
import { createFsFromHandle } from "../fsa/fs-adapter.ts";
import type { ConfigReadResult } from "../types.ts";

export const CONFIG_FILENAME = "spawntree.yaml";

export type ReadConfigInput = {
  handle: FileSystemDirectoryHandle;
  /** Relative path of the clone within the picked folder, "" for root. */
  relativePath: string;
};

export async function readConfigFromHandle(input: ReadConfigInput): Promise<ConfigReadResult> {
  const { handle, relativePath } = input;
  const configPath = relativePath ? `/${relativePath}/${CONFIG_FILENAME}` : `/${CONFIG_FILENAME}`;

  const fs = createFsFromHandle(handle, "readonly");
  let yaml: string;
  try {
    yaml = (await fs.promises.readFile(configPath, "utf8")) as string;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { ok: false, reason: "no-config" };
    }
    return {
      ok: false,
      reason: "unknown",
      details: (err as Error).message ?? String(err),
    };
  }

  let parsed: SpawntreeConfig;
  try {
    // No env substitution available client-side (no `process.env`).
    // Pass an empty env map; consumers needing substitution can resolve
    // server-side or pre-fill an env block.
    parsed = parseConfig(yaml, {});
  } catch (err) {
    return {
      ok: false,
      reason: "parse-error",
      details: (err as Error).message ?? String(err),
    };
  }

  const validation = validateConfig(parsed);
  if ("errors" in validation) {
    return {
      ok: false,
      reason: "parse-error",
      details: validation.errors.map((e) => `${e.path}: ${e.message}`).join("\n"),
    };
  }

  return {
    ok: true,
    yaml,
    parsed: validation.config,
    path: configPath,
  };
}
