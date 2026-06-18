import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSqliteStorage,
  loadStorageConfig,
  saveStorageConfig,
  type StorageContext,
} from "../src/storage/index.ts";

describe("sqlite storage", () => {
  let tmp: string;
  let ctx: StorageContext;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-sqlite-storage-test-"));
    ctx = { dataDir: tmp, logger: () => undefined };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("uses spawntree.db as the default local source of truth", async () => {
    const handle = await createSqliteStorage({}, ctx);
    try {
      expect(handle.dbPath).toBe(resolve(tmp, "spawntree.db"));
      const result = await handle.client.execute("SELECT 42 as answer");
      expect(result.rows[0]?.answer).toBe(42);

      const status = await handle.status();
      expect(status.healthy).toBe(true);
      expect(status.info).toMatchObject({ remoteSyncEnabled: false });
    } finally {
      await handle.shutdown();
    }
  });

  it("respects an explicit test path without introducing a second storage mode", async () => {
    const custom = resolve(tmp, "custom.db");
    const handle = await createSqliteStorage({ path: custom }, ctx);
    try {
      expect(handle.dbPath).toBe(custom);
      await handle.client.execute("CREATE TABLE t (x INTEGER)");
      await handle.client.execute("INSERT INTO t VALUES (1)");
      const result = await handle.client.execute("SELECT x FROM t");
      expect(result.rows[0]?.x).toBe(1);
    } finally {
      await handle.shutdown();
    }
  });

  it("sets a busy timeout so a sync frame-apply never surfaces as a locked error", async () => {
    // The background sync loop applies WAL frames off the transactionMutex; a
    // busy timeout makes a colliding local write retry internally instead of
    // throwing "database is locked".
    const handle = await createSqliteStorage({}, ctx);
    try {
      const result = await handle.client.execute("PRAGMA busy_timeout");
      expect(result.rows[0]?.busy_timeout).toBe(5000);
    } finally {
      await handle.shutdown();
    }
  });

  it("keeps local queries responsive while a network sync is waiting", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolveP, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolveP());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP listen address");
    }

    const handle = await createSqliteStorage(
      {
        turso: {
          url: `http://127.0.0.1:${address.port}`,
          authToken: "test-token",
          syncIntervalSec: 0,
          requestTimeoutMs: 250,
        },
      },
      ctx,
    );
    try {
      await handle.client.execute("CREATE TABLE watchdog (id INTEGER PRIMARY KEY, value TEXT)");
      await handle.client.execute("INSERT INTO watchdog (value) VALUES ('ok')");

      handle.activateSync();
      const sync = handle.syncNow().catch(() => undefined);
      await new Promise((resolveP) => setTimeout(resolveP, 25));

      const startedAt = Date.now();
      const result = await handle.client.execute("SELECT value FROM watchdog");
      expect(Date.now() - startedAt).toBeLessThan(100);
      expect(result.rows[0]?.value).toBe("ok");

      await sync;
    } finally {
      await handle.shutdown();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveP) => server.close(() => resolveP()));
    }
  });

  it("does not sync an abandoned remote handle before activation or during shutdown", async () => {
    let connectionCount = 0;
    const server = createServer((socket) => {
      connectionCount += 1;
      socket.destroy();
    });
    await new Promise<void>((resolveP, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolveP());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP listen address");
    }

    const handle = await createSqliteStorage(
      {
        turso: {
          url: `http://127.0.0.1:${address.port}`,
          authToken: "test-token",
          syncIntervalSec: 0,
          requestTimeoutMs: 50,
        },
      },
      ctx,
    );
    try {
      await handle.syncNow();
      await handle.shutdown();
      expect(connectionCount).toBe(0);
    } finally {
      await handle.shutdown().catch(() => undefined);
      await new Promise<void>((resolveP) => server.close(() => resolveP()));
    }
  });

  it("serializes overlapping transaction windows on the shared connection", async () => {
    const handle = await createSqliteStorage({}, ctx);
    try {
      await handle.client.execute("CREATE TABLE concurrent_writes (value TEXT PRIMARY KEY)");

      const first = (async () => {
        const tx = await handle.client.transaction("write");
        await tx.execute({
          sql: "INSERT INTO concurrent_writes (value) VALUES (?)",
          args: ["first"],
        });
        await new Promise((resolveP) => setTimeout(resolveP, 50));
        await tx.commit();
      })();
      await new Promise((resolveP) => setTimeout(resolveP, 10));

      const second = handle.client.batch(
        [
          {
            sql: "INSERT INTO concurrent_writes (value) VALUES (?)",
            args: ["second"],
          },
        ],
        "write",
      );

      await Promise.all([first, second]);

      const result = await handle.client.execute(
        "SELECT value FROM concurrent_writes ORDER BY value",
      );
      expect(result.rows.map((row) => row.value)).toEqual(["first", "second"]);
    } finally {
      await handle.shutdown();
    }
  });

  it("enforces read-only batch and transaction modes", async () => {
    const handle = await createSqliteStorage({}, ctx);
    try {
      await handle.client.execute("CREATE TABLE readonly_guard (value TEXT)");
      await expect(
        handle.client.batch(
          [{ sql: "INSERT INTO readonly_guard (value) VALUES (?)", args: ["blocked"] }],
          "read",
        ),
      ).rejects.toThrow(/read-only transaction/i);

      const tx = await handle.client.transaction("read");
      try {
        const selected = await tx.execute("SELECT count(*) AS count FROM readonly_guard");
        expect(selected.rows[0]?.count).toBe(0);
        const values = await tx.execute("VALUES (1)");
        expect(values.rows[0]?.column1).toBe(1);
        await expect(
          tx.execute({
            sql: "INSERT INTO readonly_guard (value) VALUES (?)",
            args: ["blocked"],
          }),
        ).rejects.toThrow(/read-only transaction/i);
        await expect(
          tx.execute(
            "WITH c AS (SELECT 'blocked' AS value) INSERT INTO readonly_guard (value) SELECT value FROM c",
          ),
        ).rejects.toThrow(/read-only transaction/i);
        await expect(tx.execute("PRAGMA user_version = 1")).rejects.toThrow(
          /read-only transaction/i,
        );
      } finally {
        await tx.rollback();
      }
    } finally {
      await handle.shutdown();
    }
  });
});

