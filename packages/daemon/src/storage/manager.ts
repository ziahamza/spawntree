import {
  createSqliteStorage,
  DEFAULT_STORAGE_CONFIG,
  loadStorageConfig,
  S3SnapshotConfig,
  saveStorageConfig,
  startS3SnapshotSync,
  StorageConfig,
  TursoUpstreamConfig,
  type S3SnapshotConfigInput,
  type SnapshotSyncHandle,
  type SqliteStorageHandle,
  type StorageContext,
  type StorageHealth,
} from "spawntree-core";
import { Schema } from "effect";
import { resolve } from "node:path";

export interface StorageStatus {
  storage: {
    id: "sqlite";
    config: unknown;
    status: StorageHealth;
  };
  sync: {
    method: StorageConfig["syncMethod"];
    config: unknown;
    status: StorageHealth;
  };
  reconfiguring: boolean;
}

/**
 * Runtime owner of the daemon catalog.
 *
 * There is exactly one local database file. It is always opened through
 * Turso Sync's local SQLite engine. The only configurable part is the
 * background sync target selected by `StorageConfig.syncMethod`.
 */
export class StorageManager {
  private readonly configPath: string;
  private readonly ctx: StorageContext;

  private config: StorageConfig;
  private sqlite: SqliteStorageHandle | null = null;
  private snapshotSync: SnapshotSyncHandle | null = null;

  private lockQueue: Promise<unknown> = Promise.resolve();
  private reconfiguring = false;

  constructor(options: { dataDir: string; logger?: StorageContext["logger"] }) {
    this.configPath = resolve(options.dataDir, "storage.json");
    this.ctx = {
      dataDir: options.dataDir,
      logger:
        options.logger ??
        ((level, msg, fields) => {
          process.stderr.write(
            `[spawntree-daemon] storage.${level} ${msg}${fields ? " " + JSON.stringify(fields) : ""}\n`,
          );
        }),
    };
    this.config = validateStorageConfig(loadStorageConfig(this.configPath));
  }

  /** The active libSQL client. Throws if `start()` hasn't completed yet. */
  get client() {
    if (!this.sqlite) {
      throw new Error("StorageManager.start() must be called before accessing client");
    }
    if (this.reconfiguring) {
      throw new Error("STORAGE_RECONFIGURING: sqlite sync reconfiguration in progress");
    }
    return this.sqlite.client;
  }

  async start(): Promise<void> {
    return this.withLock(async () => {
      if (this.sqlite) return;
      const sqlite = await createSqliteStorage(toSqliteConfig(this.config), this.ctx);
      try {
        this.snapshotSync = await startSnapshotIfConfigured(this.config, sqlite, this.ctx);
        this.sqlite = sqlite;
        sqlite.activateSync();
      } catch (err) {
        await sqlite.shutdown().catch((shutdownErr) => {
          this.ctx.logger("warn", "sqlite shutdown after failed start failed", {
            error: toMessage(shutdownErr),
          });
        });
        throw err;
      }
    });
  }

  async stop(): Promise<void> {
    return this.withLock(async () => {
      await this.stopSnapshot();
      if (this.sqlite) {
        await this.sqlite.shutdown();
        this.sqlite = null;
      }
    });
  }

  async status(): Promise<StorageStatus> {
    if (!this.sqlite) {
      throw new Error("StorageManager not started");
    }
    const storageStatus = await this.sqlite.status();
    return {
      storage: {
        id: "sqlite",
        config: redactSecrets(toSqliteConfig(this.config)),
        status: storageStatus,
      },
      sync: {
        method: this.config.syncMethod,
        config: redactSecrets(syncConfig(this.config)),
        status: await this.syncStatus(storageStatus),
      },
      reconfiguring: this.reconfiguring,
    };
  }

