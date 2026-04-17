import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  localStorageProvider,
  StorageRegistry,
  loadStorageConfig,
  saveStorageConfig,
  type StorageContext,
} from "../src/storage/index.ts";

describe("StorageRegistry", () => {
  it("registers and retrieves primary providers by id", () => {
    const r = new StorageRegistry();
    r.registerPrimary(localStorageProvider);
    expect(r.getPrimary("local")).toBe(localStorageProvider);
    expect(r.getPrimary("unknown")).toBeUndefined();
    expect(r.listPrimaries().map((p) => p.id)).toEqual(["local"]);
  });

  it("rejects duplicate primary registration", () => {
    const r = new StorageRegistry();
    r.registerPrimary(localStorageProvider);
    expect(() => r.registerPrimary(localStorageProvider)).toThrow(/already registered/);
  });
});

describe("localStorageProvider", () => {
  let tmp: string;
  let ctx: StorageContext;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-storage-test-"));
    ctx = { dataDir: tmp, logger: () => undefined };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a usable libSQL client at <dataDir>/spawntree.db by default", async () => {
    const handle = await localStorageProvider.create({}, ctx);
    expect(handle.dbPath).toBe(resolve(tmp, "spawntree.db"));

    const result = await handle.client.execute("SELECT 42 as answer");
    expect(result.rows[0]?.answer).toBe(42);

    const status = await handle.status();
    expect(status.healthy).toBe(true);
    expect(status.lagMs).toBe(0);

    await handle.shutdown();
  });

  it("respects an explicit path", async () => {
    const custom = resolve(tmp, "custom.db");
    const handle = await localStorageProvider.create({ path: custom }, ctx);
    expect(handle.dbPath).toBe(custom);
    await handle.client.execute("CREATE TABLE t (x INTEGER)");
    await handle.client.execute("INSERT INTO t VALUES (1)");
    const result = await handle.client.execute("SELECT x FROM t");
    expect(result.rows.length).toBe(1);
    await handle.shutdown();
  });
});

describe("config persistence", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-storage-cfg-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the default config when no file exists", () => {
    const path = resolve(tmp, "storage.json");
    const config = loadStorageConfig(path);
    expect(config.primary.id).toBe("local");
    expect(config.replicators).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it("round-trips config through save + load", () => {
    const path = resolve(tmp, "storage.json");
    saveStorageConfig(path, {
      primary: { id: "turso-embedded", config: { syncUrl: "libsql://x", authToken: "y" } },
      replicators: [
        {
          rid: "s3-prod",
          id: "s3-snapshot",
          config: { bucket: "b", accessKeyId: "a", secretAccessKey: "s" },
        },
      ],
    });
    const loaded = loadStorageConfig(path);
    expect(loaded.primary.id).toBe("turso-embedded");
    expect(loaded.replicators.length).toBe(1);
    expect(loaded.replicators[0]!.rid).toBe("s3-prod");
  });
});
