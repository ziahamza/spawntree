import type {
  Client,
  InArgs,
  InStatement,
  ResultSet,
  Row,
  Transaction,
  TransactionMode,
  Value,
} from "@libsql/client";
import { connect } from "@tursodatabase/sync";
import { Schema } from "effect";
import { resolve } from "node:path";
import type {
  SqliteStorageHandle,
  StorageContext,
  StorageHealth,
  TursoUpstreamConfig,
} from "./types.ts";

type SqliteSyncDatabase = Awaited<ReturnType<typeof connect>>;
type SqliteSyncStatement = Awaited<ReturnType<SqliteSyncDatabase["prepare"]>>;
type ExecuteInput = [stmt: InStatement] | [sql: string, args?: InArgs | undefined];

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let releaseNext!: () => void;
    const next = new Promise<void>((resolveNext) => {
      releaseNext = resolveNext;
    });
    const previous = this.tail;
    this.tail = previous.then(
      () => next,
      () => next,
    );
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseNext();
    };
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export const SqliteStorageConfig = Schema.Struct({
  path: Schema.optional(Schema.String),
  turso: Schema.optional(
    Schema.Struct({
      url: Schema.String,
      authToken: Schema.String,
      syncIntervalSec: Schema.optional(Schema.Number),
      requestTimeoutMs: Schema.optional(Schema.Number),
      clientName: Schema.optional(Schema.String),
    }),
  ),
});
export type SqliteStorageConfigInput = Schema.Schema.Type<typeof SqliteStorageConfig>;
export type NormalizedSqliteStorageConfig = {
  path: string;
  turso?: TursoUpstreamConfig;
  syncIntervalSec: number;
  requestTimeoutMs: number;
};

function normalizeSqliteStorageConfig(
  raw: SqliteStorageConfigInput,
  defaultPath: string,
): NormalizedSqliteStorageConfig {
  const hasRemote = Boolean(raw.turso);
  return {
    path: resolve(raw.path ?? defaultPath),
    ...(raw.turso ? { turso: raw.turso } : {}),
    syncIntervalSec: raw.turso?.syncIntervalSec ?? (hasRemote ? 5 : 0),
    requestTimeoutMs: raw.turso?.requestTimeoutMs ?? 30_000,
  };
}

export function defaultSqliteDbPath(ctx: StorageContext): string {
  return resolve(ctx.dataDir, "spawntree.db");
}

