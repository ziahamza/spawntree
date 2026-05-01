import { describe, expect, it } from "vitest";
import { probeDaemonReachable } from "../src/db/probe.ts";

/**
 * `probeDaemonReachable` is the seam the routing-client uses to decide
 * primary vs fallback. The contract: never reject, return a boolean,
 * respect the timeout. These tests pin all three.
 */
describe("probeDaemonReachable", () => {
  it("returns true on a 2xx /health response", async () => {
    const stub: typeof fetch = async (input) => {
      expect(String(input)).toBe("http://localhost:9999/health");
      return new Response("ok", { status: 200 });
    };
    const ok = await probeDaemonReachable({
      url: "http://localhost:9999",
      fetch: stub,
    });
    expect(ok).toBe(true);
  });

  it("returns false on non-2xx", async () => {
    const stub: typeof fetch = async () => new Response("nope", { status: 503 });
    const ok = await probeDaemonReachable({
      url: "http://localhost:9999",
      fetch: stub,
    });
    expect(ok).toBe(false);
  });

  it("returns false on network errors (never throws)", async () => {
    const stub: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const ok = await probeDaemonReachable({
      url: "http://localhost:9999",
      fetch: stub,
    });
    expect(ok).toBe(false);
  });

  it("returns false when the request takes longer than timeoutMs", async () => {
    // Stub fetch that never resolves until aborted.
    const stub: typeof fetch = (_input, init) =>
      new Promise<Response>((_, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const start = Date.now();
    const ok = await probeDaemonReachable({
      url: "http://localhost:9999",
      timeoutMs: 50,
      fetch: stub,
    });
    const elapsed = Date.now() - start;
    expect(ok).toBe(false);
    // Loose bound: timeout fired within ~5x the budget. Tightening this
    // beyond 250ms makes the test flaky on loaded CI runners.
    expect(elapsed).toBeLessThan(500);
  });

  it("strips trailing slash from the base URL and joins /health correctly", async () => {
    const calls: Array<string> = [];
    const stub: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response("ok", { status: 200 });
    };
    await probeDaemonReachable({
      url: "http://localhost:9999/",
      fetch: stub,
    });
    expect(calls).toEqual(["http://localhost:9999/health"]);
  });

  it("respects a custom probe path", async () => {
    const calls: Array<string> = [];
    const stub: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response("", { status: 200 });
    };
    await probeDaemonReachable({
      url: "http://localhost:9999",
      path: "/api/v1/daemon",
      fetch: stub,
    });
    expect(calls).toEqual(["http://localhost:9999/api/v1/daemon"]);
  });
});
