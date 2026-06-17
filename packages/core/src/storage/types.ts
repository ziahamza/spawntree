import { Schema } from "effect";
import type { Client } from "@libsql/client";

/**
 * Storage contracts for the SpawnTree catalog.
 *
 * There is exactly one local catalog: `<dataDir>/spawntree.db`, opened through
 * Turso Sync's local SQLite engine. `syncMethod` controls only what background
 * process, if any, copies that local catalog elsewhere.
 */

export const SyncMethod = Schema.Literals(["none", "turso", "s3"]);
export type SyncMethod = Schema.Schema.Type<typeof SyncMethod>;

export const StorageHealth = Schema.Struct({
  healthy: Schema.Boolean,
  lagMs: Schema.optional(Schema.Number),
  lastOkAt: Schema.optional(Schema.String),
  lastErrorAt: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  info: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type StorageHealth = Schema.Schema.Type<typeof StorageHealth>;

export interface StorageContext {
  /** Absolute path to the spawntree data directory (e.g. ~/.spawntree). */
  readonly dataDir: string;
  /** Structured log emitter. Storage code should use this, not console.*. */
  readonly logger: (
    level: "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
}

export const TursoUpstreamConfig = Schema.Struct({
  /** libsql:// URL for the per-machine Turso database. */
  url: Schema.String,
  /** Read/write auth token used only by the background push/pull loop. */
  authToken: Schema.String,
  /** Background sync cadence in seconds. `0` disables the loop. Default: 5. */
  syncIntervalSec: Schema.optional(Schema.Number),
  /** Abort individual sync HTTP requests after this many milliseconds. */
  requestTimeoutMs: Schema.optional(Schema.Number),
  /** Optional client label visible to the Turso sync backend. */
  clientName: Schema.optional(Schema.String),
});
export type TursoUpstreamConfig = Schema.Schema.Type<typeof TursoUpstreamConfig>;

export const S3SnapshotConfig = Schema.Struct({
  endpoint: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  bucket: Schema.String,
  keyPrefix: Schema.optional(Schema.String),
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
  forcePathStyle: Schema.optional(Schema.Boolean),
  intervalSec: Schema.optional(Schema.Number),
});
export type S3SnapshotConfigInput = Schema.Schema.Type<typeof S3SnapshotConfig>;
export type S3SnapshotConfig = S3SnapshotConfigInput & {
  region: string;
  keyPrefix: string;
  forcePathStyle: boolean;
  intervalSec: number;
};

export const StorageConfig = Schema.Struct({
  syncMethod: SyncMethod,
  turso: Schema.optional(TursoUpstreamConfig),
  s3: Schema.optional(S3SnapshotConfig),
});
export type StorageConfig = Schema.Schema.Type<typeof StorageConfig>;

export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  syncMethod: "none",
};

export interface SqliteStorageHandle {
  /** Active libSQL-compatible client. All daemon catalog access routes through this. */
  readonly client: Client;
  /** Absolute path to the local SQLite database file. */
  readonly dbPath: string;
  /** Start background sync after the owner commits this handle as authoritative. */
  activateSync(): void;
  /** Current health / lag / last-sync metadata. */
  status(): Promise<StorageHealth>;
  /** Force an immediate background sync, if configured. No-op for local-only mode. */
  syncNow(): Promise<void>;
  /** Release resources. Called on shutdown and when reconfiguring sync. */
  shutdown(): Promise<void>;
}

export interface SnapshotSyncHandle {
  status(): Promise<StorageHealth>;
  trigger(): Promise<StorageHealth>;
  stop(): Promise<void>;
}