export async function createSqliteStorage(
  raw: SqliteStorageConfigInput,
  ctx: StorageContext,
): Promise<SqliteStorageHandle> {
  const config = normalizeSqliteStorageConfig(raw, defaultSqliteDbPath(ctx));
  ctx.logger("info", "storage.sqlite: opening", {
    path: config.path,
    url: config.turso?.url,
    syncIntervalSec: config.syncIntervalSec,
  });

  let remoteSyncEnabled = false;
  const hasRemote = Boolean(config.turso);
  const db = await connect({
    path: config.path,
    url: () => (remoteSyncEnabled && config.turso ? config.turso.url : null),
    authToken: config.turso?.authToken,
    clientName: config.turso?.clientName ?? "spawntree-daemon",
    fetch: createTimeoutFetch(config.requestTimeoutMs),
  });
  remoteSyncEnabled = true;

  // The background sync loop applies remote WAL frames (db.pull/checkpoint)
  // without the transactionMutex that serializes local statements, so a local
  // write can collide with a sync frame-apply. The MVCC engine never corrupts
  // or loses data, but without a busy timeout that collision surfaces as a
  // transient "database is locked" thrown out of a local query. A busy timeout
  // makes the engine retry the acquisition internally (a bounded local wait)
  // instead — it never blocks on the network pull, which touches no local pages.
  await db.exec("PRAGMA busy_timeout = 5000");

  const openedAt = new Date().toISOString();
  let stopped = false;
  let closed = false;
  let opened = false;
  let syncActivated = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | null = null;
  let hasSyncedOnce = false;
  let lastSyncAt: string | undefined;
  let lastSyncError: string | undefined;
  let lastSyncErrorAt: string | undefined;

  const runSyncCycle = async (reason: string): Promise<void> => {
    if (stopped && reason !== "shutdown") return;
    if (!hasRemote) {
      hasSyncedOnce = true;
      lastSyncAt = new Date().toISOString();
      lastSyncError = undefined;
      lastSyncErrorAt = undefined;
      return;
    }
    if (!syncActivated) return;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        if (!hasSyncedOnce) {
          await db.pull();
        }
        await db.push();
        await db.pull();
        await db.checkpoint();
        hasSyncedOnce = true;
        lastSyncAt = new Date().toISOString();
        lastSyncError = undefined;
        lastSyncErrorAt = undefined;
      } catch (err) {
        lastSyncError = toMessage(err);
        lastSyncErrorAt = new Date().toISOString();
        ctx.logger("warn", "storage.sqlite: background sync failed", {
          reason,
          error: lastSyncError,
        });
        throw err;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const scheduleNext = (delayMs: number): void => {
    if (!opened || !syncActivated || stopped || config.syncIntervalSec <= 0) return;
    timer = setTimeout(() => {
      void runSyncCycle("interval")
        .catch(() => undefined)
        .finally(() => {
          scheduleNext(config.syncIntervalSec * 1000);
        });
    }, delayMs);
    timer.unref?.();
  };

  const closeDatabase = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await db.close();
  };

  const client = createLibSqlCompatClient(db, {
    sync: () => runSyncCycle("client.sync"),
    close: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      void closeDatabase();
    },
    closed: () => closed,
  });

  await client.execute("SELECT 1");

  const handle: SqliteStorageHandle = {
    client,
    dbPath: config.path,
    status: async function status(): Promise<StorageHealth> {
      const now = new Date().toISOString();
      const stats = await db.stats().catch((err) => ({
        error: toMessage(err),
      }));
      return {
        healthy: lastSyncError === undefined,
        lagMs: lastSyncAt ? Date.parse(now) - Date.parse(lastSyncAt) : 0,
        lastOkAt: lastSyncAt,
        lastErrorAt: lastSyncErrorAt,
        error: lastSyncError,
        info: {
          path: config.path,
          url: config.turso?.url,
          syncIntervalSec: config.syncIntervalSec,
          requestTimeoutMs: config.requestTimeoutMs,
          remoteSyncEnabled: hasRemote,
          syncActivated,
          openedAt,
          stats,
        },
      };
    },
    activateSync() {
      if (syncActivated) return;
      syncActivated = true;
      scheduleNext(config.syncIntervalSec * 1000);
    },
    async syncNow() {
      await runSyncCycle("syncNow");
    },
    async shutdown() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) {
        await inFlight.catch(() => undefined);
      }
      if (syncActivated) {
        await runSyncCycle("shutdown").catch(() => undefined);
      }
      await closeDatabase();
    },
  };

  opened = true;
  return handle;
}

