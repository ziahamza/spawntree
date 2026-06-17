import { Schema } from "effect";
import { chmodSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_STORAGE_CONFIG, StorageConfig } from "./types.ts";

/**
 * Load/save the persisted storage config at `<dataDir>/storage.json`.
 * Returns the default config if the file doesn't exist, is corrupt, or was
 * written by an older daemon build whose shape no longer decodes.
 */
export function loadStorageConfig(path: string): StorageConfig {
  if (!existsSync(path)) {
    return DEFAULT_STORAGE_CONFIG;
  }
  const raw = readFileSync(path, "utf-8");
  // A storage.json written by an older daemon build uses a different shape
  // (the pre-sqlite-sync `{ primary, replicators }` provider model). Decoding
  // that with the current schema throws — and this runs in the StorageManager
  // constructor, so an unguarded throw would crash-loop the daemon on every
  // boot after an upgrade, unrecoverable short of deleting the file by hand.
  // Treat any unreadable file (legacy shape OR corrupt JSON) as "no usable
  // config": fall back to the default and let host-config-sync repopulate it.
  // The next saveStorageConfig overwrites the stale file with the current shape.
  try {
    const parsed: unknown = JSON.parse(raw);
    return Schema.decodeUnknownSync(StorageConfig)(parsed);
  } catch (err) {
    process.stderr.write(
      `[spawntree-daemon] storage.warn ignoring unreadable storage config at ${path} ` +
        `(${err instanceof Error ? err.message : String(err)}); using default storage config\n`,
    );
    return DEFAULT_STORAGE_CONFIG;
  }
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
