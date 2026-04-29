import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  localStorageProvider,
  StorageRegistry,
  type ProviderStatus,
  type ReplicatorHandle,
  type ReplicatorProvider,
} from "spawntree-core";
import { HostConfigSync } from "../src/storage/host-sync.ts";
import { StorageManager } from "../src/storage/manager.ts";

/**
 * End-to-end integration test against a real `spawntree-host` process.
 *
 * Why: the host server's request router is a separate match block from
 * `handleAdmin`, and on PR #35 the daemon endpoints were silently 404-ing
 * because the router only dispatched `/api/hosts*`. Unit tests with a
 * stubbed fetch (`host-sync.test.ts`) did not catch it. This test boots
 * the real host binary, mints a daemon credential, pushes a config, and
 * asserts the daemon-side `HostConfigSync` reconciles the storage manager
 * to it — the same code path a real deployment exercises.
 *
 * Skipped automatically if `packages/host/dist/server.js` is missing
 * (e.g. running `pnpm test` without a prior `pnpm build`).
 */

const HOST_BIN = resolve(import.meta.dirname, "..", "..", "host", "dist", "server.js");
const haveHostBin = existsSync(HOST_BIN);
const describeIfBuilt = haveHostBin ? describe : describe.skip;

interface HostHandle {
  url: string;
  proc: ChildProcess;
  dbPath: string;
}

async function startHost(): Promise<HostHandle> {
  const port = 17000 + Math.floor(Math.random() * 1000);
  const dbDir = mkdtempSync(resolve(tmpdir(), "spawntree-host-int-"));
  const dbPath = resolve(dbDir, "hosts.db");
  const proc = spawn(process.execPath, [HOST_BIN], {
    env: {
      ...process.env,
      HOST_SERVER_PORT: String(port),
      HOST_SERVER_HOST: "127.0.0.1",
      HOST_SERVER_DB: dbPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Buffer all stderr/stdout so when the host crashes (e.g. better-sqlite3
  // native binding missing on CI runners), the test failure surfaces the
  // actual error instead of just `exit code 1`.
  const stderrBuf: Array<string> = [];
  const stdoutBuf: Array<string> = [];
  proc.stderr?.on("data", (c: Buffer) => stderrBuf.push(c.toString()));
  proc.stdout?.on("data", (c: Buffer) => stdoutBuf.push(c.toString()));

  // Wait for the server to log its listen line before issuing requests.
  // 15s timeout — generous for CI runners with cold caches and parallel
  // load. Local runs bind in <100ms.
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(
        new Error(
          `host did not become ready in 15s on :${port}\n--- stderr ---\n${stderrBuf.join("")}\n--- stdout ---\n${stdoutBuf.join("")}`,
        ),
      );
    }, 15_000);
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes(`listening on http://127.0.0.1:${port}`)) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(
        new Error(
          `host exited prematurely with code ${code}\n--- stderr ---\n${stderrBuf.join("")}\n--- stdout ---\n${stdoutBuf.join("")}`,
        ),
      );
    });
  });

  return { url: `http://127.0.0.1:${port}`, proc, dbPath };
}

async function stopHost(handle: HostHandle): Promise<void> {
  if (!handle.proc.killed) {
    handle.proc.kill("SIGTERM");
    await new Promise<void>((r) => handle.proc.once("exit", () => r()));
  }
  rmSync(resolve(handle.dbPath, ".."), { recursive: true, force: true });
}

/**
 * Fixture replicator. We assert reconciliation by counting active handles
 * and observing config the manager applied — same shape as the unit tests
 * in `storage-apply-config.test.ts`.
 */
function makeRecordingProvider(): {
  provider: ReplicatorProvider<{ tag?: string }>;
  active: () => Array<{ id: string }>;
} {
  const live: Array<{ id: string }> = [];
  let counter = 0;
  const provider: ReplicatorProvider<{ tag?: string }> = {
    id: "recording",
    kind: "replicator",
    async start(_config) {
      const id = `h${counter++}`;
      const handle: ReplicatorHandle = {
        async status(): Promise<ProviderStatus> {
          return { healthy: true };
        },
        async trigger(): Promise<ProviderStatus> {
          return { healthy: true };
        },
        async stop(): Promise<void> {
          const idx = live.findIndex((h) => h.id === id);
          if (idx >= 0) live.splice(idx, 1);
        },
      };
      live.push({ id });
      return handle;
    },
  };
  return { provider, active: () => [...live] };
}

