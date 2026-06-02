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
import { realpathSync } from "node:fs";
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
      logger:
        options.logger ??
        ((level, msg, fields) => {
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

    // Same-backing-file guard, BEFORE opening the destination. The raw-config
    // no-op check above misses a config that differs textually but points at
    // the live primary's file (e.g. turso-embedded `localPath` set to the
    // current spawntree.db). That matters here and not only in migrateDatabase
    // because some providers (turso-embedded) run an initial sync inside
    // create(), which would destructively overwrite the live file before the
    // migration could decide to skip. Compare the requested path against the
    // live primary's dbPath now, before create() can touch anything. Best
    // effort: only fires when the config carries an explicit path.
    const requestedPath =
      validated && typeof validated === "object"
        ? ((validated as { localPath?: unknown }).localPath ??
          (validated as { path?: unknown }).path)
        : undefined;
    if (
      typeof requestedPath === "string" &&
      this.primary.dbPath &&
      canonicalPath(requestedPath) === canonicalPath(this.primary.dbPath)
    ) {
      this.ctx.logger("info", "primary swap no-op (destination is the live primary file)", {
        dbPath: this.primary.dbPath,
      });
      return;
    }

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
  // 0. Bail if src and dst resolve to the SAME backing file. The upstream
  //    no-op guard keys on raw config, so a config that differs textually but
  //    points at the same DB (default local `{}` vs an explicit
  //    `{ path: <dataDir>/spawntree.db }`, a symlink, or a relative path) slips
  //    through to here. Because we clear destination tables before copying,
  //    proceeding would DELETE the source rows and commit an empty catalog.
  //    Canonicalize via realpath so symlink/relative variants collapse too.
  const sameBackingFile = Boolean(
    src.dbPath && dst.dbPath && canonicalPath(src.dbPath) === canonicalPath(dst.dbPath),
  );
  if (sameBackingFile) {
    logger("info", "storage.migrate: src and dst share a backing file — skipping copy", {
      dbPath: src.dbPath,
    });
    return;
  }

  // 1. Enumerate schema objects in creation order (tables → indexes → ...).
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

  // 2. Apply schema to dst, idempotently. The destination may already carry
  //    the baseline schema — a fresh primary applies it on open, and a prior
  //    failed swap can leave tables behind — so "already exists" is benign and
  //    we skip it. Any other DDL error still surfaces. (Previously this let
  //    every error throw, which wedged retries on a half-migrated dst with
  //    "table ... already exists".)
  for (const row of schemaRes.rows) {
    const sql = row["sql"] as string | null;
    if (!sql) continue;
    try {
      await dst.client.execute(sql);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(message)) throw err;
    }
  }

  // 3. Copy data parent-before-child. The destination enforces foreign keys
  //    (Turso/libSQL does by default), so copying tables alphabetically can
  //    insert a child row (`clones` → `repos`, `session_turns` → `sessions`)
  //    before its parent exists and fail with SQLITE_CONSTRAINT. Order tables
  //    topologically by their `REFERENCES` edges so every parent is populated
  //    first.
  const tableSql = new Map<string, string>();
  for (const row of schemaRes.rows) {
    if (row["type"] !== "table") continue;
    const name = row["name"] as string | null;
    if (name) tableSql.set(name, (row["sql"] as string | null) ?? "");
  }
  const orderedTables = topoSortTables(tableSql);

  // Copy data parent-before-child, RESUMABLY. A swap of a large catalog over a
  // remote primary can take a long time, and the swap only commits its config
  // at the very end — so if the daemon restarts mid-copy, the whole thing
  // re-runs. Rather than wipe + recopy every time (which never finishes for a
  // huge catalog that keeps getting interrupted), skip rows already present in
  // the destination, keyed by primary key, so each run resumes where the last
  // left off.
  //
  // Per table:
  //   • Read the destination's existing PK set once (the resume point).
  //   • Copy only src rows whose PK isn't already there, with INSERT OR IGNORE
  //     so a residual UNIQUE conflict from stale data is skipped rather than
  //     aborting the whole swap.
  //   • Keyless tables fall back to clear-then-copy — the catalog's keyless
  //     tables are tiny, so a clean (non-resumable) snapshot is fine there.
  //
  // Trade-off: a destination row no longer present in src is NOT pruned (we no
  // longer clear PK tables). On a fresh primary the destination starts empty so
  // there's nothing to prune; post-swap incremental sync keeps it converged.
  for (const tableName of orderedTables) {
    const quotedTable = `"${tableName.replace(/"/g, '""')}"`;

    const dataRes = await src.client.execute(`SELECT * FROM ${quotedTable}`);
    if (dataRes.rows.length === 0) continue;

    const columns = dataRes.columns;
    const quotedCols = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
    const placeholders = columns.map(() => "?").join(", ");

    // Primary-key columns (pk > 0, in key order), via PRAGMA table_info.
    const infoRes = await src.client.execute(`PRAGMA table_info(${quotedTable})`);
    const pkCols = infoRes.rows
      .filter((r) => Number(r["pk"] ?? 0) > 0)
      .sort((a, b) => Number(a["pk"] ?? 0) - Number(b["pk"] ?? 0))
      .map((r) => String(r["name"]));
    const keyOf = (row: (typeof dataRes.rows)[number]): string =>
      pkCols.map((c) => String(row[c])).join(" ");

    let existing: Set<string>;
    let insertSql: string;
    if (pkCols.length > 0) {
      const quotedPk = pkCols.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
      const dstPkRes = await dst.client.execute(`SELECT ${quotedPk} FROM ${quotedTable}`);
      existing = new Set(dstPkRes.rows.map((r) => keyOf(r)));
      insertSql = `INSERT OR IGNORE INTO ${quotedTable} (${quotedCols}) VALUES (${placeholders})`;
    } else {
      await dst.client.execute(`DELETE FROM ${quotedTable}`);
      existing = new Set();
      insertSql = `INSERT INTO ${quotedTable} (${quotedCols}) VALUES (${placeholders})`;
    }

    // Stream rows into the destination in size-bounded batches. A fixed row
    // count overflows the destination's per-request size limit on tables with
    // large rows (e.g. session transcripts) over a remote primary, which
    // silently stalls the swap on big catalogs. Cap each batch by BOTH a byte
    // budget and a row count, flushing before a row would overflow — small
    // tables still go in a single batch (no behaviour change).
    const MAX_BATCH_BYTES = 512 * 1024;
    const MAX_BATCH_ROWS = 100;
    let batch: { sql: string; args: never[] }[] = [];
    let batchBytes = 0;
    let copied = 0;
    let skipped = 0;
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      await dst.client.batch(batch, "write");
      batch = [];
      batchBytes = 0;
    };
    for (const row of dataRes.rows) {
      if (pkCols.length > 0 && existing.has(keyOf(row))) {
        skipped += 1;
        continue;
      }
      const args = columns.map((c) => (row[c] ?? null) as never);
      let rowBytes = 0;
      for (const value of args as unknown[]) {
        if (typeof value === "string") rowBytes += value.length;
        else if (value instanceof ArrayBuffer) rowBytes += value.byteLength;
        else if (value !== null) rowBytes += 8;
      }
      if (
        batch.length > 0 &&
        (batch.length >= MAX_BATCH_ROWS || batchBytes + rowBytes > MAX_BATCH_BYTES)
      ) {
        await flush();
      }
      batch.push({ sql: insertSql, args });
      batchBytes += rowBytes;
      copied += 1;
    }
    await flush();

    logger("info", "storage.migrate: copied table", {
      table: tableName,
      rows: dataRes.rows.length,
      copied,
      skipped,
    });
  }
}

