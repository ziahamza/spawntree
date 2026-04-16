import { describe, expect, it, vi } from "vitest";
import type {
  ACPAdapter,
  DiscoveredSession,
  SessionDetail,
  SessionEvent,
} from "spawntree-core";
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
      await expect(manager.deleteSession("s2")).rejects.toBeInstanceOf(SessionDeleteUnsupportedError);
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
      // Regression guard for Devin comment #3: events emitted by the
      // adapter during createSession() must be captured by the domain
      // events bus. Subscribing after creation would drop them.
      const adapter = makeFakeAdapter("claude-code");
      const createOrder: string[] = [];

      adapter.onSessionEvent = (handler) => {
        createOrder.push("subscribed");
        // Immediately fire a fake "status changed" event to simulate
        // an event racing with createSession startup.
        setTimeout(() =>
          handler({
            type: "session_status_changed",
            sessionId: "sess-1",
            status: "idle",
          }), 0);
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
});
