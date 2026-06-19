import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema } from "spawntree-core";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { StorageManager } from "../src/storage/manager.ts";
import {
  HostConfigSync,
  DAEMON_CONFIG_CONTRACT_VERSION,
  CONFIG_VERSION_HEADER,
} from "../src/storage/host-sync.ts";
import { applyCatalogSchema } from "../src/catalog/queries.ts";

/**
 * Cover the daemon-side host-config-sync loop with a stubbed `fetch`:
 *   - Authorization header: bearer host-key, never the URL.
 *   - URL: <binding.url>/api/daemons/me/config.
 *   - X-Spawntree-Fingerprint: 32-hex-char hash of the machine id, sent
 *     on every request (fingerprintOverride is the test seam).
 *   - Success: payload's StorageConfig is applied via manager.applyConfig.
 *   - 404: status becomes `awaiting_config`, no config write.
 *   - 409 FINGERPRINT_MISMATCH: status becomes a TERMINAL error and the
 *     loop refuses to retry. Daemon must be restarted.
 *   - 5xx / network error: status becomes `error` with backoff scheduled.
 *   - Bad JSON / missing `config`: error path.
 *   - stop(): cancels next scheduled fetch and waits for in-flight.
 *
 * Tests pass `fingerprintOverride` so they don't depend on the
 * `node-machine-id` package being installed in CI before the vendor
 * postinstall runs.
 */

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  method: string;
}

