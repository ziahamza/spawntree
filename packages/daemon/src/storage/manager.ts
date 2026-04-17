import {
  DEFAULT_STORAGE_CONFIG,
  loadStorageConfig,
  localStorageProvider,
  s3SnapshotProvider,
  saveStorageConfig,
  StorageRegistry,
  tursoEmbeddedProvider,
  type PrimaryStorageHandle,
  type ProviderStatus,
  type ReplicatorHandle,
  type StorageConfig,
  type StorageContext,
} from "spawntree-core";
import { Schema } from "effect";
import { resolve } from "node:path";

/**
 * Runtime bridge between persisted config, the registry, and the daemon's
 * active connections.
 *
 * Responsibilities:
 *  - Load config on boot, validate, apply.
 *  - Start the primary provider; surface its `Client` as `manager.client`.
 *  - Start each replicator against the current primary.
 *  - Respond to config changes (set primary, add/remove replicator), including
 *    hot-swap of the primary with data migration.
 *  - Persist config back to disk on any change.
 *
 * All daemon code should read/write the database through `manager.client`
 * rather than opening its own libSQL client. That's how replication stays
 * aligned with the live writes.
 */
export class StorageManager {
  private readonly registry: StorageRegistry;
  private readonly configPath: string;
  private readonly ctx: StorageContext;

  private config: StorageConfig;
  private primary: PrimaryStorageHandle | null = null;
  private readonly replicators = new Map<string, ReplicatorHandle>();

  constructor(options: {
    registry?: StorageRegistry;
    dataDir: string;
    logger?: StorageContext["logger"];
  }) {
    this.registry = options.registry ?? defaultRegistry();
    this.configPath = resolve(options.dataDir, "storage.json");
    this.ctx = {
      dataDir: options.dataDir,
      logger: options.logger ?? ((level, msg, fields) => {
        process.stderr.write(
          `[spawntree-daemon] storage.${level} ${msg}${fields ? " " + JSON.stringify(fields) : ""}\n`,
        );
      }),
    };
    this.config = loadStorageConfig(this.configPath);
  }

  /** The active libSQL client. Throws if `start()` hasn't been called yet. */
  get client() {
    if (!this.primary) {
      throw new Error("StorageManager.start() must be called before accessing client");
    }
    return this.primary.client;
  }

  async start(): Promise<void> {
    await this.activatePrimary(this.config.primary);
    for (const rep of this.config.replicators) {
      await this.startReplicator(rep.rid, rep.id, rep.config);
    }
  }

