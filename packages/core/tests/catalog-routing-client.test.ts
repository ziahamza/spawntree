import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoutingCatalogClient, createRoutingCatalogProxy, schema } from "../src/db/index.ts";

/**
 * Cover the routing catalog client's three guarantees:
 *
 *   1. With the primary probe true, queries hit `primary.url`.
 *   2. With the primary probe false, queries hit `fallback.url`.
 *   3. The probe result is cached for `probeTtlMs`; concurrent queries
 *      that arrive while a probe is inflight share the result.
 *
 * The probe is injected (not real `fetch`) so tests are deterministic.
 * Each query records which endpoint received it, which is enough to
 * verify routing without round-tripping a real Drizzle instance.
 */

interface RecordedCall {
  endpoint: "primary" | "fallback";
  body: { sql: string; params: Array<unknown>; method: string };
}

function makeFetchStub(): { fetch: typeof fetch; calls: Array<RecordedCall> } {
  const calls: Array<RecordedCall> = [];
  const stub: typeof fetch = async (input, init) => {
    const url = String(input);
    const endpoint = url.includes(":2222") ? "primary" : "fallback";
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ endpoint, body });
    return new Response(JSON.stringify({ rows: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: stub, calls };
}

describe("createRoutingCatalogClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("routes to primary when the probe resolves true", async () => {
    const { fetch: stubFetch, calls } = makeFetchStub();
    const db = createRoutingCatalogClient({
      primary: { url: "http://127.0.0.1:2222", fetch: stubFetch },
      fallback: { url: "http://host.example", fetch: stubFetch },
      probe: async () => true,
    });
    await db.select().from(schema.repos);
    expect(calls.map((c) => c.endpoint)).toEqual(["primary"]);
  });

  it("routes to fallback when the probe resolves false", async () => {
    const { fetch: stubFetch, calls } = makeFetchStub();
    const db = createRoutingCatalogClient({
      primary: { url: "http://127.0.0.1:2222", fetch: stubFetch },
      fallback: { url: "http://host.example", fetch: stubFetch },
      probe: async () => false,
    });
    await db.select().from(schema.repos);
    expect(calls.map((c) => c.endpoint)).toEqual(["fallback"]);
  });

  it("calls onRouteChange exactly once per route flip", async () => {
    const { fetch: stubFetch } = makeFetchStub();
    let probeResult = true;
    const flips: Array<"primary" | "fallback"> = [];
    const db = createRoutingCatalogClient({
      primary: { url: "http://127.0.0.1:2222", fetch: stubFetch },
      fallback: { url: "http://host.example", fetch: stubFetch },
      probeTtlMs: 1, // make every query re-probe
      probe: async () => probeResult,
      onRouteChange: (active) => flips.push(active),
    });

    await db.select().from(schema.repos);
    vi.advanceTimersByTime(10);
    probeResult = false;
    await db.select().from(schema.repos);
    vi.advanceTimersByTime(10);
    probeResult = false; // still false, no flip
    await db.select().from(schema.repos);
    vi.advanceTimersByTime(10);
    probeResult = true;
    await db.select().from(schema.repos);

    expect(flips).toEqual(["primary", "fallback", "primary"]);
  });

  it("caches the probe result within probeTtlMs", async () => {
    const { fetch: stubFetch } = makeFetchStub();
    const probe = vi.fn(async () => true);
    const db = createRoutingCatalogClient({
      primary: { url: "http://127.0.0.1:2222", fetch: stubFetch },
      fallback: { url: "http://host.example", fetch: stubFetch },
      probeTtlMs: 30_000,
      probe,
    });

    await db.select().from(schema.repos);
    await db.select().from(schema.repos);
    await db.select().from(schema.repos);

    // One probe was enough — three queries reused the cached result.
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("re-probes after probeTtlMs elapses", async () => {
    const { fetch: stubFetch } = makeFetchStub();
    const probe = vi.fn(async () => true);
    const db = createRoutingCatalogClient({
      primary: { url: "http://127.0.0.1:2222", fetch: stubFetch },
      fallback: { url: "http://host.example", fetch: stubFetch },
      probeTtlMs: 1_000,
      probe,
    });

    await db.select().from(schema.repos);
    expect(probe).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_001);
    await db.select().from(schema.repos);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent probes (no thundering herd)", async () => {
    // Real timers — fake timers can interfere with the microtask
    // scheduling Drizzle's proxy relies on.
    vi.useRealTimers();
    const { fetch: stubFetch } = makeFetchStub();
    const probe = vi.fn(async () => {
      // Small delay so concurrent callers all enter `decide()` while
      // the probe is still inflight.
      await new Promise((r) => setTimeout(r, 10));
      return true;
    });
    const db = createRoutingCatalogClient({
      primary: { url: "http://127.0.0.1:2222", fetch: stubFetch },
      fallback: { url: "http://host.example", fetch: stubFetch },
      probe,
    });

    // Drizzle queries are thenables — they only execute when awaited.
    // Wrapping each in an async IIFE kicks them off concurrently so all
    // five hit the routing proxy while the first probe is still inflight.
    const promises = [
      (async () => db.select().from(schema.repos))(),
      (async () => db.select().from(schema.repos))(),
      (async () => db.select().from(schema.repos))(),
      (async () => db.select().from(schema.repos))(),
      (async () => db.select().from(schema.repos))(),
    ];
    await Promise.all(promises);

    // One probe, five queries. The inflight promise was reused.
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("createRoutingCatalogProxy exposes the raw proxy callback", async () => {
    const { fetch: stubFetch, calls } = makeFetchStub();
    const proxy = createRoutingCatalogProxy({
      primary: { url: "http://127.0.0.1:2222", fetch: stubFetch },
      fallback: { url: "http://host.example", fetch: stubFetch },
      probe: async () => true,
    });
    await proxy("SELECT 1", [], "all");
    expect(calls.length).toBe(1);
    expect(calls[0]!.endpoint).toBe("primary");
    expect(calls[0]!.body.sql).toBe("SELECT 1");
  });
});
