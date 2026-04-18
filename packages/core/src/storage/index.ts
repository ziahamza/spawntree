/**
 * Public storage API for spawntree. Exported from `spawntree-core`.
 *
 * See `types.ts` for the provider contracts. Consumers typically:
 *
 *   ```ts
 *   import {
 *     StorageRegistry,
 *     localStorageProvider,
 *     tursoEmbeddedProvider,
 *     s3SnapshotProvider,
 *   } from "spawntree-core";
 *
 *   const registry = new StorageRegistry();
 *   registry.registerPrimary(localStorageProvider);
 *   registry.registerPrimary(tursoEmbeddedProvider);
 *   registry.registerReplicator(s3SnapshotProvider);
 *   ```
 *
 * The daemon's `StorageManager` then activates providers from persisted
 * config on boot. Third-party providers register themselves before the
 * daemon starts.
 */
export * from "./types.ts";
export { StorageRegistry } from "./registry.ts";
export { LocalStorageConfig, localStorageProvider } from "./providers/local.ts";
export { TursoEmbeddedConfig, tursoEmbeddedProvider } from "./providers/turso-embedded.ts";
export { S3SnapshotConfig, s3SnapshotProvider } from "./providers/s3-snapshot.ts";
export { loadStorageConfig, saveStorageConfig } from "./config.ts";
