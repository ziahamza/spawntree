import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  localStorageProvider,
  StorageRegistry,
  type ProviderStatus,
  type ReplicatorHandle,
  type ReplicatorProvider,
  type StorageConfig,
} from "spawntree-core";
import { StorageManager } from "../src/storage/manager.ts";

/**
 * Cover `StorageManager.applyConfig` — the entry point `HostConfigSync`
 * uses to drive the manager from a centralized config without going
 * through the per-route admin API.
 *
 * Reconciliation rules:
 *   1. Primary first. If it differs, swap (with data migration).
 *   2. For replicators: diff by `rid`. Same `id` + canonical-equal config
 *      is a no-op (handle is preserved). Anything else is a remove + add.
 *   3. Anything in current but not in target gets removed.
 *   4. Whole operation runs inside the manager's lock so a concurrent
 *      admin-API call can't observe a half-applied state.
 */

interface RecordingHandle extends ReplicatorHandle {
  readonly id: string;
  readonly stops: { count: number };
}

function makeRecordingProvider(): {
  provider: ReplicatorProvider<{ tag?: string }>;
  active: () => Array<RecordingHandle>;
} {
  const liveHandles: Array<RecordingHandle> = [];
  let counter = 0;
  const provider: ReplicatorProvider<{ tag?: string }> = {
    id: "recording",
    kind: "replicator",
    async start(_config) {
      const id = `h${counter++}`;
      const stops = { count: 0 };
      const handle: RecordingHandle = {
        id,
        stops,
        async status(): Promise<ProviderStatus> {
          return { healthy: true };
        },
        async trigger(): Promise<ProviderStatus> {
          return { healthy: true };
        },
        async stop(): Promise<void> {
          stops.count++;
          const idx = liveHandles.findIndex((h) => h.id === id);
          if (idx >= 0) liveHandles.splice(idx, 1);
        },
      };
      liveHandles.push(handle);
      return handle;
    },
  };
  return { provider, active: () => [...liveHandles] };
}

describe("StorageManager.applyConfig", () => {
  let tmp: string;
  let recording: ReturnType<typeof makeRecordingProvider>;
  let manager: StorageManager;

  beforeEach(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-apply-cfg-"));
    recording = makeRecordingProvider();
    const registry = new StorageRegistry();
    registry.registerPrimary(localStorageProvider);
    registry.registerReplicator(recording.provider);
    manager = new StorageManager({
      dataDir: tmp,
      logger: () => undefined,
      registry,
    });
    await manager.start();
  });

  afterEach(async () => {
    await manager.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("is a no-op when target equals current (no replicators flap)", async () => {
    await manager.addReplicator("r1", "recording", { tag: "alpha" });
    const initial = recording.active();
    expect(initial).toHaveLength(1);
    const initialId = initial[0]!.id;

    await manager.applyConfig({
      primary: { id: "local", config: {} },
      replicators: [{ rid: "r1", id: "recording", config: { tag: "alpha" } }],
    });

    const after = recording.active();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(initialId);
    expect(after[0]!.stops.count).toBe(0);
  });

  it("adds a brand-new replicator from target", async () => {
    expect(recording.active()).toHaveLength(0);

    await manager.applyConfig({
      primary: { id: "local", config: {} },
      replicators: [{ rid: "fresh", id: "recording", config: { tag: "x" } }],
    });

    expect(recording.active()).toHaveLength(1);
    const status = await manager.status();
    expect(status.replicators.map((r) => r.rid)).toEqual(["fresh"]);
  });

  it("removes a replicator that's not in the target", async () => {
    await manager.addReplicator("doomed", "recording", { tag: "x" });
    const handle = recording.active()[0]!;
    expect(handle.stops.count).toBe(0);

    await manager.applyConfig({
      primary: { id: "local", config: {} },
      replicators: [],
    });

    expect(handle.stops.count).toBe(1);
    expect(recording.active()).toHaveLength(0);
    const status = await manager.status();
    expect(status.replicators).toEqual([]);
  });

  it("replaces a replicator whose config changed (stop + start)", async () => {
    await manager.addReplicator("r1", "recording", { tag: "old" });
    const oldHandle = recording.active()[0]!;
    expect(oldHandle.stops.count).toBe(0);

    await manager.applyConfig({
      primary: { id: "local", config: {} },
      replicators: [{ rid: "r1", id: "recording", config: { tag: "new" } }],
    });

    expect(oldHandle.stops.count).toBe(1);
    const live = recording.active();
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe(oldHandle.id);
  });

  it("handles add + remove + replace in one apply atomically", async () => {
    await manager.addReplicator("keep", "recording", { tag: "k" });
    await manager.addReplicator("drop", "recording", { tag: "d" });
    await manager.addReplicator("change", "recording", { tag: "before" });

    const initial = recording.active();
    expect(initial).toHaveLength(3);

    const target: StorageConfig = {
      primary: { id: "local", config: {} },
      replicators: [
        { rid: "keep", id: "recording", config: { tag: "k" } },
        { rid: "change", id: "recording", config: { tag: "after" } },
        { rid: "added", id: "recording", config: { tag: "new" } },
      ],
    };
    await manager.applyConfig(target);

    const status = await manager.status();
    expect(status.replicators.map((r) => r.rid).sort()).toEqual(["added", "change", "keep"]);
  });

  it("drops the cached config back to the new target so subsequent reads match", async () => {
    await manager.applyConfig({
      primary: { id: "local", config: {} },
      replicators: [{ rid: "r1", id: "recording", config: { tag: "first" } }],
    });
    await manager.applyConfig({
      primary: { id: "local", config: {} },
      replicators: [{ rid: "r2", id: "recording", config: { tag: "second" } }],
    });
    const status = await manager.status();
    expect(status.replicators.map((r) => r.rid)).toEqual(["r2"]);
  });
});