describe("storage config persistence", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-storage-cfg-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the local-only sqlite config when no file exists", () => {
    const path = resolve(tmp, "storage.json");
    const config = loadStorageConfig(path);
    expect(config).toEqual({ syncMethod: "none" });
    expect(existsSync(path)).toBe(false);
  });

  it("round-trips turso sync config through save + load", () => {
    const path = resolve(tmp, "storage.json");
    saveStorageConfig(path, {
      syncMethod: "turso",
      turso: { url: "libsql://x", authToken: "y" },
    });
    expect(loadStorageConfig(path)).toEqual({
      syncMethod: "turso",
      turso: { url: "libsql://x", authToken: "y" },
    });
  });

  it("falls back to the default for a legacy provider-shaped config (no boot crash)", () => {
    const path = resolve(tmp, "storage.json");
    writeFileSync(
      path,
      JSON.stringify({
        primary: { id: "local", config: {} },
        replicators: [],
      }),
    );
    // A daemon upgraded from the old provider model has this shape on disk.
    // loadStorageConfig runs in the StorageManager constructor, so it must not
    // throw — it falls back to the local-only default and lets host-config-sync
    // repopulate, instead of crash-looping the daemon.
    expect(loadStorageConfig(path)).toEqual({ syncMethod: "none" });
  });

  it("falls back to the default for a corrupt (non-JSON) config file", () => {
    const path = resolve(tmp, "storage.json");
    writeFileSync(path, "{ not valid json");
    expect(loadStorageConfig(path)).toEqual({ syncMethod: "none" });
  });
});