describeIfBuilt("HostConfigSync end-to-end against real spawntree-host", () => {
  // Initialize to null so the cleanup hook is safe even if setup fails
  // partway through — otherwise vitest reports a confusing
  // `Cannot read properties of undefined (reading 'stop')` that masks
  // the real startup error.
  let host: HostHandle | null = null;
  let dataDir: string | null = null;
  let manager: StorageManager | null = null;
  let recording: ReturnType<typeof makeRecordingProvider>;

  beforeAll(async () => {
    host = await startHost();

    dataDir = mkdtempSync(resolve(tmpdir(), "spawntree-int-data-"));
    recording = makeRecordingProvider();
    const registry = new StorageRegistry();
    registry.registerPrimary(localStorageProvider);
    registry.registerReplicator(recording.provider);
    manager = new StorageManager({
      dataDir,
      logger: () => undefined,
      registry,
    });
    await manager.start();
  }, 30_000);

  afterAll(async () => {
    await manager?.stop().catch(() => undefined);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (host) await stopHost(host);
  });

  it("POST /api/daemons mints a credential (router dispatches /api/daemons*)", async () => {
    // This is the assertion that would have caught the routing bug Devin
    // flagged on PR #35: before the fix, this 404'd because the top-level
    // router only matched /api/hosts*.
    const res = await fetch(`${host!.url}/api/daemons`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "integration-test-daemon" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string; label: string };
    expect(body.key).toMatch(/^dh_[A-Za-z0-9_-]{40,}$/);
    expect(body.label).toBe("integration-test-daemon");
  });

  it("GET /api/daemons lists the minted daemon (fingerprint only, no full key)", async () => {
    const res = await fetch(`${host!.url}/api/daemons`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      daemons: Array<{ keyFingerprint: string; label: string; hasConfig: boolean }>;
    };
    expect(body.daemons.length).toBeGreaterThanOrEqual(1);
    const minted = body.daemons.find((d) => d.label === "integration-test-daemon");
    expect(minted).toBeDefined();
    expect(minted!.keyFingerprint).toMatch(/^dh_[A-Za-z0-9_-]+$/);
    // Listing should NOT include the full key, only the 12-char fingerprint.
    expect(minted!.keyFingerprint.length).toBeLessThan(20);
    expect(minted!.hasConfig).toBe(false);
  });

  it("GET /api/daemons/me/config returns 401 without a bearer token", async () => {
    const res = await fetch(`${host!.url}/api/daemons/me/config`);
    expect(res.status).toBe(401);
  });

  it("happy path: mint → push config → daemon-side sync applies it", async () => {
    // 1. Mint a fresh daemon.
    const mint = await fetch(`${host!.url}/api/daemons`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "e2e-flow" }),
    });
    expect(mint.status).toBe(201);
    const { key } = (await mint.json()) as { key: string };

    // 2. Operator pushes a config for that daemon.
    const put = await fetch(`${host!.url}/api/daemons/${encodeURIComponent(key)}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: {
          primary: { id: "local", config: {} },
          replicators: [
            { rid: "from-host", id: "recording", config: { tag: "alpha" } },
          ],
        },
      }),
    });
    expect(put.status).toBe(200);

    // 3. Daemon-side: HostConfigSync reads `me/config` and reconciles.
    const sync = new HostConfigSync({
      binding: { url: host!.url, key },
      manager: manager!,
      logger: () => undefined,
      pollIntervalMs: 1_000_000, // disable polling; we drive it manually
      backoffSequenceMs: [50],
    });
    await sync.refreshNow();
    await sync.stop();

    // 4. The replicator declared by the host should now be live.
    const status = await manager!.status();
    expect(status.replicators.map((r) => r.rid)).toContain("from-host");
    expect(recording.active().length).toBeGreaterThanOrEqual(1);
  });
});