function createLibSqlCompatClient(
  db: SqliteSyncDatabase,
  lifecycle: {
    sync(): Promise<void>;
    close(): void;
    closed(): boolean;
  },
): Client {
  const transactionMutex = new AsyncMutex();
  const runBatchDirect = async (
    statements: Array<InStatement | [string, InArgs?]>,
    mode: TransactionMode,
  ): Promise<Array<ResultSet>> => {
    if (mode === "read") {
      for (const statement of statements) {
        assertReadOnlyStatement(normalizeBatchInput(statement).sql);
      }
    }
    await db.exec(beginSql(mode));
    try {
      const results: ResultSet[] = [];
      for (const statement of statements) {
        results.push(await executeDirect(db, normalizeBatchInput(statement)));
      }
      await db.exec("COMMIT");
      return results;
    } catch (err) {
      await db.exec("ROLLBACK").catch(() => undefined);
      throw err;
    }
  };

  const client = {
    protocol: "file",
    get closed() {
      return lifecycle.closed();
    },
    async execute(...input: ExecuteInput): Promise<ResultSet> {
      return transactionMutex.runExclusive(() => executeDirect(db, normalizeExecuteInput(input)));
    },
    async batch(
      statements: Array<InStatement | [string, InArgs?]>,
      mode: TransactionMode = "deferred",
    ): Promise<Array<ResultSet>> {
      return transactionMutex.runExclusive(() => runBatchDirect(statements, mode));
    },
    async migrate(statements: Array<InStatement>): Promise<Array<ResultSet>> {
      return transactionMutex.runExclusive(async () => {
        await db.exec("PRAGMA foreign_keys=OFF");
        try {
          return await runBatchDirect(statements, "deferred");
        } finally {
          await db.exec("PRAGMA foreign_keys=ON").catch(() => undefined);
        }
      });
    },
    async transaction(mode: TransactionMode = "deferred"): Promise<Transaction> {
      const releaseLock = await transactionMutex.acquire();
      let lockReleased = false;
      const releaseOnce = (): void => {
        if (lockReleased) return;
        lockReleased = true;
        releaseLock();
      };
      try {
        await db.exec(beginSql(mode));
      } catch (err) {
        releaseOnce();
        throw err;
      }
      let closed = false;
      const assertOpen = (): void => {
        if (closed) throw new Error("Transaction is closed");
      };
      const finish = async (sql: "COMMIT" | "ROLLBACK"): Promise<void> => {
        if (closed) return;
        closed = true;
        try {
          await db.exec(sql);
        } finally {
          releaseOnce();
        }
      };
      const tx: Transaction = {
        get closed() {
          return closed;
        },
        async execute(stmt: InStatement): Promise<ResultSet> {
          assertOpen();
          const normalized = normalizeBatchInput(stmt);
          if (mode === "read") assertReadOnlyStatement(normalized.sql);
          return executeDirect(db, normalized);
        },
        async batch(statements: Array<InStatement>): Promise<Array<ResultSet>> {
          assertOpen();
          const results: ResultSet[] = [];
          for (const statement of statements) {
            const normalized = normalizeBatchInput(statement);
            if (mode === "read") assertReadOnlyStatement(normalized.sql);
            results.push(await executeDirect(db, normalized));
          }
          return results;
        },
        async executeMultiple(sql: string): Promise<void> {
          assertOpen();
          if (mode === "read") {
            throw new Error("Read-only transactions do not support executeMultiple");
          }
          await db.exec(sql);
        },
        async rollback(): Promise<void> {
          await finish("ROLLBACK");
        },
        async commit(): Promise<void> {
          await finish("COMMIT");
        },
        close(): void {
          if (closed) return;
          closed = true;
          void db
            .exec("ROLLBACK")
            .catch(() => undefined)
            .finally(() => releaseOnce());
        },
      };
      return tx;
    },
    async executeMultiple(sql: string): Promise<void> {
      await transactionMutex.runExclusive(() => db.exec(sql));
    },
    sync: lifecycle.sync,
    close: lifecycle.close,
    reconnect(): void {
      if (lifecycle.closed()) {
        throw new Error("sqlite storage client cannot reconnect after close");
      }
    },
  };
  return client as Client;
}

async function executeDirect(
  db: SqliteSyncDatabase,
  statement: { sql: string; args?: InArgs },
): Promise<ResultSet> {
  const prepared = await db.prepare(statement.sql);
  try {
    const columnInfo = await statementColumns(prepared);
    const columns = columnInfo.map((column) => column.name);
    const columnTypes = columnInfo.map((column) => column.type ?? "");
    if (columns.length > 0) {
      const rawRows = await callStatementAll(prepared, statement.args);
      const rows = rawRows.map((row) => normalizeRow(row as Record<string, Value>, columns));
      return makeResultSet({ columns, columnTypes, rows, rowsAffected: 0 });
    }
    const runInfo = await callStatementRun(prepared, statement.args);
    return makeResultSet({
      columns,
      columnTypes,
      rows: [],
      rowsAffected: Number(runInfo.changes ?? 0),
      lastInsertRowid:
        runInfo.lastInsertRowid === undefined ? undefined : BigInt(runInfo.lastInsertRowid),
    });
  } finally {
    await prepared.close();
  }
}

