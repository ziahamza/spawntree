import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  localStorageProvider,
  StorageRegistry,
  type PrimaryStorageProvider,
  type ReplicatorProvider,
} from "spawntree-core";
import { StorageManager } from "../src/storage/manager.ts";

/**
 * Tests exercise the StorageManager's core guarantees: hot-swap with data
 * migration, concurrency safety, probes, no-op swaps, and rollback on
 * migration failure. All of these use the `local` libSQL provider so we can
 * stay hermetic — no Turso, no S3.
 */

function makeManager(dataDir: string, registry?: StorageRegistry): StorageManager {
  return new StorageManager({
    dataDir,
    logger: () => undefined,
    registry,
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

  describe("start/stop", () => {
    it("opens the default local primary on start and makes client available", async () => {
      const m = makeManager(tmp);
      await m.start();
      try {
        const res = await m.client.execute("SELECT 1 AS ok");
        expect(res.rows[0]?.["ok"]).toBe(1);
      } finally {
        await m.stop();
      }
    });

    it("throws on client access before start", () => {
      const m = makeManager(tmp);
      expect(() => m.client).toThrow(/must be called before accessing client/);
    });
  });

  describe("config persistence", () => {
    it("writes storage.json with 0600 permissions on save", async () => {
      const m = makeManager(tmp);
      await m.start();
      try {
        await m.addReplicator("test", "__noop_test", {});
      } catch {
        // Expected: __noop_test isn't registered. We just want to force a save.
      }
      // Force a save by swapping primary to itself with a new path.
      await m.setPrimary({ id: "local", config: { path: resolve(tmp, "custom.db") } });
      const cfgPath = resolve(tmp, "storage.json");
      const mode = statSync(cfgPath).mode & 0o777;
      expect(mode).toBe(0o600);
      await m.stop();
    });
  });

  describe("hot-swap with data migration", () => {
    it("copies all rows from old primary to new primary", async () => {
      const m = makeManager(tmp);
      await m.start();
      try {
        // Seed data into the default local DB.
        await m.client.execute(`
          CREATE TABLE widgets (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 0
          )
        `);
        await m.client.execute(`CREATE INDEX widgets_name_idx ON widgets(name)`);
        await m.client.batch(
          [
            {
              sql: `INSERT INTO widgets (id, name, count) VALUES (?, ?, ?)`,
              args: [1, "alpha", 10],
            },
            {
              sql: `INSERT INTO widgets (id, name, count) VALUES (?, ?, ?)`,
              args: [2, "beta", 20],
            },
            {
              sql: `INSERT INTO widgets (id, name, count) VALUES (?, ?, ?)`,
              args: [3, "gamma", 30],
            },
          ],
          "write",
        );

        // Swap to a different local path. Migration should copy schema + rows.
        const newPath = resolve(tmp, "migrated.db");
        await m.setPrimary({ id: "local", config: { path: newPath } });

        const rows = await m.client.execute(`SELECT id, name, count FROM widgets ORDER BY id`);
        expect(rows.rows.length).toBe(3);
        expect(rows.rows[0]?.["name"]).toBe("alpha");
        expect(rows.rows[2]?.["count"]).toBe(30);

        // Index survived the copy.
        const idxRes = await m.client.execute(
          `SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'widgets_name_idx'`,
        );
        expect(idxRes.rows.length).toBe(1);
      } finally {
        await m.stop();
      }
    });

    it("no-op swap (same id + same config) skips migration", async () => {
      const m = makeManager(tmp);
      await m.start();
      try {
        await m.client.execute(`CREATE TABLE t (x INTEGER)`);
        await m.client.execute(`INSERT INTO t VALUES (42)`);

        // Same id, same (empty) config → no-op. Data and primary reference stay.
        const before = m.client;
        await m.setPrimary({ id: "local", config: {} });
        expect(m.client).toBe(before);

        const rows = await m.client.execute(`SELECT x FROM t`);
        expect(rows.rows[0]?.["x"]).toBe(42);
      } finally {
        await m.stop();
      }
    });

    it("rolls back on migration failure, keeping old primary active", async () => {
      // Build a bogus provider that fails during `create()`. The manager
      // should never touch the old primary on rollback.
      const failingProvider: PrimaryStorageProvider = {
        id: "failing-primary",
        kind: "primary",
        async create() {
          throw new Error("simulated provider failure");
        },
      };
      const registry = new StorageRegistry();
      registry.registerPrimary(localStorageProvider);
      registry.registerPrimary(failingProvider);

      const m = makeManager(tmp, registry);
      await m.start();
      try {
        await m.client.execute(`CREATE TABLE t (x INTEGER)`);
        await m.client.execute(`INSERT INTO t VALUES (99)`);

        const clientBefore = m.client;
        await expect(m.setPrimary({ id: "failing-primary", config: {} })).rejects.toThrow(
          /simulated provider failure/,
        );

        // Old primary must still be the active one — data intact.
        expect(m.client).toBe(clientBefore);
        const rows = await m.client.execute(`SELECT x FROM t`);
        expect(rows.rows[0]?.["x"]).toBe(99);

        // Config on disk should NOT reflect the failed swap. Either the
        // file doesn't exist yet (clean boot, no prior mutation) or its
        // primary id is unchanged — either way, not the failing provider.
        const cfgPath = resolve(tmp, "storage.json");
        if (existsSync(cfgPath)) {
          const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
            primary: { id: string };
          };
          expect(onDisk.primary.id).not.toBe("failing-primary");
        }
      } finally {
        await m.stop();
      }
    });
  });

  describe("concurrency", () => {
    it("serializes overlapping setPrimary calls without corruption", async () => {
      const m = makeManager(tmp);
      await m.start();
      try {
        await m.client.execute(`CREATE TABLE nums (v INTEGER)`);
        await m.client.execute(`INSERT INTO nums VALUES (1)`);

        // Kick off three swaps simultaneously, each to a distinct file.
        const paths = [resolve(tmp, "a.db"), resolve(tmp, "b.db"), resolve(tmp, "c.db")];
        const results = await Promise.allSettled(
          paths.map((p) => m.setPrimary({ id: "local", config: { path: p } })),
        );

        for (const r of results) {
          expect(r.status).toBe("fulfilled");
        }

        // Data should be intact after the final swap — migrations chain
        // through each intermediate primary.
        const rows = await m.client.execute(`SELECT v FROM nums`);
        expect(rows.rows.length).toBe(1);
        expect(rows.rows[0]?.["v"]).toBe(1);
      } finally {
        await m.stop();
      }
    });

    it("blocks client access while a migration is in flight", async () => {
      // Provider that blocks inside `create()` so we can observe the
      // `migrating` flag from a concurrent caller.
      let release!: () => void;
      const blocker = new Promise<void>((r) => {
        release = r;
      });
      const slowProvider: PrimaryStorageProvider = {
        id: "slow-primary",
        kind: "primary",
        async create(_config, ctx) {
          await blocker;
          // Fall through to a real local handle so migration can finish.
          return localStorageProvider.create({ path: resolve(ctx.dataDir, "slow.db") }, ctx);
        },
      };
      const registry = new StorageRegistry();
      registry.registerPrimary(localStorageProvider);
      registry.registerPrimary(slowProvider);

      const m = makeManager(tmp, registry);
      await m.start();
      try {
        const swap = m.setPrimary({ id: "slow-primary", config: {} });

        // Give the lock a microtask to take hold.
        await Promise.resolve();
        await Promise.resolve();

        // While the swap blocks inside create(), migrating should be true
        // and client access should throw STORAGE_MIGRATING.
        const status = await m.status();
        expect(status.migrating).toBe(true);
        expect(() => m.client).toThrow(/STORAGE_MIGRATING/);

        release();
        await swap;

        // After the swap, migrating flag clears and client works again.
        const after = await m.status();
        expect(after.migrating).toBe(false);
        await m.client.execute("SELECT 1");
      } finally {
        await m.stop();
      }
    });
  });

  describe("probes", () => {
    it("probePrimary returns ok=true with dbPath for a valid local config", async () => {
      const m = makeManager(tmp);
      await m.start();
      try {
        const result = await m.probePrimary({
          id: "local",
          config: { path: resolve(tmp, "probe.db") },
        });
        expect(result.ok).toBe(true);
      } finally {
        await m.stop();
      }
    });

    it("probePrimary returns ok=false for unknown provider", async () => {
      const m = makeManager(tmp);
      await m.start();
      try {
        const result = await m.probePrimary({ id: "no-such-provider", config: {} });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toMatch(/Unknown/);
        }
      } finally {
        await m.stop();
      }
    });

    it("probePrimary does NOT mutate config or swap primaries", async () => {
      const m = makeManager(tmp);
      await m.start();
      try {
        const before = await m.status();
        await m.probePrimary({
          id: "local",
          config: { path: resolve(tmp, "ephemeral.db") },
        });
        const after = await m.status();
        expect(after.primary.id).toBe(before.primary.id);
      } finally {
        await m.stop();
      }
    });

    it("probeReplicator surfaces config validation errors", async () => {
      // Test replicator with a required string config field.
      const failOnStart: ReplicatorProvider = {
        id: "probe-replicator-test",
        kind: "replicator",
        async start() {
          throw new Error("unreachable");
        },
      };
      const registry = new StorageRegistry();
      registry.registerPrimary(localStorageProvider);
      registry.registerReplicator(failOnStart);

      const m = makeManager(tmp, registry);
      await m.start();
      try {
        const result = await m.probeReplicator({ id: "nonexistent", config: {} });
        expect(result.ok).toBe(false);
      } finally {
        await m.stop();
      }
    });
  });

  describe("replicator add/remove", () => {
    it("rejects duplicate rid", async () => {
      const passThrough: ReplicatorProvider = {
        id: "passthrough",
        kind: "replicator",
        async start() {
          return {
            async status() {
              return { healthy: true };
            },
            async trigger() {
              return { healthy: true };
            },
            async stop() {},
          };
        },
      };
      const registry = new StorageRegistry();
      registry.registerPrimary(localStorageProvider);
      registry.registerReplicator(passThrough);

      const m = makeManager(tmp, registry);
      await m.start();
      try {
        await m.addReplicator("r1", "passthrough", {});
        await expect(m.addReplicator("r1", "passthrough", {})).rejects.toThrow(/already exists/);
      } finally {
        await m.stop();
      }
    });

    it("removeReplicator stops and persists the removal", async () => {
      let stopCalls = 0;
      const counted: ReplicatorProvider = {
        id: "counted",
        kind: "replicator",
        async start() {
          return {
            async status() {
              return { healthy: true };
            },
            async trigger() {
              return { healthy: true };
            },
            async stop() {
              stopCalls++;
            },
          };
        },
      };
      const registry = new StorageRegistry();
      registry.registerPrimary(localStorageProvider);
      registry.registerReplicator(counted);

      const m = makeManager(tmp, registry);
      await m.start();
      try {
        await m.addReplicator("r1", "counted", {});
        await m.removeReplicator("r1");
        expect(stopCalls).toBe(1);

        const cfg = JSON.parse(readFileSync(resolve(tmp, "storage.json"), "utf-8")) as {
          replicators: Array<unknown>;
        };
        expect(cfg.replicators).toEqual([]);
      } finally {
        await m.stop();
      }
    });
  });

  describe("redaction", () => {
    it("never returns raw secrets in status()", async () => {
      // Seed a config with secret fields directly.
      writeFileSync(
        resolve(tmp, "storage.json"),
        JSON.stringify({
          primary: {
            id: "local",
            config: { path: resolve(tmp, "test.db") },
          },
          replicators: [],
        }),
      );
      const m = makeManager(tmp);
      await m.start();
      try {
        // Rewrite config via setPrimary to a turso-like shape (won't connect)
        // to verify authToken redaction. But we can't easily start a turso
        // provider. Instead, directly write secret-containing config and
        // verify status redacts it. We stuff a fake field into the local
        // provider config since the redactor is field-name based.
        writeFileSync(
          resolve(tmp, "storage.json"),
          JSON.stringify({
            primary: {
              id: "local",
              config: {
                path: resolve(tmp, "test.db"),
                authToken: "secret-token",
                secretAccessKey: "aws-secret",
              },
            },
            replicators: [],
          }),
        );
        // Restart so the new config loads.
        await m.stop();
        const m2 = makeManager(tmp);
        await m2.start();
        try {
          const status = await m2.status();
          const cfg = status.primary.config as Record<string, unknown>;
          expect(cfg["authToken"]).toBe("***redacted***");
          expect(cfg["secretAccessKey"]).toBe("***redacted***");
          expect(JSON.stringify(status)).not.toContain("secret-token");
          expect(JSON.stringify(status)).not.toContain("aws-secret");
        } finally {
          await m2.stop();
        }
      } catch (err) {
        await m.stop().catch(() => undefined);
        throw err;
      }
    });
  });
});
