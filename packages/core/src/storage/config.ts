import { Schema } from "effect";
import { chmodSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_STORAGE_CONFIG, StorageConfig } from "./types.ts";

/**
 * Load/save the persisted storage config at `<dataDir>/storage.json`.
 * Returns the default config if the file doesn't exist.
 * Throws on schema validation failure (corrupt file).
 */
export function loadStorageConfig(path: string): StorageConfig {
  if (!existsSync(path)) {
    return DEFAULT_STORAGE_CONFIG;
  }
  const raw = readFileSync(path, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  return Schema.decodeUnknownSync(StorageConfig)(parsed);
}

export function saveStorageConfig(path: string, config: StorageConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const encoded = Schema.encodeUnknownSync(StorageConfig)(config);
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
