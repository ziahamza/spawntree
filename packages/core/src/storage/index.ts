/**
 * Public storage API for spawntree.
 *
 * SpawnTree has one local catalog: `<dataDir>/spawntree.db`, opened through
 * Turso Sync's local SQLite engine. Upstream behavior is selected by
 * `StorageConfig.syncMethod`.
 */
export * from "./types.ts";
export { createSqliteStorage, defaultSqliteDbPath, SqliteStorageConfig } from "./sqlite.ts";
export { startS3SnapshotSync } from "./s3-snapshot.ts";
export { loadStorageConfig, saveStorageConfig } from "./config.ts";
