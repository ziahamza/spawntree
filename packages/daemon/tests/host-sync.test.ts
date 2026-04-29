import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localStorageProvider, StorageRegistry } from "spawntree-core";
import { StorageManager } from "../src/storage/manager.ts";
import { HostConfigSync } from "../src/storage/host-sync.ts";

/**
 * Cover the daemon-side host-config-sync loop with a stubbed `fetch`:
 *   - Authorization header: bearer host-key, never the URL.
 *   - URL: <binding.url>/api/daemons/me/config.
 *   - Success: payload's StorageConfig is applied via manager.applyConfig.
 *   - 404: status becomes `awaiting_config`, no config write.
 *   - 5xx / network error: status becomes `error` with backoff scheduled.
 *   - Bad JSON / missing `config`: error path.
 *   - stop(): cancels next scheduled fetch and waits for in-flight.
 *
 * Tests use a no-op fetch (we control the response) and tiny backoff so
 * they don't depend on real network or wall-clock delays.
 */

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  method: string;
}

function makeStubFetch(
  responses: Array<Response | (() => Promise<Response> | Response) | Error>,
): { fetch: typeof fetch; calls: Array<FetchCall> } {
  const calls: Array<FetchCall> = [];
  let i = 0;
  const stub: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const hdrInit = init?.headers ?? {};
    const headers: Record<string, string> = {};
    if (hdrInit instanceof Headers) {
      hdrInit.forEach((v, k) => {
        headers[k] = v;
      });
    } else {
      Object.assign(headers, hdrInit);
    }
    calls.push({ url, headers, method: init?.method ?? "GET" });

    const r = responses[i++] ?? responses[responses.length - 1];
    if (r instanceof Error) throw r;
    if (typeof r === "function") return r();
    return r as Response;
  };
  return { fetch: stub, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TEST_KEY = "dh_TESTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

describe("HostConfigSync", () => {
  let tmp: string;
  let manager: StorageManager;

  beforeEach(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-host-sync-"));
    const registry = new StorageRegistry();
    registry.registerPrimary(localStorageProvider);
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

  it("hits <host>/api/daemons/me/config with the bearer key", async () => {
    const { fetch, calls } = makeStubFetch([
      jsonResponse({
        config: { primary: { id: "local", config: {} }, replicators: [] },
        daemon: { label: "laptop" },
      }),
    ]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      logger: () => undefined,
    });
    await sync.refreshNow();
    await sync.stop();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://controller:7777/api/daemons/me/config");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers["Authorization"] || calls[0]!.headers["authorization"]).toBe(
      `Bearer ${TEST_KEY}`,
    );
  });

  it("strips trailing slash from the binding URL", async () => {
    const { fetch, calls } = makeStubFetch([
      jsonResponse({ config: { primary: { id: "local", config: {} }, replicators: [] } }),
    ]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777/", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      logger: () => undefined,
    });
    await sync.refreshNow();
    await sync.stop();
    expect(calls[0]!.url).toBe("http://controller:7777/api/daemons/me/config");
  });

  it("on success: applies the config and reports state=synced", async () => {
    const { fetch } = makeStubFetch([
      jsonResponse({
        config: { primary: { id: "local", config: {} }, replicators: [] },
        daemon: { label: "ci-runner" },
      }),
    ]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      logger: () => undefined,
    });
    await sync.refreshNow();
    await sync.stop();

    const status = sync.getStatus();
    expect(status.state).toBe("synced");
    if (status.state === "synced") {
      expect(status.daemonLabel).toBe("ci-runner");
      expect(status.lastSyncAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("on 404: state=awaiting_config, daemon's local config untouched", async () => {
    const { fetch } = makeStubFetch([
      jsonResponse({ daemon: { label: "fresh" } }, 404),
    ]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      logger: () => undefined,
    });
    await sync.refreshNow();
    await sync.stop();

    const status = sync.getStatus();
    expect(status.state).toBe("awaiting_config");
    if (status.state === "awaiting_config") {
      expect(status.daemonLabel).toBe("fresh");
    }

    const managerStatus = await manager.status();
    expect(managerStatus.primary.id).toBe("local");
    expect(managerStatus.replicators).toEqual([]);
  });

  it("on 5xx: state=error with backoff", async () => {
    const { fetch } = makeStubFetch([new Response("upstream timeout", { status: 503 })]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      backoffSequenceMs: [50, 100, 200],
      logger: () => undefined,
    });
    await sync.refreshNow();
    const status = sync.getStatus();
    expect(status.state).toBe("error");
    if (status.state === "error") {
      expect(status.error).toMatch(/503/);
      expect(status.nextRetryAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    await sync.stop();
  });

  it("on network failure: state=error with the exception message", async () => {
    const { fetch } = makeStubFetch([new Error("ECONNREFUSED")]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      backoffSequenceMs: [50],
      logger: () => undefined,
    });
    await sync.refreshNow();
    const status = sync.getStatus();
    expect(status.state).toBe("error");
    if (status.state === "error") {
      expect(status.error).toContain("ECONNREFUSED");
    }
    await sync.stop();
  });

  it("on body that's not JSON: state=error", async () => {
    const { fetch } = makeStubFetch([
      new Response("<html>500</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      backoffSequenceMs: [50],
      logger: () => undefined,
    });
    await sync.refreshNow();
    expect(sync.getStatus().state).toBe("error");
    await sync.stop();
  });

  it("on JSON without `config` field: state=error", async () => {
    const { fetch } = makeStubFetch([jsonResponse({ daemon: { label: "x" } })]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      backoffSequenceMs: [50],
      logger: () => undefined,
    });
    await sync.refreshNow();
    const status = sync.getStatus();
    expect(status.state).toBe("error");
    if (status.state === "error") {
      expect(status.error).toContain("config");
    }
    await sync.stop();
  });

  it("backoff escalates and caps at the final value", async () => {
    const { fetch } = makeStubFetch([
      new Response("oops", { status: 500 }),
      new Response("oops", { status: 500 }),
      new Response("oops", { status: 500 }),
      new Response("oops", { status: 500 }),
    ]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      backoffSequenceMs: [10, 20, 50],
      logger: () => undefined,
    });

    await sync.refreshNow();
    const r1 = sync.getStatus();
    await sync.refreshNow();
    const r2 = sync.getStatus();
    await sync.refreshNow();
    const r3 = sync.getStatus();
    await sync.refreshNow();
    const r4 = sync.getStatus();

    const delay = (s: typeof r1) =>
      s.state === "error" ? Date.parse(s.nextRetryAt) - Date.parse(s.lastErrorAt) : -1;

    expect(delay(r1)).toBeGreaterThanOrEqual(10);
    expect(delay(r1)).toBeLessThan(50);
    expect(delay(r2)).toBeGreaterThanOrEqual(20);
    expect(delay(r2)).toBeLessThan(100);
    expect(delay(r3)).toBeGreaterThanOrEqual(50);
    expect(delay(r4)).toBeGreaterThanOrEqual(50);
    await sync.stop();
  });

  it("after a success, the consecutive-error counter resets", async () => {
    const { fetch } = makeStubFetch([
      new Response("oops", { status: 500 }),
      jsonResponse({ config: { primary: { id: "local", config: {} }, replicators: [] } }),
      new Response("oops", { status: 500 }),
    ]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      backoffSequenceMs: [10, 999],
      logger: () => undefined,
    });

    await sync.refreshNow();
    await sync.refreshNow();
    await sync.refreshNow();
    const status = sync.getStatus();

    if (status.state === "error") {
      const delay = Date.parse(status.nextRetryAt) - Date.parse(status.lastErrorAt);
      expect(delay).toBeLessThan(500);
    } else {
      throw new Error(`expected error state, got ${status.state}`);
    }
    await sync.stop();
  });

  it("stop() is idempotent and waits for in-flight fetches", async () => {
    let resolveFetch: ((r: Response) => void) | null = null;
    const blocked = new Promise<Response>((res) => {
      resolveFetch = res;
    });
    const { fetch } = makeStubFetch([() => blocked]);

    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      logger: () => undefined,
    });
    sync.start();
    await new Promise((r) => setImmediate(r));

    // Two concurrent stop() calls — both should resolve once the in-flight
    // fetch settles. Neither should reject; they share the same `inFlight`.
    const stop1 = sync.stop();
    const stop2 = sync.stop();

    resolveFetch!(
      jsonResponse({ config: { primary: { id: "local", config: {} }, replicators: [] } }),
    );

    await Promise.all([stop1, stop2]);
    expect(sync.getStatus().state).not.toBe("error");
  });

  it("start() returns immediately and does not block on fetch", async () => {
    let resolved = false;
    const blocked = new Promise<Response>((res) => {
      setTimeout(() => {
        resolved = true;
        res(jsonResponse({ config: { primary: { id: "local", config: {} }, replicators: [] } }));
      }, 50);
    });
    const { fetch } = makeStubFetch([() => blocked]);

    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      logger: () => undefined,
    });

    const before = Date.now();
    sync.start();
    const elapsedMs = Date.now() - before;
    expect(elapsedMs).toBeLessThan(20);
    expect(resolved).toBe(false);

    await new Promise((r) => setTimeout(r, 100));
    await sync.stop();
  });
});
