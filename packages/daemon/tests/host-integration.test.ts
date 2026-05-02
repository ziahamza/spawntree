import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
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
import { createApp, openStore, type Store } from "spawntree-host";
import { HostConfigSync } from "../src/storage/host-sync.ts";
import { StorageManager } from "../src/storage/manager.ts";

/**
 * End-to-end integration test against the host's `createApp` factory —
 * the same handler the CLI bin runs, just bound to a random port in this
 * test's process. No child-process spawning, no `--frozen-lockfile`
 * native-bindings dance, no "wait for stderr" race.
 *
 * Why this test exists: on PR #35 the host's request router silently
 * dropped `/api/daemons*` paths because the dispatch guard only matched
 * `/api/hosts*`. The unit-tested daemon-side fetch loop (`host-sync.test.ts`)
 * stubs fetch, so it didn't notice the entire feature was 404-ing on the
 * server side. Here we wire the real handler to an http.Server and assert
 * the daemon-side `HostConfigSync` reconciles a config the host gives it
 * — the same code path a real deployment exercises.
 *
 * Earlier iteration (PR #35 followups, before this rewrite) shelled out to
 * `packages/host/dist/server.js`. That worked but added a 1-2s startup
 * tax per beforeAll and tied the test to `pnpm build` ordering. The
 * factory split makes both go away.
 */

interface HostHandle {
  url: string;
  server: Server;
  store: Store;
  dbDir: string;
}

async function startHost(): Promise<HostHandle> {
  const dbDir = mkdtempSync(resolve(tmpdir(), "spawntree-host-int-"));
  const dbPath = resolve(dbDir, "hosts.db");
  const store = openStore(dbPath);
  const { handler } = createApp({ store, host: "127.0.0.1", port: 0 });
  const server = createServer(handler);

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    server,
    store,
    dbDir,
  };
}

async function stopHost(handle: HostHandle): Promise<void> {
  await new Promise<void>((r) => handle.server.close(() => r()));
  rmSync(handle.dbDir, { recursive: true, force: true });
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

describe("HostConfigSync end-to-end against in-process spawntree-host", () => {
  // Initialize to null so cleanup is safe even if setup fails partway.
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
  });

  afterAll(async () => {
    await manager?.stop().catch(() => undefined);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (host) await stopHost(host);
  });

  it("POST /api/daemons mints a credential (router dispatches /api/daemons*)", async () => {
    // The assertion that would have caught the routing bug Devin flagged
    // on PR #35: before the fix, this 404'd because the top-level router
    // only matched /api/hosts*.
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
          replicators: [{ rid: "from-host", id: "recording", config: { tag: "alpha" } }],
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

  it("GET / renders the landing page including the daemons section (UX wired up)", async () => {
    // Smoke-tests the landing-page enrichment: the page now lists
    // registered daemons alongside federation hosts. If we ever break the
    // template, the curl-paste-ready instructions go with it.
    const res = await fetch(`${host!.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("Daemons (--host / --host-key)");
    expect(html).toContain("integration-test-daemon");
    expect(html).toContain("e2e-flow");
  });
});