function makeStubFetch(responses: Array<Response | (() => Promise<Response> | Response) | Error>): {
  fetch: typeof fetch;
  calls: Array<FetchCall>;
} {
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
const TEST_FINGERPRINT = "0123456789abcdef0123456789abcdef";
const LOCAL_SYNC_CONFIG = { config: { syncMethod: "none" } };

describe("HostConfigSync", () => {
  let tmp: string;
  let manager: StorageManager;

  beforeEach(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-host-sync-"));
    manager = new StorageManager({
      dataDir: tmp,
      logger: () => undefined,
    });
    await manager.start();
  });

  afterEach(async () => {
    await manager.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("hits <host>/api/daemons/me/config with the bearer key + fingerprint header", async () => {
    const { fetch, calls } = makeStubFetch([
      jsonResponse({
        config: { syncMethod: "none" },
        daemon: { label: "laptop" },
      }),
    ]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      logger: () => undefined,
      fingerprintOverride: TEST_FINGERPRINT,
    });
    await sync.refreshNow();
    await sync.stop();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://controller:7777/api/daemons/me/config");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers["Authorization"] || calls[0]!.headers["authorization"]).toBe(
      `Bearer ${TEST_KEY}`,
    );
    // Fingerprint must be sent on every host poll. The header name is the
    // same casing the host expects (X-Spawntree-Fingerprint) — it's
    // case-insensitive on the wire but we pin the canonical form here so
    // accidental renames break this test.
    const fp =
      calls[0]!.headers["X-Spawntree-Fingerprint"] || calls[0]!.headers["x-spawntree-fingerprint"];
    expect(fp).toBe(TEST_FINGERPRINT);
  });

  it("strips trailing slash from the binding URL", async () => {
    const { fetch, calls } = makeStubFetch([jsonResponse(LOCAL_SYNC_CONFIG)]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777/", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      logger: () => undefined,
      fingerprintOverride: TEST_FINGERPRINT,
    });
    await sync.refreshNow();
    await sync.stop();
    expect(calls[0]!.url).toBe("http://controller:7777/api/daemons/me/config");
  });

  it("on success: applies the config and reports state=synced", async () => {
    const { fetch } = makeStubFetch([
      jsonResponse({
        config: { syncMethod: "none" },
        daemon: { label: "ci-runner" },
      }),
    ]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      logger: () => undefined,
      fingerprintOverride: TEST_FINGERPRINT,
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
    const { fetch } = makeStubFetch([jsonResponse({ daemon: { label: "fresh" } }, 404)]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      logger: () => undefined,
      fingerprintOverride: TEST_FINGERPRINT,
    });
    await sync.refreshNow();
    await sync.stop();

    const status = sync.getStatus();
    expect(status.state).toBe("awaiting_config");
    if (status.state === "awaiting_config") {
      expect(status.daemonLabel).toBe("fresh");
    }

    const managerStatus = await manager.status();
    expect(managerStatus.storage.id).toBe("sqlite");
    expect(managerStatus.sync.method).toBe("none");
  });

  it("on 409 FINGERPRINT_MISMATCH: terminal error state; loop will not retry", async () => {
    // 409 should be HARD-FAIL: the host has positively rejected this
    // fingerprint as belonging to a different machine. We must not silently
    // keep polling — that would let an attacker brute-force a stolen
    // dh_ key by spinning up a new daemon on another box.
    const responses = [
      new Response(
        JSON.stringify({
          code: "FINGERPRINT_MISMATCH",
          error: "Daemon key already bound to a different machine",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
      // Second response would be served if the loop kept going. The test
      // asserts the daemon ignores it (no consecutive call after a 409).
      jsonResponse(LOCAL_SYNC_CONFIG),
    ];
    const { fetch, calls } = makeStubFetch(responses);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      backoffSequenceMs: [10],
      logger: () => undefined,
      fingerprintOverride: TEST_FINGERPRINT,
    });

    await sync.refreshNow();
    const first = sync.getStatus();
    expect(first.state).toBe("error");
    if (first.state === "error") {
      expect(first.error).toMatch(/different machine/i);
      expect(first.terminal).toBe(true);
    }

    // Even an explicit refresh after a 409 is a no-op — terminal means
    // terminal until the daemon process restarts.
    await sync.refreshNow();
    await sync.stop();
    expect(calls).toHaveLength(1);

    // The persisted config should NOT have been touched by a 409.
    const managerStatus = await manager.status();
    expect(managerStatus.storage.id).toBe("sqlite");
    expect(managerStatus.sync.method).toBe("none");
  });

  it("on 410 GONE (key revoked): terminal error state; loop stops; onGone is called once", async () => {
    // 410 means the dh_ key was revoked on the host (machine soft-deleted).
    // The daemon must: (a) go terminal so it stops polling, (b) call
    // onGone() exactly once to clear the persisted binding.
    const responses = [
      new Response(
        JSON.stringify({
          code: "KEY_REVOKED",
          error:
            "This daemon key has been revoked. The machine was removed; re-register to continue.",
        }),
        { status: 410, headers: { "content-type": "application/json" } },
      ),
      // Second response would be served if the loop kept going. The test
      // asserts the daemon ignores it (no consecutive call after a 410).
      jsonResponse(LOCAL_SYNC_CONFIG),
    ];
    const { fetch, calls } = makeStubFetch(responses);
    let goneCallCount = 0;
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      backoffSequenceMs: [10],
      logger: () => undefined,
      fingerprintOverride: TEST_FINGERPRINT,
      onGone: () => {
        goneCallCount++;
      },
    });

    await sync.refreshNow();
    const first = sync.getStatus();
    expect(first.state).toBe("error");
    if (first.state === "error") {
      expect(first.error).toMatch(/revoked/i);
      expect(first.terminal).toBe(true);
    }

    // onGone must be called exactly once.
    expect(goneCallCount).toBe(1);

    // Even an explicit refresh after a 410 is a no-op — terminal.
    await sync.refreshNow();
    await sync.stop();
    expect(calls).toHaveLength(1);

    // onGone must not have been called again.
    expect(goneCallCount).toBe(1);

    // The persisted config should NOT have been touched by a 410.
    const managerStatus = await manager.status();
    expect(managerStatus.storage.id).toBe("sqlite");
    expect(managerStatus.sync.method).toBe("none");
  });

  it("on 410 GONE: onGone is not called when option is absent (no crash)", async () => {
    // Regression guard: if the caller doesn't pass onGone, the daemon still
    // goes terminal but does NOT throw a TypeError on `undefined?.()`.
    const { fetch } = makeStubFetch([
      new Response(JSON.stringify({ code: "KEY_REVOKED" }), {
        status: 410,
        headers: { "content-type": "application/json" },
      }),
    ]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      backoffSequenceMs: [10],
      logger: () => undefined,
      fingerprintOverride: TEST_FINGERPRINT,
      // intentionally no onGone
    });

    // Should not throw.
    await expect(sync.refreshNow()).resolves.toBeUndefined();
    expect(sync.getStatus().state).toBe("error");
    await sync.stop();
  });

  // ── Config-contract version negotiation ────────────────────────────────
  // The daemon advertises the config SHAPE it speaks and refuses to apply a
  // shape it doesn't understand — turning the pre-v2 "applyConfig failed:
  // reading 'id'" crash into a clear, actionable "update required".

  it("sends X-Spawntree-Config-Version on the config poll", async () => {
    const { fetch, calls } = makeStubFetch([jsonResponse(LOCAL_SYNC_CONFIG)]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      logger: () => undefined,
      fingerprintOverride: TEST_FINGERPRINT,
    });
    await sync.refreshNow();
    await sync.stop();

    const ver =
      calls[0]!.headers[CONFIG_VERSION_HEADER] ||
      calls[0]!.headers[CONFIG_VERSION_HEADER.toLowerCase()];
    expect(ver).toBe(String(DAEMON_CONFIG_CONTRACT_VERSION));
  });

  it("on 426: state=error 'update required', non-terminal, local config untouched", async () => {
    const { fetch } = makeStubFetch([
      new Response(JSON.stringify({ code: "DAEMON_TOO_OLD", error: "daemon too old" }), {
        status: 426,
        headers: { "content-type": "application/json" },
      }),
      // A second response the loop would consume on retry — present so the
      // test can assert the retry stays scheduled (non-terminal) without
      // the stub running dry.
      jsonResponse(LOCAL_SYNC_CONFIG),
    ]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      // Long backoff so the scheduled retry can't fire mid-test.
      backoffSequenceMs: [10_000],
      logger: () => undefined,
      fingerprintOverride: TEST_FINGERPRINT,
    });

    await sync.refreshNow();
    const status = sync.getStatus();
    expect(status.state).toBe("error");
    if (status.state === "error") {
      expect(status.error).toMatch(/update required/i);
      // Non-terminal: a 426 self-resolves once the app updates (which
      // restarts the daemon), so we keep polling rather than going terminal.
      expect(status.terminal).toBeFalsy();
    }
    await sync.stop();

    // The local sqlite config must be untouched (still the default `none`).
    const managerStatus = await manager.status();
    expect(managerStatus.sync.method).toBe("none");
  });

  it("refuses a host response whose contractVersion is newer than the daemon supports", async () => {
    // Self-defense: even without a 426, a host that DECLARES a newer config
    // shape must not have that shape blindly applied. The daemon surfaces
    // "update required" and leaves its local config untouched.
    const { fetch } = makeStubFetch([
      jsonResponse({
        config: { syncMethod: "turso", turso: { url: "libsql://x.turso.io", authToken: "t" } },
        contractVersion: DAEMON_CONFIG_CONTRACT_VERSION + 1,
      }),
    ]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      backoffSequenceMs: [10_000],
      logger: () => undefined,
      fingerprintOverride: TEST_FINGERPRINT,
    });

    await sync.refreshNow();
    const status = sync.getStatus();
    expect(status.state).toBe("error");
    if (status.state === "error") {
      expect(status.error).toMatch(/update required/i);
    }
    await sync.stop();

    // Must NOT have switched to turso — the too-new config was rejected
    // before applyConfig ran.
    const managerStatus = await manager.status();
    expect(managerStatus.sync.method).toBe("none");
  });

  it("on 410 GONE from the presence pulse: error status is surfaced, not just the terminal flag", async () => {
    // The 30s heartbeat usually sees a revocation before the 5-minute config
    // poll does. Since `terminal` suppresses future config polls, the pulse
    // itself must set the error status — otherwise /api/v1/storage keeps
    // reporting the stale pre-revocation state forever. Also guards the
    // reverse race: an in-flight config fetch finishing AFTER the pulse went
    // terminal must not overwrite the error with a stale success.
    let goneCallCount = 0;
    const urlAwareFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/daemons/me/heartbeat")) {
        return new Response(JSON.stringify({ code: "KEY_REVOKED" }), {
          status: 410,
          headers: { "content-type": "application/json" },
        });
      }
      // Config poll: delay past the heartbeat so the success lands after
      // markTerminal — exercising the stale-overwrite guard in runOne.
      await new Promise((r) => setTimeout(r, 50));
      return jsonResponse(LOCAL_SYNC_CONFIG);
    };
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch: urlAwareFetch,
      pollIntervalMs: 60_000,
      presenceIntervalMs: 60_000,
      backoffSequenceMs: [10],
      logger: () => undefined,
      fingerprintOverride: TEST_FINGERPRINT,
      onGone: () => {
        goneCallCount++;
      },
    });

    sync.start();
    // Let the heartbeat 410 land and the delayed config fetch complete.
    await new Promise((r) => setTimeout(r, 150));

    const status = sync.getStatus();
    expect(status.state).toBe("error");
    if (status.state === "error") {
      expect(status.error).toMatch(/revoked/i);
      expect(status.terminal).toBe(true);
    }
    expect(goneCallCount).toBe(1);
    await sync.stop();
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
      fingerprintOverride: TEST_FINGERPRINT,
    });
    await sync.refreshNow();
    const status = sync.getStatus();
    expect(status.state).toBe("error");
    if (status.state === "error") {
      expect(status.error).toMatch(/503/);
      expect(status.nextRetryAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // Non-409 errors are NOT terminal — the loop will retry.
      expect(status.terminal).toBeUndefined();
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
      fingerprintOverride: TEST_FINGERPRINT,
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
      fingerprintOverride: TEST_FINGERPRINT,
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
      fingerprintOverride: TEST_FINGERPRINT,
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
      fingerprintOverride: TEST_FINGERPRINT,
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
      jsonResponse(LOCAL_SYNC_CONFIG),
      new Response("oops", { status: 500 }),
    ]);
    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      backoffSequenceMs: [10, 999],
      logger: () => undefined,
      fingerprintOverride: TEST_FINGERPRINT,
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
      fingerprintOverride: TEST_FINGERPRINT,
    });
    sync.start();
    await new Promise((r) => setImmediate(r));

    // Two concurrent stop() calls — both should resolve once the in-flight
    // fetch settles. Neither should reject; they share the same `inFlight`.
    const stop1 = sync.stop();
    const stop2 = sync.stop();

    resolveFetch!(jsonResponse(LOCAL_SYNC_CONFIG));

    await Promise.all([stop1, stop2]);
    expect(sync.getStatus().state).not.toBe("error");
  });

  it("start() returns immediately and does not block on fetch", async () => {
    let resolved = false;
    const blocked = new Promise<Response>((res) => {
      setTimeout(() => {
        resolved = true;
        res(jsonResponse(LOCAL_SYNC_CONFIG));
      }, 50);
    });
    const { fetch } = makeStubFetch([() => blocked]);

    const sync = new HostConfigSync({
      binding: { url: "http://controller:7777", key: TEST_KEY },
      manager,
      fetch,
      pollIntervalMs: 60_000,
      logger: () => undefined,
      fingerprintOverride: TEST_FINGERPRINT,
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

/**
 * Bounded session sync (the watermark). syncSessions must:
 *   - ALWAYS send live sessions, however old their updatedAt is — the host
 *     reconcile terminates any live ai_sessions row absent from a snapshot,
 *     so omitting one would false-terminate it.
 *   - send sessions changed since the last confirmed sync, so completions and
 *     short-lived sessions still reach the org session list.
 *   - NOT resend ancient terminal sessions every 10s pulse (the bound).
 *   - advance the watermark only on a 2xx, so a failed/skipped pulse re-sends
 *     the same window rather than dropping a change.
 */
describe("HostConfigSync — bounded session sync", () => {
  let tmp: string;
  let manager: StorageManager;

  const BINDING = { url: "http://controller:7777", key: TEST_KEY };
  const SYNC_URL = "http://controller:7777/api/daemons/me/sessions/sync";
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  interface SyncedPayload {
    sessions: Array<{ sourceId: string; status: string }>;
  }

  function ok(body: unknown = { synced: 0 }): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  /** Captures the JSON body of every POST to the sessions-sync endpoint. */
  function makeSessionsSyncFetch(responses: Array<Response>): {
    fetch: typeof fetch;
    bodies: Array<SyncedPayload>;
  } {
    const bodies: Array<SyncedPayload> = [];
    let i = 0;
    const stub: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === SYNC_URL) {
        const raw = typeof init?.body === "string" ? init.body : "{}";
        bodies.push(JSON.parse(raw) as SyncedPayload);
      }
      return responses[i++] ?? responses[responses.length - 1]!;
    };
    return { fetch: stub, bodies };
  }

  async function seed(
    rows: Array<{ sessionId: string; status: string; updatedAt: string }>,
  ): Promise<void> {
    const db = drizzle(manager.client, { schema });
    await db.insert(schema.sessions).values(
      rows.map((r) => ({
        sessionId: r.sessionId,
        provider: "fake",
        status: r.status,
        workingDirectory: "/tmp/x",
        updatedAt: r.updatedAt,
      })),
    );
  }

  const sentIds = (p: SyncedPayload | undefined): Array<string> =>
    (p?.sessions ?? []).map((s) => s.sourceId).sort();

  function newSync(fetch: typeof fetch): HostConfigSync {
    return new HostConfigSync({
      binding: BINDING,
      manager,
      fetch,
      sessionsSyncIntervalMs: 60_000,
      logger: () => undefined,
      fingerprintOverride: TEST_FINGERPRINT,
    });
  }

  beforeEach(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-sessions-sync-"));
    manager = new StorageManager({ dataDir: tmp, logger: () => undefined });
    await manager.start();
    // StorageManager.start() opens sqlite storage but does NOT create the
    // catalog tables — SessionManager.start() normally does that. We don't
    // use a SessionManager here, so bootstrap the schema directly.
    await applyCatalogSchema(manager.client);
  });

  afterEach(async () => {
    await manager.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("always sends live sessions of any age + recently-changed terminals, but bounds out ancient terminal ones", async () => {
    const ancient = "2020-01-01T00:00:00.000Z";
    const recent = new Date(Date.now() - 1_000).toISOString();
    await seed([
      { sessionId: "live-old", status: "active", updatedAt: ancient },
      { sessionId: "done-old", status: "completed", updatedAt: ancient },
      { sessionId: "done-recent", status: "completed", updatedAt: recent },
    ]);

    const { fetch, bodies } = makeSessionsSyncFetch([ok({ synced: 2 })]);
    const sync = newSync(fetch);
    await sync.syncSessionsNow();
    await sync.stop();

    expect(bodies).toHaveLength(1);
    // live-old: live → always sent despite a 2020 timestamp (otherwise the
    // host reconcile would false-terminate it). done-recent: terminal but
    // inside the restart backfill window. done-old: ancient terminal → bounded.
    expect(sentIds(bodies[0])).toEqual(["done-recent", "live-old"]);
  });

  it("delivers a session that completes between pulses exactly once, then stops re-sending it", async () => {
    await seed([
      { sessionId: "s1", status: "active", updatedAt: new Date(Date.now() - 1_000).toISOString() },
    ]);

    const { fetch, bodies } = makeSessionsSyncFetch([ok(), ok(), ok()]);
    const sync = newSync(fetch);

    // Pulse 1: s1 is live → sent; the watermark advances past now.
    await sync.syncSessionsNow();
    expect(sentIds(bodies[0])).toEqual(["s1"]);

    // s1 completes strictly AFTER pulse 1's committed watermark.
    await sleep(20);
    const db = drizzle(manager.client, { schema });
    await db
      .update(schema.sessions)
      .set({ status: "completed", updatedAt: new Date().toISOString() })
      .where(eq(schema.sessions.sessionId, "s1"));
    await sleep(20);

    // Pulse 2: the completion is newer than (cutoff = pulse-1 watermark) → it
    // is delivered once, now terminal.
    await sync.syncSessionsNow();
    expect(sentIds(bodies[1])).toEqual(["s1"]);
    expect(bodies[1]?.sessions[0]?.status).toBe("completed");

    // Pulse 3: s1 is terminal and older than (cutoff = pulse-2 watermark) →
    // not re-sent. Steady-state payload tracks current activity, not history.
    await sleep(20);
    await sync.syncSessionsNow();
    expect(sentIds(bodies[2])).toEqual([]);

    await sync.stop();
  });

  it("does not advance the watermark on a failed POST, so the change is re-sent next pulse", async () => {
    await seed([
      {
        sessionId: "done",
        status: "completed",
        updatedAt: new Date(Date.now() - 1_000).toISOString(),
      },
    ]);

    const { fetch, bodies } = makeSessionsSyncFetch([
      new Response("upstream", { status: 503 }),
      ok(),
    ]);
    const sync = newSync(fetch);

    // Pulse 1 (503): recently-completed `done` is in the backfill window → sent,
    // but the failure must NOT commit the watermark.
    await sync.syncSessionsNow();
    expect(sentIds(bodies[0])).toEqual(["done"]);

    // Pulse 2 (200): because the watermark never advanced, `done` is still
    // inside the window and is re-delivered rather than silently dropped.
    await sync.syncSessionsNow();
    expect(sentIds(bodies[1])).toEqual(["done"]);

    await sync.stop();
  });
});
