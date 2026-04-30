import {
  DEFAULT_STORAGE_CONFIG,
  loadStorageConfig,
  localStorageProvider,
  s3SnapshotProvider,
  saveStorageConfig,
  StorageRegistry,
  tursoEmbeddedProvider,
  type PrimaryStorageHandle,
  type PrimaryStorageProvider,
  type ProviderStatus,
  type ReplicatorHandle,
  type ReplicatorProvider,
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
 *
 * Mutations are serialized via an internal lock so concurrent admin API
 * calls (two `PUT /primary` requests arriving simultaneously) can't leave
 * the manager in a half-swapped state.
 */
export class StorageManager {
  private readonly registry: StorageRegistry;
  private readonly configPath: string;
  private readonly ctx: StorageContext;

  private config: StorageConfig;
  private primary: PrimaryStorageHandle | null = null;
  private readonly replicators = new Map<string, ReplicatorHandle>();

  private lockQueue: Promise<unknown> = Promise.resolve();
  private migrating = false;

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
    if (this.migrating) {
      throw new Error("STORAGE_MIGRATING: primary storage swap in progress");
    }
    return this.primary.client;
  }

  async start(): Promise<void> {
    return this.withLock(async () => {
      await this.activatePrimary(this.config.primary);
      for (const rep of this.config.replicators) {
        await this.startReplicator(rep.rid, rep.id, rep.config);
      }
    });
  }

  async stop(): Promise<void> {
    return this.withLock(async () => {
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
    });
  }

  // ─── Status ────────────────────────────────────────────────────────────

  async status(): Promise<{
    primary: { id: string; config: unknown; status: ProviderStatus };
    replicators: Array<{ rid: string; id: string; config: unknown; status: ProviderStatus }>;
    availableProviders: {
      primaries: Array<{ id: string }>;
      replicators: Array<{ id: string }>;
    };
    migrating: boolean;
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
      migrating: this.migrating,
    };
  }

  // ─── Mutations (all persist to disk, all serialized via withLock) ──────

  async setPrimary(entry: { id: string; config: unknown }): Promise<void> {
    return this.withLock(() => this.setPrimaryLocked(entry));
  }

  async addReplicator(rid: string, id: string, config: unknown): Promise<void> {
    return this.withLock(() => this.addReplicatorLocked(rid, id, config));
  }

  async removeReplicator(rid: string): Promise<void> {
    return this.withLock(() => this.removeReplicatorLocked(rid));
  }

  /**
   * Apply a complete `StorageConfig` snapshot to the manager: hot-swap the
   * primary if it differs, then reconcile replicators (add new ones,
   * remove ones not in the target, replace any whose config changed).
   *
   * This is the entry point used by `HostConfigSync` when it pulls a
   * config from a `spawntree-host`. The whole operation runs inside the
   * manager's lock so a concurrent admin-API call can't interleave a
   * half-applied state.
   */
  async applyConfig(target: StorageConfig): Promise<void> {
    return this.withLock(async () => {
      // 1. Primary first — if it changes, replicators get torn down and
      //    rebuilt as part of the swap, so we don't double-stop them.
      await this.setPrimaryLocked(target.primary);

      // 2. Reconcile replicators against the (possibly updated) primary.
      //    Diff by `rid` + canonical config. Identical entries are no-ops.
      const currentByRid = new Map(this.config.replicators.map((r) => [r.rid, r]));
      const targetByRid = new Map(target.replicators.map((r) => [r.rid, r]));

      // Remove any rid no longer in the target.
      for (const rid of currentByRid.keys()) {
        if (!targetByRid.has(rid)) {
          await this.removeReplicatorLocked(rid);
        }
      }

      // Add or replace anything in the target that differs from current.
      for (const entry of target.replicators) {
        const existing = currentByRid.get(entry.rid);
        const sameProvider = existing?.id === entry.id;
        const sameConfig = existing
          ? canonicalEqual(existing.config ?? {}, entry.config ?? {})
          : false;
        if (existing && sameProvider && sameConfig) continue;
        if (existing) await this.removeReplicatorLocked(entry.rid);
        await this.addReplicatorLocked(entry.rid, entry.id, entry.config);
      }
    });
  }

  /** Lock-internal — assumes caller is already inside `withLock`. */
  private async addReplicatorLocked(rid: string, id: string, config: unknown): Promise<void> {
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

  /** Lock-internal — assumes caller is already inside `withLock`. */
  private async removeReplicatorLocked(rid: string): Promise<void> {
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
    // Trigger doesn't mutate config; safe outside the lock.
    const handle = this.replicators.get(rid);
    if (!handle) {
      throw new Error(`No replicator with rid="${rid}"`);
    }
    return handle.trigger();
  }

  // ─── Probes (validate + test-connect without committing) ───────────────

  async probePrimary(entry: { id: string; config: unknown }): Promise<ProbeResult> {
    const provider = this.registry.getPrimary(entry.id);
    if (!provider) {
      return { ok: false, error: `Unknown primary storage provider: "${entry.id}"` };
    }
    let validated: unknown;
    try {
      validated = provider.configSchema
        ? Schema.decodeUnknownSync(provider.configSchema as never)(entry.config ?? {})
        : entry.config;
    } catch (err) {
      return { ok: false, error: toMessage(err) };
    }
    let handle: PrimaryStorageHandle | null = null;
    try {
      handle = await provider.create(validated as never, this.ctx);
      const status = await handle.status();
      return { ok: true, info: { status, dbPath: handle.dbPath } };
    } catch (err) {
      return { ok: false, error: toMessage(err) };
    } finally {
      if (handle) await handle.shutdown().catch(() => undefined);
    }
  }

  async probeReplicator(entry: { id: string; config: unknown }): Promise<ProbeResult> {
    const provider = this.registry.getReplicator(entry.id);
    if (!provider) {
      return { ok: false, error: `Unknown replicator provider: "${entry.id}"` };
    }
    if (!this.primary) {
      return { ok: false, error: "StorageManager not started" };
    }
    let validated: unknown;
    try {
      validated = provider.configSchema
        ? Schema.decodeUnknownSync(provider.configSchema as never)(entry.config ?? {})
        : entry.config;
    } catch (err) {
      return { ok: false, error: toMessage(err) };
    }
    let handle: ReplicatorHandle | null = null;
    try {
      handle = await provider.start(validated as never, this.primary, this.ctx);
      const status = await handle.trigger();
      if (status.healthy) {
        return { ok: true, info: { status } };
      }
      return {
        ok: false,
        error: status.error ?? "replicator reported unhealthy",
        info: { status },
      };
    } catch (err) {
      return { ok: false, error: toMessage(err) };
    } finally {
      if (handle) await handle.stop().catch(() => undefined);
    }
  }

  // ─── Private ───────────────────────────────────────────────────────────

  private async setPrimaryLocked(entry: { id: string; config: unknown }): Promise<void> {
    if (!this.primary) {
      throw new Error("StorageManager not started");
    }

    // No-op detection: same provider id and same config → nothing to do.
    if (
      entry.id === this.config.primary.id &&
      canonicalEqual(entry.config ?? {}, this.config.primary.config ?? {})
    ) {
      this.ctx.logger("info", "primary swap no-op (same id + config)", {
        id: entry.id,
      });
      return;
    }

    const provider = this.registry.getPrimary(entry.id);
    if (!provider) {
      throw new Error(`Unknown primary storage provider: "${entry.id}"`);
    }
    const validated = provider.configSchema
      ? Schema.decodeUnknownSync(provider.configSchema as never)(entry.config ?? {})
      : entry.config;

    // Snapshot active replicator configs so we can rebuild them against the
    // new primary. The handle references are about to be torn down.
    const replicatorSnapshot = this.config.replicators.slice();

    this.ctx.logger("info", "primary swap: starting migration", {
      from: this.config.primary.id,
      to: entry.id,
    });
    this.migrating = true;

    let newPrimary: PrimaryStorageHandle | null = null;
    const oldPrimary = this.primary;

    // Step 1: drain replicators. Their `stop()` awaits any in-flight run so
    // we don't race a VACUUM against the migration.
    for (const [rid, handle] of this.replicators) {
      await handle.stop().catch((err) => {
        this.ctx.logger("warn", "replicator stop during swap failed", {
          rid,
          error: toMessage(err),
        });
      });
    }
    this.replicators.clear();

    try {
      // Step 2: open new primary (without closing old yet).
      newPrimary = await provider.create(validated as never, this.ctx);

      // Step 3: copy data from old to new.
      await migrateDatabase(oldPrimary, newPrimary, this.ctx.logger);

      // Step 4: commit the swap — persist config, swap active reference.
      this.config = { ...this.config, primary: entry };
      saveStorageConfig(this.configPath, this.config);
      this.primary = newPrimary;

      // Step 5: close old primary now that the new one is authoritative.
      await oldPrimary.shutdown().catch((err) => {
        this.ctx.logger("warn", "old primary shutdown failed", {
          error: toMessage(err),
        });
      });

      // Step 6: restart replicators against the new primary.
      for (const rep of replicatorSnapshot) {
        try {
          await this.startReplicator(rep.rid, rep.id, rep.config);
        } catch (err) {
          this.ctx.logger("error", "replicator restart after swap failed", {
            rid: rep.rid,
            error: toMessage(err),
          });
        }
      }

      this.ctx.logger("info", "primary swap: complete", {
        from: replicatorSnapshot.length ? "(replicators restarted)" : "(no replicators)",
        to: entry.id,
      });
    } catch (err) {
      // Rollback: close new primary, restart replicators against OLD primary.
      this.ctx.logger("error", "primary swap: rolling back", {
        error: toMessage(err),
      });
      if (newPrimary) {
        await newPrimary.shutdown().catch(() => undefined);
      }
      // Old primary is still active (we never closed it) — restart replicators.
      for (const rep of replicatorSnapshot) {
        try {
          await this.startReplicator(rep.rid, rep.id, rep.config);
        } catch (restartErr) {
          this.ctx.logger("error", "rollback replicator restart failed", {
            rid: rep.rid,
            error: toMessage(restartErr),
          });
        }
      }
      throw err;
    } finally {
      this.migrating = false;
    }
  }

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

  /** Serialize the given async function against any other `withLock` caller. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lockQueue.then(fn, fn);
    // Swallow errors so one failed mutation doesn't permanently break the queue.
    this.lockQueue = run.catch(() => undefined);
    return run;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

export type ProbeResult =
  | { ok: true; info?: unknown }
  | { ok: false; error: string; info?: unknown };

/**
 * Copy every non-sqlite_* object and row from `src` to `dst`. Schema first
 * (tables → indexes → views → triggers), then data. Both clients must be
 * libSQL/SQLite-compatible. Intended for primary hot-swap — not a general
 * replication tool.
 */
async function migrateDatabase(
  src: PrimaryStorageHandle,
  dst: PrimaryStorageHandle,
  logger: StorageContext["logger"],
): Promise<void> {
  // 1. Enumerate schema objects in dependency order.
  const schemaRes = await src.client.execute(
    `SELECT type, name, sql FROM sqlite_schema
     WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
     ORDER BY CASE type
       WHEN 'table' THEN 1
       WHEN 'index' THEN 2
       WHEN 'view' THEN 3
       WHEN 'trigger' THEN 4
       ELSE 5 END`,
  );

  // 2. Apply schema to dst. `IF NOT EXISTS` isn't guaranteed in every DDL the
  //    user may have created, so we let errors surface — a clean new primary
  //    should have no conflicts.
  for (const row of schemaRes.rows) {
    const sql = row["sql"] as string | null;
    if (!sql) continue;
    await dst.client.execute(sql);
  }

  // 3. Copy data, table-by-table.
  const tablesRes = await src.client.execute(
    `SELECT name FROM sqlite_schema
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  );

  for (const tableRow of tablesRes.rows) {
    const tableName = tableRow["name"] as string;
    const quotedTable = `"${tableName.replace(/"/g, '""')}"`;

    const dataRes = await src.client.execute(`SELECT * FROM ${quotedTable}`);
    if (dataRes.rows.length === 0) continue;

    const columns = dataRes.columns;
    const quotedCols = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const insertSql = `INSERT INTO ${quotedTable} (${quotedCols}) VALUES (${placeholders})`;

    // Batch in chunks so we don't pin an unbounded arg array.
    const chunkSize = 500;
    for (let i = 0; i < dataRes.rows.length; i += chunkSize) {
      const chunk = dataRes.rows.slice(i, i + chunkSize);
      await dst.client.batch(
        chunk.map((row) => ({
          sql: insertSql,
          args: columns.map((c) => (row[c] ?? null) as never),
        })),
        "write",
      );
    }

    logger("info", "storage.migrate: copied table", {
      table: tableName,
      rows: dataRes.rows.length,
    });
  }
}

function canonicalEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

// Re-exports that downstream consumers expect.
export { DEFAULT_STORAGE_CONFIG };
export type { PrimaryStorageProvider, ReplicatorProvider };