async function statementColumns(
  statement: SqliteSyncStatement,
): Promise<Array<{ name: string; type?: string | null }>> {
  return (await statement.columns()) as Array<{ name: string; type?: string | null }>;
}

async function callStatementAll(
  statement: SqliteSyncStatement,
  args: InArgs | undefined,
): Promise<unknown[]> {
  if (args === undefined) return statement.all();
  return statement.all(args);
}

async function callStatementRun(
  statement: SqliteSyncStatement,
  args: InArgs | undefined,
): Promise<{ changes?: number; lastInsertRowid?: number }> {
  if (args === undefined)
    return statement.run() as Promise<{ changes?: number; lastInsertRowid?: number }>;
  return statement.run(args) as Promise<{ changes?: number; lastInsertRowid?: number }>;
}

function normalizeRow(source: Record<string, Value>, columns: ReadonlyArray<string>): Row {
  const row = { ...source } as Row;
  Object.defineProperty(row, "length", {
    value: columns.length,
    enumerable: false,
    configurable: true,
  });
  columns.forEach((column, index) => {
    row[index] = source[column] ?? null;
  });
  return row;
}

function makeResultSet(input: {
  columns: string[];
  columnTypes: string[];
  rows: Row[];
  rowsAffected: number;
  lastInsertRowid?: bigint;
}): ResultSet {
  return {
    columns: input.columns,
    columnTypes: input.columnTypes,
    rows: input.rows,
    rowsAffected: input.rowsAffected,
    lastInsertRowid: input.lastInsertRowid,
    toJSON() {
      return {
        columns: input.columns,
        columnTypes: input.columnTypes,
        rows: input.rows,
        rowsAffected: input.rowsAffected,
        lastInsertRowid: input.lastInsertRowid?.toString(),
      };
    },
  };
}

function normalizeExecuteInput(input: ExecuteInput): { sql: string; args?: InArgs } {
  if (typeof input[0] === "string") {
    return { sql: input[0], args: input[1] };
  }
  return normalizeBatchInput(input[0]);
}

function normalizeBatchInput(statement: InStatement | [string, InArgs?]): {
  sql: string;
  args?: InArgs;
} {
  if (Array.isArray(statement)) {
    return { sql: statement[0], args: statement[1] };
  }
  if (typeof statement === "string") {
    return { sql: statement };
  }
  return { sql: statement.sql, args: statement.args };
}

function beginSql(mode: TransactionMode): string {
  if (mode === "write") return "BEGIN IMMEDIATE";
  if (mode === "deferred") return "BEGIN DEFERRED";
  if (mode === "read") return "BEGIN DEFERRED";
  return "BEGIN";
}

function assertReadOnlyStatement(sql: string): void {
  if (!isReadOnlyStatement(sql)) {
    throw new Error("Write statement attempted inside read-only transaction");
  }
}

function isReadOnlyStatement(sql: string): boolean {
  const normalized = stripSqlCommentsAndStrings(sql).trimStart().toUpperCase();
  return (
    normalized.startsWith("SELECT") ||
    normalized.startsWith("VALUES") ||
    normalized.startsWith("EXPLAIN")
  );
}

function stripSqlCommentsAndStrings(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += " ";
      i += 1;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function createTimeoutFetch(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const upstream = init?.signal;
    if (upstream) {
      if (upstream.aborted) {
        controller.abort();
      } else {
        upstream.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
