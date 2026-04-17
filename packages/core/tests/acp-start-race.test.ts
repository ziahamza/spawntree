import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { JsonRpcTransport } from "../src/acp/json-rpc.ts";
import { CodexACPAdapter } from "../src/acp/adapters/codex.ts";

/**
 * Regression guard for Devin pass-3 finding #1: concurrent
 * `ensureStarted()` must not allow a caller to send RPC against an
 * un-initialized transport.
 *
 * Before the fix: `start()` assigned `this.transport = transport`
 * BEFORE `await transport.initialize(...)`. A second concurrent
 * `ensureStarted()` would see `transport.isAlive` === true and return
 * early, even though the handshake was still running.
 *
 * The fix: `start()` stores an in-flight `startPromise` that concurrent
 * callers await, and only publishes `this.transport` + `this.initialized`
 * AFTER the handshake completes.
 */

describe("adapter start race", () => {
  it("concurrent start() calls await the same promise", async () => {
    // We don't want to actually spawn the Codex binary — that would be
    // flaky and slow. Instead, patch the adapter's doStart so it takes
    // a measurable time and tracks how many distinct runs occur.
    let startInvocations = 0;
    const adapter = new CodexACPAdapter({ clientName: "test" });

    // Replace the internal start with one that completes after a tick.
    // This is a structural test — it asserts the mutex routes concurrent
    // callers into a single shared promise.
    (adapter as unknown as { doStart: () => Promise<void> }).doStart = async () => {
      startInvocations += 1;
      await new Promise((r) => setTimeout(r, 10));
      // Simulate successful handshake — set the private fields the way
      // the real doStart would.
      (adapter as unknown as { initialized: boolean }).initialized = true;
      (adapter as unknown as { transport: { isAlive: boolean } }).transport = {
        isAlive: true,
      } as never;
    };

    // Fire three concurrent starts. Before the fix, each would call
    // doStart independently and spawn three transports.
    await Promise.all([adapter.start(), adapter.start(), adapter.start()]);

    expect(startInvocations).toBe(1);
  });

  it("after start completes, subsequent calls skip (fast path)", async () => {
    const adapter = new CodexACPAdapter({ clientName: "test" });
    let startInvocations = 0;
    (adapter as unknown as { doStart: () => Promise<void> }).doStart = async () => {
      startInvocations += 1;
      (adapter as unknown as { initialized: boolean }).initialized = true;
      (adapter as unknown as { transport: { isAlive: boolean } }).transport = {
        isAlive: true,
      } as never;
    };

    await adapter.start();
    await adapter.start();
    await adapter.start();
    expect(startInvocations).toBe(1);
  });

  it("a failed start clears the mutex so the next call retries", async () => {
    const adapter = new CodexACPAdapter({ clientName: "test" });
    let attempts = 0;
    (adapter as unknown as { doStart: () => Promise<void> }).doStart = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("synthetic handshake failure");
      (adapter as unknown as { initialized: boolean }).initialized = true;
      (adapter as unknown as { transport: { isAlive: boolean } }).transport = {
        isAlive: true,
      } as never;
    };

    await expect(adapter.start()).rejects.toThrow(/synthetic/);
    // Second call should NOT piggyback on the failed promise; it must
    // re-run doStart.
    await adapter.start();
    expect(attempts).toBe(2);
  });
});

// Sanity: make sure JsonRpcTransport import + spawn import path stays
// live (prevents tree-shaking / unused-import warnings from masking the
// real test signal).
void spawn;
void JsonRpcTransport;
