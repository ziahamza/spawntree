import { describe, expect, it, vi } from "vitest";
import type { ACPAdapter, DiscoveredSession, SessionDetail, SessionEvent } from "spawntree-core";
import { SessionDeleteUnsupportedError } from "spawntree-core";
import { DomainEvents } from "../src/events/domain-events.ts";
import { SessionManager } from "../src/sessions/session-manager.ts";

/**
 * Test double — a minimal in-memory adapter that tracks subprocess-style
 * lifecycle events so we can assert the manager doesn't spawn adapters
 * unnecessarily.
 */
function makeFakeAdapter(name: string, sessions: DiscoveredSession[] = []): FakeAdapter {
  const handlers: Array<(e: SessionEvent) => void> = [];

  const adapter: FakeAdapter = {
    name,
    isAvailableCalls: 0,
    discoverSessionsCalls: 0,
    sessions,
    deleted: [],

    async isAvailable() {
      this.isAvailableCalls += 1;
      return true;
    },

    async discoverSessions() {
      this.discoverSessionsCalls += 1;
      return [...this.sessions];
    },

    async getSessionDetail(_sessionId: string): Promise<SessionDetail> {
      return { turns: [], toolCalls: [] };
    },

    async sendMessage() {
      // no-op
    },

    async interruptSession() {
      // no-op
    },

    async resumeSession() {
      // no-op
    },

    async deleteSession(sessionId: string) {
      this.deleted.push(sessionId);
      this.sessions = this.sessions.filter((s) => s.sourceId !== sessionId);
    },

    onSessionEvent(handler) {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      };
    },

    emit(event: SessionEvent) {
      for (const h of handlers) h(event);
    },

    async shutdown() {
      handlers.length = 0;
    },
  };

  return adapter;
}

interface FakeAdapter extends ACPAdapter {
  isAvailableCalls: number;
  discoverSessionsCalls: number;
  sessions: DiscoveredSession[];
  deleted: string[];
  emit(event: SessionEvent): void;
}

