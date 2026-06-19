import { Schema } from "effect";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_SANDBOX_CONFIG, SandboxConfig } from "./types.ts";

/**
 * Load/save the persisted sandbox config at `<dataDir>/sandboxes.json`.
 * Returns the default config (both providers enabled) if the file is absent.
 * Throws on schema validation failure (corrupt file).
 */
export function loadSandboxConfig(path: string): SandboxConfig {
  if (!existsSync(path)) {
    return DEFAULT_SANDBOX_CONFIG;
  }
  const raw = readFileSync(path, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  return Schema.decodeUnknownSync(SandboxConfig)(parsed);
}

export function saveSandboxConfig(path: string, config: SandboxConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const encoded = Schema.encodeUnknownSync(SandboxConfig)(config);
  writeFileSync(path, JSON.stringify(encoded, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  // writeFileSync's `mode` only applies on file creation. Re-chmod on every
  // save so rotating the config doesn't drift to world-readable.
  try {
    chmodSync(path, 0o600);
  } catch {
    // On non-POSIX filesystems chmod is a no-op; ignore.
  }
}
