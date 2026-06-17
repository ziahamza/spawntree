import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteStorageHandle } from "spawntree-core";
import { applyCatalogSchema } from "../src/catalog/queries.ts";
import { StorageManager } from "../src/storage/manager.ts";

function makeManager(dataDir: string): StorageManager {
  return new StorageManager({
    dataDir,
    logger: () => undefined,
  });
}

describe("StorageManager", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-sm-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("opens sqlite storage by default and exposes a catalog client", async () => {
    const m = makeManager(tmp);
    await m.start();
    try {
      const res = await m.client.execute("SELECT 1 AS ok");
      expect(res.rows[0]?.ok).toBe(1);

      const status = await m.status();
      expect(status.storage.id).toBe("sqlite");
      expect(status.sync.method).toBe("none");
      expect(status.reconfiguring).toBe(false);
    } finally {
      await m.stop();
    }
  });

  it("throws on client access before start", () => {
    const m = makeManager(tmp);
    expect(() => m.client).toThrow(/must be called before accessing client/);
  });

  it("reconfigures from local-only to turso without moving the sqlite source of truth", async () => {
    const m = makeManager(tmp);
    await m.start();
    try {
      await applyCatalogSchema(m.client);
      await m.client.execute({
        sql: "INSERT INTO repos (id, slug, name, provider, registered_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: ["r1", "r1", "r1", "github", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
      });

      await m.applyConfig({
        syncMethod: "turso",
        turso: {
          url: "http://127.0.0.1:9",
          authToken: "rw-token",
          syncIntervalSec: 0,
          requestTimeoutMs: 50,
        },
      });

      const status = await m.status();
      expect(status.storage.id).toBe("sqlite");
      expect(status.sync.method).toBe("turso");
      expect(status.storage.status.info).toMatchObject({
        path: resolve(tmp, "spawntree.db"),
        url: "http://127.0.0.1:9",
      });

      const rows = await m.client.execute("SELECT id FROM repos WHERE id = 'r1'");
      expect(rows.rows).toHaveLength(1);
    } finally {
      await m.stop();
    }
  });

  it("persists sync config with 0600 permissions", async () => {
    const m = makeManager(tmp);
    await m.start();
    try {
      await m.applyConfig({
        syncMethod: "turso",
        turso: {
          url: "http://127.0.0.1:9",
          authToken: "rw-token",
          syncIntervalSec: 0,
          requestTimeoutMs: 50,
        },
      });

      const cfgPath = resolve(tmp, "storage.json");
      const mode = statSync(cfgPath).mode & 0o777;
      expect(mode).toBe(0o600);
      const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
        syncMethod?: string;
        turso?: { authToken?: string };
      };
      expect(onDisk.syncMethod).toBe("turso");
      expect(onDisk.turso?.authToken).toBe("rw-token");
    } finally {
      await m.stop();
    }
  });

  it("rejects incomplete turso sync config and keeps the previous config active", async () => {
    const m = makeManager(tmp);
    await m.start();
    try {
      await expect(m.applyConfig({ syncMethod: "turso" } as never)).rejects.toThrow();
      const status = await m.status();
      expect(status.sync.method).toBe("none");
      await m.client.execute("SELECT 1");
    } finally {
      await m.stop();
    }
  });

  it("rolls back if persisted sync config cannot be written", async () => {
    const m = makeManager(tmp);
    await m.start();
    try {
      mkdirSync(resolve(tmp, "storage.json"));

      await expect(
        m.applyConfig({
          syncMethod: "turso",
          turso: {
            url: "http://127.0.0.1:9",
            authToken: "rw-token",
            syncIntervalSec: 0,
            requestTimeoutMs: 50,
          },
        }),
      ).rejects.toThrow();

      const status = await m.status();
      expect(status.sync.method).toBe("none");
      expect(status.reconfiguring).toBe(false);
      const res = await m.client.execute("SELECT 1 AS ok");
      expect(res.rows[0]?.ok).toBe(1);
    } finally {
      await m.stop();
    }
  });

  it("clears reconfiguring if the active sqlite handle fails to shut down", async () => {
    const m = makeManager(tmp);
    await m.start();
    const sqlite = (m as unknown as { sqlite: SqliteStorageHandle }).sqlite;
    const shutdown = sqlite.shutdown.bind(sqlite);
    let failShutdown = true;
    sqlite.shutdown = async () => {
      if (failShutdown) {
        failShutdown = false;
        throw new Error("forced shutdown failure");
      }
      await shutdown();
    };

    try {
      await expect(
        m.applyConfig({
          syncMethod: "turso",
          turso: {
            url: "http://127.0.0.1:9",
            authToken: "rw-token",
            syncIntervalSec: 0,
            requestTimeoutMs: 50,
          },
        }),
      ).rejects.toThrow("forced shutdown failure");

      const status = await m.status();
      expect(status.sync.method).toBe("none");
      expect(status.reconfiguring).toBe(false);
      const res = await m.client.execute("SELECT 1 AS ok");
      expect(res.rows[0]?.ok).toBe(1);
    } finally {
      sqlite.shutdown = shutdown;
      await m.stop();
    }
  });

  it("redacts sync credentials in status", async () => {
    const m = makeManager(tmp);
    await m.start();
    try {
      await m.applyConfig({
        syncMethod: "turso",
        turso: {
          url: "http://127.0.0.1:9",
          authToken: "secret-token",
          syncIntervalSec: 0,
          requestTimeoutMs: 50,
        },
      });

      const status = await m.status();
      expect(JSON.stringify(status)).not.toContain("secret-token");
      expect(status.sync.config).toMatchObject({ authToken: "***redacted***" });
      expect(status.storage.config).toMatchObject({
        turso: { authToken: "***redacted***" },
      });
    } finally {
      await m.stop();
    }
  });

  it("allows Turso token rotation on the same remote URL", async () => {
    const m = makeManager(tmp);
    await m.start();
    try {
      await m.applyConfig({
        syncMethod: "turso",
        turso: {
          url: "http://127.0.0.1:9",
          authToken: "old-token",
          syncIntervalSec: 0,
          requestTimeoutMs: 50,
        },
      });

      await m.applyConfig({
        syncMethod: "turso",
        turso: {
          url: "http://127.0.0.1:9",
          authToken: "new-token",
          syncIntervalSec: 0,
          requestTimeoutMs: 50,
        },
      });

      const status = await m.status();
      expect(status.sync.method).toBe("turso");
      expect(status.storage.status.info).toMatchObject({
        path: resolve(tmp, "spawntree.db"),
        url: "http://127.0.0.1:9",
      });
    } finally {
      await m.stop();
    }
  });

  it("rejects changing Turso remote URL without resetting the local catalog", async () => {
    const m = makeManager(tmp);
    await m.start();
    try {
      await m.applyConfig({
        syncMethod: "turso",
        turso: {
          url: "http://127.0.0.1:9",
          authToken: "old-token",
          syncIntervalSec: 0,
          requestTimeoutMs: 50,
        },
      });

      await expect(
        m.applyConfig({
          syncMethod: "turso",
          turso: {
            url: "http://127.0.0.1:10",
            authToken: "new-token",
            syncIntervalSec: 0,
            requestTimeoutMs: 50,
          },
        }),
      ).rejects.toThrow(/Changing the Turso sync URL/);

      const status = await m.status();
      expect(status.sync.method).toBe("turso");
      expect(status.reconfiguring).toBe(false);
      expect(status.storage.status.info).toMatchObject({
        path: resolve(tmp, "spawntree.db"),
        url: "http://127.0.0.1:9",
      });
    } finally {
      await m.stop();
    }
  });
});