  async stop(): Promise<void> {
    // Stop replicators first so we don't capture a partial final write.
    for (const [rid, handle] of this.replicators) {
      await handle.stop().catch((err) => {
        this.ctx.logger("warn", "replicator stop failed", {
          rid,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    this.replicators.clear();
    if (this.primary) {
      await this.primary.shutdown();
      this.primary = null;
    }
  }

  // ─── Status ────────────────────────────────────────────────────────────

  async status(): Promise<{
    primary: { id: string; config: unknown; status: ProviderStatus };
    replicators: Array<{ rid: string; id: string; config: unknown; status: ProviderStatus }>;
    availableProviders: {
      primaries: Array<{ id: string }>;
      replicators: Array<{ id: string }>;
    };
  }> {
    if (!this.primary) {
      throw new Error("StorageManager not started");
    }
    const replicatorStatuses = await Promise.all(
      this.config.replicators.map(async (entry) => ({
        rid: entry.rid,
        id: entry.id,
        config: redactSecrets(entry.config),
        status: (await this.replicators.get(entry.rid)?.status()) ?? {
          healthy: false,
          error: "not_running",
        },
      })),
    );
    return {
      primary: {
        id: this.config.primary.id,
        config: redactSecrets(this.config.primary.config),
        status: await this.primary.status(),
      },
      replicators: replicatorStatuses,
      availableProviders: {
        primaries: this.registry.listPrimaries().map((p) => ({ id: p.id })),
        replicators: this.registry.listReplicators().map((p) => ({ id: p.id })),
      },
    };
  }

  // ─── Mutations (all persist to disk) ───────────────────────────────────

  async setPrimary(entry: { id: string; config: unknown }): Promise<void> {
    // TODO (spawntree-followup): implement data migration on primary swap.
    // Current behavior: shuts down the old primary and opens the new one.
    // Session data written to the old file will NOT be copied. Safe to swap
    // only on a fresh install or after the user has exported their data.
    // See HANDOFF_NOTES.md for the migration design.
    this.ctx.logger("warn", "primary swap does not yet migrate data", {
      from: this.config.primary.id,
      to: entry.id,
    });

    await this.stop();
    this.config = { ...this.config, primary: entry };
    saveStorageConfig(this.configPath, this.config);
    await this.activatePrimary(entry);
    // Restart replicators against the new primary.
    for (const rep of this.config.replicators) {
      await this.startReplicator(rep.rid, rep.id, rep.config);
    }
  }

  async addReplicator(rid: string, id: string, config: unknown): Promise<void> {
    if (this.config.replicators.some((r) => r.rid === rid)) {
      throw new Error(`Replicator with rid="${rid}" already exists`);
    }
    await this.startReplicator(rid, id, config);
    this.config = {
      ...this.config,
      replicators: [...this.config.replicators, { rid, id, config }],
    };
    saveStorageConfig(this.configPath, this.config);
  }

  async removeReplicator(rid: string): Promise<void> {
    const handle = this.replicators.get(rid);
    if (handle) {
      await handle.stop();
      this.replicators.delete(rid);
    }
    this.config = {
      ...this.config,
      replicators: this.config.replicators.filter((r) => r.rid !== rid),
    };
    saveStorageConfig(this.configPath, this.config);
  }

  async triggerReplicator(rid: string): Promise<ProviderStatus> {
    const handle = this.replicators.get(rid);
    if (!handle) {
      throw new Error(`No replicator with rid="${rid}"`);
    }
    return handle.trigger();
  }

  // ─── Private ───────────────────────────────────────────────────────────

  private async activatePrimary(entry: { id: string; config: unknown }): Promise<void> {
    const provider = this.registry.getPrimary(entry.id);
    if (!provider) {
      throw new Error(`Unknown primary storage provider: "${entry.id}"`);
    }
    const validated = provider.configSchema
      ? Schema.decodeUnknownSync(provider.configSchema as never)(entry.config ?? {})
      : entry.config;
    this.primary = await provider.create(validated as never, this.ctx);
  }

  private async startReplicator(rid: string, id: string, config: unknown): Promise<void> {
    if (!this.primary) {
      throw new Error("Cannot start replicator before primary");
    }
    const provider = this.registry.getReplicator(id);
    if (!provider) {
      throw new Error(`Unknown replicator provider: "${id}"`);
    }
    const validated = provider.configSchema
      ? Schema.decodeUnknownSync(provider.configSchema as never)(config ?? {})
      : config;
    const handle = await provider.start(validated as never, this.primary, this.ctx);
    this.replicators.set(rid, handle);
  }
}

/** Build a registry with the three built-in providers. */
export function defaultRegistry(): StorageRegistry {
  const r = new StorageRegistry();
  r.registerPrimary(localStorageProvider);
  r.registerPrimary(tursoEmbeddedProvider);
  r.registerReplicator(s3SnapshotProvider);
  return r;
}

/**
 * Strip known secret fields so `GET /api/v1/storage` never returns tokens.
 * Extend as new providers add new sensitive fields.
 */
function redactSecrets(config: unknown): unknown {
  if (typeof config !== "object" || config === null) return config;
  const out = { ...(config as Record<string, unknown>) };
  for (const key of ["authToken", "secretAccessKey", "accessKeyId", "password"]) {
    if (key in out) out[key] = "***redacted***";
  }
  return out;
}

// Also kept as default for sensible import.
export { DEFAULT_STORAGE_CONFIG };