/**
 * Order tables so each comes after the tables it references via a foreign key,
 * so a parent-before-child copy never trips destination FK enforcement. Parses
 * `REFERENCES <table>` out of each CREATE TABLE statement (quoted or not).
 * Best-effort: unknown refs are ignored and cycles fall back to insertion
 * order — it never throws, so a quirky schema degrades to the old behaviour
 * rather than breaking the swap.
 */
function topoSortTables(tableSql: Map<string, string>): string[] {
  const deps = new Map<string, Set<string>>();
  for (const [name, sql] of tableSql) {
    const refs = new Set<string>();
    const re = /REFERENCES\s+"?([A-Za-z0-9_]+)"?/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(sql)) !== null) {
      const ref = match[1];
      if (ref && ref !== name && tableSql.has(ref)) refs.add(ref);
    }
    deps.set(name, refs);
  }

  const ordered: string[] = [];
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name) || onStack.has(name)) return;
    onStack.add(name);
    for (const dep of deps.get(name) ?? []) visit(dep);
    onStack.delete(name);
    visited.add(name);
    ordered.push(name);
  };
  for (const name of tableSql.keys()) visit(name);
  return ordered;
}

/**
 * Canonicalize a DB path for backing-store identity comparison: make absolute,
 * then resolve symlinks. Falls back to the absolute path when the file can't be
 * realpath'd (e.g. it doesn't exist yet), so relative/symlink variants of the
 * same file still compare equal.
 */
function canonicalPath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
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
