import { Schema } from "effect";
import type { Client } from "@libsql/client";

/**
 * Storage provider contracts for the spawntree daemon.
 *
 * The daemon's database layer is pluggable along two axes:
 *
 *   1. **Primary storage** (exactly one active): owns the libSQL client the
 *      daemon reads and writes through. Default impl is `local` (plain SQLite
 *      file). Optional impls (e.g. `turso-embedded`) swap in a syncing client.
 *
 *   2. **Replicators** (zero or more active): background jobs that copy the
 *      primary's data somewhere else (S3, a Turso read-replica, etc.) for
 *      backup or cross-host read access. They observe the primary; they never
 *      substitute for it.
 *
 * Providers are resolved from a `StorageRegistry`. Built-ins register
 * themselves; third parties call `registry.registerPrimary(...)` or
 * `registry.registerReplicator(...)` before the daemon boots the active
 * configuration.
 */

// ─── Provider status ─────────────────────────────────────────────────────

export const ProviderStatus = Schema.Struct({
  healthy: Schema.Boolean,
  lagMs: Schema.optional(Schema.Number),
  lastOkAt: Schema.optional(Schema.String),
  lastErrorAt: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  info: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type ProviderStatus = Schema.Schema.Type<typeof ProviderStatus>;

// ─── Shared context passed to every provider ─────────────────────────────

export interface StorageContext {
  /** Absolute path to the spawntree data directory (e.g. ~/.spawntree). */
  readonly dataDir: string;
  /** Structured log emitter. Providers should use this, not console.*. */
  readonly logger: (
    level: "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
}

// ─── Primary storage ──────────────────────────────────────────────────────

export interface PrimaryStorageHandle {
  /** Active libSQL client. All daemon DB access routes through this. */
  readonly client: Client;
  /** Absolute path to the local database file, if the provider has one. */
  readonly dbPath: string | null;
  /** Current health / lag / last-sync metadata. */
  status(): Promise<ProviderStatus>;
  /** Force an immediate sync round-trip, if the provider supports it. No-op otherwise. */
  syncNow(): Promise<void>;
  /** Release resources. Called on shutdown and when swapping primaries. */
  shutdown(): Promise<void>;
}

export interface PrimaryStorageProvider<Config = unknown> {
  readonly id: string;
  readonly kind: "primary";
  /**
   * Effect Schema describing valid config for this provider. Validated before
   * `create()` is called. Omit if the provider takes no config.
   */
  readonly configSchema?: Schema.Top;
  /** Open the connection. Must be idempotent if called twice with the same config. */
  create(config: Config, ctx: StorageContext): Promise<PrimaryStorageHandle>;
}

// ─── Replicators ──────────────────────────────────────────────────────────

export interface ReplicatorHandle {
  /** Current health / last success timestamp / error. */
  status(): Promise<ProviderStatus>;
  /** Run one replication pass immediately. Resolves when done (success or failure). */
  trigger(): Promise<ProviderStatus>;
  /**
   * Temporarily suspend the background loop and wait for any in-flight run
   * to drain. Safe to call repeatedly. Optional — providers that don't have
   * a background loop (pure on-demand replicators) can omit it.
   *
   * Used by `StorageManager` to quiesce replicators while a primary swap
   * is in progress so the replicator doesn't VACUUM the old DB mid-migration.
   */
  pause?(): Promise<void>;
  /** Resume the background loop after a pause. Optional; pairs with `pause`. */
  resume?(): Promise<void>;
  /** Stop the background loop and release resources. */
  stop(): Promise<void>;
}

export interface ReplicatorProvider<Config = unknown> {
  readonly id: string;
  readonly kind: "replicator";
  readonly configSchema?: Schema.Top;
  /**
   * Begin replicating. The provider is handed the active `PrimaryStorageHandle`
   * and can read `handle.dbPath` (for snapshot-style replicators) or
   * `handle.client` (for query-driven replication) as appropriate.
   */
  start(
    config: Config,
    primary: PrimaryStorageHandle,
    ctx: StorageContext,
  ): Promise<ReplicatorHandle>;
}

// ─── Persisted config shape ───────────────────────────────────────────────

export const StorageConfigEntry = Schema.Struct({
  id: Schema.String,
  config: Schema.Unknown,
});
export type StorageConfigEntry = Schema.Schema.Type<typeof StorageConfigEntry>;

export const StorageConfig = Schema.Struct({
  primary: StorageConfigEntry,
  replicators: Schema.Array(
    Schema.Struct({
      rid: Schema.String, // stable replicator instance id ("s3-prod", "s3-backup")
      id: Schema.String, // provider id ("s3-snapshot")
      config: Schema.Unknown,
    }),
  ),
});
export type StorageConfig = Schema.Schema.Type<typeof StorageConfig>;

export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  primary: { id: "local", config: {} },
  replicators: [],
};