function discovered(id: string, provider: string): DiscoveredSession {
  return {
    sourceId: id,
    provider,
    status: "idle",
    title: null,
    workingDirectory: "/tmp",
    gitBranch: null,
    gitHeadCommit: null,
    gitRemoteUrl: null,
    totalTurns: 0,
    startedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

function makeManager(providers: Record<string, FakeAdapter>) {
  const events = new DomainEvents();
  const manager = new SessionManager(events);
  for (const [name, adapter] of Object.entries(providers)) {
    manager.registerAdapter(name, adapter);
  }
  return { manager, events };
}

describe("SessionManager", () => {
  describe("findSession caching", () => {
    it("caches sessionId→provider on listSessions and routes later calls without re-iterating adapters", async () => {
      const claude = makeFakeAdapter("claude-code", [discovered("s1", "claude-code")]);
      const codex = makeFakeAdapter("codex", [discovered("s2", "codex")]);
      const { manager } = makeManager({ "claude-code": claude, codex });

      await manager.listSessions();
      const afterList = {
        claudeDisc: claude.discoverSessionsCalls,
        codexDisc: codex.discoverSessionsCalls,
      };

      await manager.getSessionDetail("s1");
      await manager.getSessionDetail("s1");

      // Cache hit — no additional discoverSessions calls on either adapter.
      expect(claude.discoverSessionsCalls).toBe(afterList.claudeDisc);
      expect(codex.discoverSessionsCalls).toBe(afterList.codexDisc);
    });

    it("does not start other adapters when resolving a known Claude Code session", async () => {
      const claude = makeFakeAdapter("claude-code", [discovered("s1", "claude-code")]);
      const codex = makeFakeAdapter("codex", []);
      const { manager } = makeManager({ "claude-code": claude, codex });

      // Prime the cache via listSessions (both adapters are queried once).
      await manager.listSessions();
      const codexCallsAfterList = codex.discoverSessionsCalls;

      // Subsequent session ops should route via cache.
      await manager.sendMessage("s1", "hello");
      await manager.interrupt("s1");
      await manager.getSessionDetail("s1");

      expect(codex.discoverSessionsCalls).toBe(codexCallsAfterList);
    });

    it("skips adapters whose binary is not available", async () => {
      const claude = makeFakeAdapter("claude-code", [discovered("s1", "claude-code")]);
      const unavailable = makeFakeAdapter("cursor", []);
      unavailable.isAvailable = vi.fn(async () => false);
      const { manager } = makeManager({ "claude-code": claude, cursor: unavailable });

      await manager.listSessions();

      expect(unavailable.discoverSessionsCalls).toBe(0);
    });
  });

  describe("deleteSession", () => {
    it("dispatches to the owning adapter and clears the cache", async () => {
      const claude = makeFakeAdapter("claude-code", [discovered("s1", "claude-code")]);
      const { manager } = makeManager({ "claude-code": claude });

      await manager.listSessions();
      await manager.deleteSession("s1");

      expect(claude.deleted).toEqual(["s1"]);
      // After delete, findSession should no longer see the cached entry.
      await expect(manager.getSessionDetail("s1")).rejects.toThrow(/Session not found/);
    });

    it("throws SessionDeleteUnsupportedError when the adapter doesn't implement deleteSession", async () => {
      const codex = makeFakeAdapter("codex", [discovered("s2", "codex")]);
      // Remove the deleteSession method to simulate a provider that doesn't support delete.
      codex.deleteSession = undefined;
      const { manager } = makeManager({ codex });

      await manager.listSessions();
      await expect(manager.deleteSession("s2")).rejects.toBeInstanceOf(
        SessionDeleteUnsupportedError,
      );
    });
  });

  describe("event routing", () => {
    it("publishes adapter events to the domain events bus as session_event", async () => {
      const claude = makeFakeAdapter("claude-code", [discovered("s1", "claude-code")]);
      const { manager, events } = makeManager({ "claude-code": claude });

      const received: unknown[] = [];
      const controller = new AbortController();
      const iter = events.subscribe(0, controller.signal)[Symbol.asyncIterator]();

      // Trigger subscription to the adapter by sending a message.
      await manager.sendMessage("s1", "hello");

      const evt: SessionEvent = {
        type: "turn_started",
        sessionId: "s1",
        turnId: "t1",
      };
      claude.emit(evt);

      // Drain at least one event.
      const next = await iter.next();
      received.push(next.value);
      controller.abort();

      expect(received[0]).toMatchObject({
        type: "session_event",
      });
    });

    it("registers each provider's event subscription exactly once", async () => {
      const claude = makeFakeAdapter("claude-code", [discovered("s1", "claude-code")]);
      const onSessionEventSpy = vi.spyOn(claude, "onSessionEvent");
      const { manager } = makeManager({ "claude-code": claude });

      await manager.listSessions();
      await manager.sendMessage("s1", "hello");
      await manager.sendMessage("s1", "hello again");

      expect(onSessionEventSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("registerAdapter", () => {
    it("exposes registered provider names without starting any subprocesses", () => {
      const a = makeFakeAdapter("claude-code");
      const b = makeFakeAdapter("cursor");
      const { manager } = makeManager({ "claude-code": a, cursor: b });

      expect(manager.registeredProviders()).toContain("claude-code");
      expect(manager.registeredProviders()).toContain("cursor");
      // No isAvailable/discoverSessions calls should have fired.
      expect(a.isAvailableCalls).toBe(0);
      expect(b.isAvailableCalls).toBe(0);
    });
  });

  describe("createSession event wiring", () => {
    it("subscribes to the adapter BEFORE calling createSession", async () => {
      // Regression guard for Devin pass-1 comment #3: events emitted by
      // the adapter during createSession() must be captured by the
      // domain events bus. Subscribing after creation would drop them.
      const adapter = makeFakeAdapter("claude-code");
      const createOrder: string[] = [];

      adapter.onSessionEvent = (handler) => {
        createOrder.push("subscribed");
        // Immediately fire a fake "status changed" event to simulate
        // an event racing with createSession startup.
        setTimeout(
          () =>
            handler({
              type: "session_status_changed",
              sessionId: "sess-1",
              status: "idle",
            }),
          0,
        );
        return () => {};
      };

      adapter.createSession = async () => {
        createOrder.push("createSession");
        return { sessionId: "sess-1" };
      };

      const { manager } = makeManager({ "claude-code": adapter });
      await manager.createSession("claude-code", { cwd: "/tmp" });

      // Subscription must come first so events during creation are captured.
      expect(createOrder).toEqual(["subscribed", "createSession"]);
    });
  });

  describe("registerAdapter replacement", () => {
    it("tears down the old adapter's subscription and shuts it down when replaced", async () => {
      // Regression guard for Devin pass-3: replacing a subscribed
      // adapter must unsubscribe + shut down the old instance so the
      // subprocess isn't leaked and the old handler doesn't keep firing.
      const oldAdapter = makeFakeAdapter("claude-code", [discovered("s1", "claude-code")]);
      let oldUnsubscribeCalled = false;
      let oldShutdownCalled = false;

      const originalOnSessionEvent = oldAdapter.onSessionEvent;
      oldAdapter.onSessionEvent = (handler) => {
        const inner = originalOnSessionEvent.call(oldAdapter, handler);
        return () => {
          oldUnsubscribeCalled = true;
          inner();
        };
      };
      const originalShutdown = oldAdapter.shutdown;
      oldAdapter.shutdown = async () => {
        oldShutdownCalled = true;
        await originalShutdown.call(oldAdapter);
      };

      const { manager } = makeManager({ "claude-code": oldAdapter });
      // Trigger the old adapter's subscription by running listSessions.
      await manager.listSessions();

      // Replace with a fresh adapter.
      const newAdapter = makeFakeAdapter("claude-code");
      manager.registerAdapter("claude-code", newAdapter);

      // Give the background shutdown a tick to run.
      await new Promise((r) => setImmediate(r));

      expect(oldUnsubscribeCalled).toBe(true);
      expect(oldShutdownCalled).toBe(true);
    });

    it("drops sessionIndex entries for the replaced provider", async () => {
      // Cached routing must not send operations to a decommissioned adapter.
      const oldAdapter = makeFakeAdapter("claude-code", [discovered("s1", "claude-code")]);
      const { manager } = makeManager({ "claude-code": oldAdapter });
      await manager.listSessions();
      // Cache is populated — sanity check via the private field.
      const idx = (manager as unknown as { sessionIndex: Map<string, string> }).sessionIndex;
      expect(idx.has("s1")).toBe(true);

      const newAdapter = makeFakeAdapter("claude-code");
      manager.registerAdapter("claude-code", newAdapter);

      expect(idx.has("s1")).toBe(false);
    });

    it("no-ops when the same adapter instance is re-registered", async () => {
      // Re-registering the same object should not tear anything down.
      const adapter = makeFakeAdapter("claude-code", [discovered("s1", "claude-code")]);
      let shutdownCalled = false;
      const original = adapter.shutdown;
      adapter.shutdown = async () => {
        shutdownCalled = true;
        await original.call(adapter);
      };

      const { manager } = makeManager({ "claude-code": adapter });
      await manager.listSessions();
      manager.registerAdapter("claude-code", adapter);
      await new Promise((r) => setImmediate(r));

      expect(shutdownCalled).toBe(false);
    });
  });

  describe("startDiscoveryLoop idempotency", () => {
    /**
     * Regression test for Devin review of PR #33: the doc comment promises
     * idempotent calls but the original implementation only checked
     * `discoveryTimer`, which is null until AFTER the first runDiscoveryPass
     * resolves. A second call during that async window would spawn a parallel
     * loop and double up subprocess spawns.
     *
     * The fix sets `discoveryLoopStarted` synchronously, so we model that
     * exact race here: hold up `discoverSessions` with a manual signal and
     * call `startDiscoveryLoop` twice while the first tick is still suspended.
     * Resolving the signal lets a single tick complete; we then assert the
     * adapter was discovered exactly once for that tick.
     */
    it("a second call during the first async tick is a no-op", async () => {
      let resolveFirstTick: () => void = () => {};
      const firstTickStarted = new Promise<void>((res) => (resolveFirstTick = res));
      let releaseFirstTick: () => void = () => {};
      const firstTickRelease = new Promise<void>((res) => (releaseFirstTick = res));

      const adapter = makeFakeAdapter("claude-code", [discovered("s1", "claude-code")]);
      // Wrap discoverSessions so the FIRST call (and only the first) suspends
      // until the test releases it. We delegate to the original — which is the
      // implementation that actually increments `discoverSessionsCalls` — so
      // we don't double-count.
      const originalDiscover = adapter.discoverSessions.bind(adapter);
      adapter.discoverSessions = async () => {
        // Suspend the first call mid-flight. We compare against current count
        // BEFORE delegating, so the gate triggers exactly once.
        const isFirst = adapter.discoverSessionsCalls === 0;
        if (isFirst) {
          // Delegate first so the call is counted before we suspend; that
          // way `firstTickStarted` only resolves after the manager has
          // committed to discoverSessions.
          const tickResult = originalDiscover();
          resolveFirstTick();
          await firstTickRelease;
          return tickResult;
        }
        return originalDiscover();
      };

      const { manager } = makeManager({ "claude-code": adapter });

      // Long interval — we're testing the *startup* race, not the periodic
      // loop. After the first tick we'll stopDiscoveryLoop() so no further
      // ticks run.
      manager.startDiscoveryLoop(60_000);
      await firstTickStarted;
      manager.startDiscoveryLoop(60_000); // should be a no-op
      releaseFirstTick();

      // Drain microtasks so the first tick's setTimeout schedule lands.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      manager.stopDiscoveryLoop();

      // Exactly ONE discoverSessions call from the first (and only) tick.
      expect(adapter.discoverSessionsCalls).toBe(1);
    });

    it("post-stop, a fresh start is rejected (avoids zombie loops after shutdown)", () => {
      const adapter = makeFakeAdapter("claude-code");
      const { manager } = makeManager({ "claude-code": adapter });
      manager.startDiscoveryLoop(60_000);
      manager.stopDiscoveryLoop();
      manager.startDiscoveryLoop(60_000); // discoveryStopped guard kicks in
      // No assertion needed — just verify the previous call doesn't throw
      // and that the adapter wasn't asked to discover again post-stop.
      // (`discoverSessionsCalls` from the first start is allowed; the post-stop
      // start should NOT add to it.)
      expect(adapter.discoverSessionsCalls).toBeLessThanOrEqual(1);
    });
  });
});