  async applyConfig(rawTarget: StorageConfig): Promise<void> {
    return this.withLock(async () => {
      if (!this.sqlite) {
        throw new Error("StorageManager not started");
      }
      const target = validateStorageConfig(rawTarget);
      if (canonicalEqual(target, this.config)) {
        this.ctx.logger("info", "sqlite sync config no-op");
        return;
      }
      if (isTursoRemoteUrlChange(this.config, target)) {
        throw new Error(
          "Changing the Turso sync URL for an existing sqlite catalog requires a local catalog reset; token-only Turso reconfiguration is supported",
        );
      }

      this.ctx.logger("info", "sqlite sync config: reconfiguring", {
        from: this.config.syncMethod,
        to: target.syncMethod,
      });
      this.reconfiguring = true;

      const previousConfig = this.config;
      const previousSqlite = this.sqlite;
      let nextSqlite: SqliteStorageHandle | null = null;
      let nextSnapshot: SnapshotSyncHandle | null = null;

      try {
        await this.stopSnapshot();
        await previousSqlite.shutdown();
        this.sqlite = null;

        nextSqlite = await createSqliteStorage(toSqliteConfig(target), this.ctx);
        nextSnapshot = await startSnapshotIfConfigured(target, nextSqlite, this.ctx);
        saveStorageConfig(this.configPath, target);
        this.config = target;
        this.sqlite = nextSqlite;
        this.snapshotSync = nextSnapshot;
        nextSqlite.activateSync();
        nextSqlite = null;
        nextSnapshot = null;
        this.ctx.logger("info", "sqlite sync config: applied", {
          syncMethod: target.syncMethod,
        });
      } catch (err) {
        this.ctx.logger("error", "sqlite sync config: rolling back", {
          error: toMessage(err),
        });
        this.config = previousConfig;
        if (this.snapshotSync === nextSnapshot) {
          this.snapshotSync = null;
        }
        if (this.sqlite === nextSqlite) {
          this.sqlite = null;
        }
        await nextSnapshot?.stop().catch((snapshotErr) => {
          this.ctx.logger("warn", "snapshot sync stop after failed reconfiguration failed", {
            error: toMessage(snapshotErr),
          });
        });
        await nextSqlite?.shutdown().catch((shutdownErr) => {
          this.ctx.logger("warn", "sqlite shutdown after failed reconfiguration failed", {
            error: toMessage(shutdownErr),
          });
        });
        if (this.sqlite === previousSqlite) {
          this.snapshotSync = await startSnapshotIfConfigured(
            previousConfig,
            previousSqlite,
            this.ctx,
          );
          previousSqlite.activateSync();
        } else if (!this.sqlite) {
          const restored = await createSqliteStorage(toSqliteConfig(previousConfig), this.ctx);
          this.snapshotSync = await startSnapshotIfConfigured(previousConfig, restored, this.ctx);
          this.sqlite = restored;
          restored.activateSync();
        }
        throw err;
      } finally {
        this.reconfiguring = false;
      }
    });
  }

  async syncNow(): Promise<void> {
    if (!this.sqlite) {
      throw new Error("StorageManager not started");
    }
    await this.sqlite.syncNow();
    await this.snapshotSync?.trigger();
  }

  private async syncStatus(storageStatus: StorageHealth): Promise<StorageHealth> {
    if (this.config.syncMethod === "none") {
      return {
        healthy: true,
        lastOkAt: storageStatus.lastOkAt,
        info: { method: "none", localOnly: true },
      };
    }
    if (this.config.syncMethod === "turso") {
      return storageStatus;
    }
    return (
      (await this.snapshotSync?.status()) ?? {
        healthy: false,
        error: "s3 snapshot sync is not running",
      }
    );
  }

  private async stopSnapshot(): Promise<void> {
    if (!this.snapshotSync) return;
    await this.snapshotSync.stop().catch((err) => {
      this.ctx.logger("warn", "s3 snapshot stop failed", {
        error: toMessage(err),
      });
    });
    this.snapshotSync = null;
  }

  /** Serialize the given async function against any other `withLock` caller. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lockQueue.then(fn, fn);
    this.lockQueue = run.catch(() => undefined);
    return run;
  }
}

function validateStorageConfig(raw: StorageConfig): StorageConfig {
  const config = Schema.decodeUnknownSync(StorageConfig)(raw);
  if (config.syncMethod === "turso") {
    Schema.decodeUnknownSync(TursoUpstreamConfig)(config.turso);
  }
  if (config.syncMethod === "s3") {
    Schema.decodeUnknownSync(S3SnapshotConfig)(config.s3);
  }
  return config;
}

function toSqliteConfig(config: StorageConfig) {
  if (config.syncMethod === "turso") {
    return { turso: config.turso };
  }
  return {};
}

function syncConfig(config: StorageConfig): unknown {
  if (config.syncMethod === "turso") return config.turso ?? {};
  if (config.syncMethod === "s3") return config.s3 ?? {};
  return {};
}

function isTursoRemoteUrlChange(previous: StorageConfig, target: StorageConfig): boolean {
  return (
    previous.syncMethod === "turso" &&
    target.syncMethod === "turso" &&
    previous.turso?.url !== target.turso?.url
  );
}

async function startSnapshotIfConfigured(
  config: StorageConfig,
  sqlite: SqliteStorageHandle,
  ctx: StorageContext,
): Promise<SnapshotSyncHandle | null> {
  if (config.syncMethod !== "s3") return null;
  return startS3SnapshotSync(config.s3 as S3SnapshotConfigInput, sqlite, ctx);
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

function redactSecrets(config: unknown): unknown {
  if (typeof config !== "object" || config === null) return config;
  if (Array.isArray(config)) return config.map(redactSecrets);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    out[key] = redactSecrets(value);
  }
  for (const key of ["authToken", "secretAccessKey", "accessKeyId", "password"]) {
    if (key in out) out[key] = "***redacted***";
  }
  return out;
}

export { DEFAULT_STORAGE_CONFIG };
