import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  schema,
  type ACPAdapter,
  type ContentBlock,
  type DiscoveredSession,
  type SessionEvent,
  type SessionToolCallData,
} from "spawntree-core";
import { DomainEvents } from "../src/events/domain-events.ts";
import { SessionManager } from "../src/sessions/session-manager.ts";
import { StorageManager } from "../src/storage/manager.ts";

/**
 * Prove the storage → Drizzle → ACP integration: creating a session and
 * routing an event stream through the SessionManager persists rows into
 * the catalog DB. External Drizzle clients can then read those rows
 * without re-bouncing through the adapter subprocess.
 *
 * A minimal fake adapter drives the event stream so the test doesn't
 * need Claude Code or Codex installed. Real adapters go through the
 * same `onSessionEvent` subscription.
 */

class FakeAdapter implements ACPAdapter {
  readonly provider = "fake";
  private handlers = new Set<(event: SessionEvent) => void>();
  private discovered: Array<DiscoveredSession> = [];

  async isAvailable() {
    return true;
  }
  async discoverSessions() {
    return this.discovered;
  }
  async getSessionDetail() {
    return { turns: [], toolCalls: [] };
  }
  async createSession({ cwd: _cwd }: { cwd: string }) {
    const sessionId = `fake-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.discovered.push({
      sourceId: sessionId,
      status: "idle" as const,
      title: null,
      workingDirectory: _cwd,
      gitBranch: null,
      gitHeadCommit: null,
      gitRemoteUrl: null,
      totalTurns: 0,
      startedAt: null,
      updatedAt: new Date().toISOString(),
    });
    return { sessionId };
  }
  async sendMessage() {}
  async interruptSession() {}
  async resumeSession() {}
  async deleteSession(sessionId: string) {
    this.discovered = this.discovered.filter((s) => s.sourceId !== sessionId);
  }
  onSessionEvent(handler: (event: SessionEvent) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  async shutdown() {
    this.handlers.clear();
  }

  /** Test helper to emit events into subscribed handlers. */
  emit(event: SessionEvent) {
    for (const h of this.handlers) h(event);
  }
}

describe("SessionManager persistence", () => {
  let tmp: string;
  let storage: StorageManager;
  let manager: SessionManager;
  let fake: FakeAdapter;

  beforeEach(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-sess-persist-"));
    storage = new StorageManager({ dataDir: tmp, logger: () => undefined });
    await storage.start();
    const events = new DomainEvents();
    manager = new SessionManager(events, { storage });
    await manager.start();
    fake = new FakeAdapter();
    manager.registerAdapter("fake", fake);
  });

  afterEach(async () => {
    await manager.shutdown();
    await storage.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("createSession upserts a row into sessions", async () => {
    const { sessionId } = await manager.createSession("fake", { cwd: "/tmp/x" });

    const persisted = await manager.getPersistedSession(sessionId);
    expect(persisted?.sessionId).toBe(sessionId);
    expect(persisted?.provider).toBe("fake");
    expect(persisted?.workingDirectory).toBe("/tmp/x");
    expect(persisted?.status).toBe("idle");
  });

  it("session event stream writes to session_turns + session_tool_calls", async () => {
    const { sessionId } = await manager.createSession("fake", { cwd: "/tmp/x" });

    // Session events only flow once the adapter has been subscribed to,
    // which createSession already does. Emit a turn + a tool call.
    fake.emit({ type: "turn_started", sessionId, turnId: "t1" });
    const toolCall: SessionToolCallData = {
      id: "tc1",
      turnId: "t1",
      toolName: "Write",
      toolKind: "file_edit",
      status: "completed",
      arguments: { path: "/tmp/x/a.txt" },
      result: { success: true },
      durationMs: 42,
      createdAt: new Date().toISOString(),
    };
    fake.emit({ type: "tool_call_completed", sessionId, toolCall });
    fake.emit({ type: "turn_completed", sessionId, turnId: "t1", status: "completed" });

    await manager.flushPersist();

    // Directly query the catalog via Drizzle.
    const { drizzle } = await import("drizzle-orm/libsql");
    const { eq } = await import("drizzle-orm");
    const db = drizzle(storage.client, { schema });

    const turns = await db
      .select()
      .from(schema.sessionTurns)
      .where(eq(schema.sessionTurns.sessionId, sessionId));
    expect(turns).toHaveLength(1);
    expect(turns[0]?.id).toBe("t1");
    expect(turns[0]?.status).toBe("completed");

    const toolCalls = await db
      .select()
      .from(schema.sessionToolCalls)
      .where(eq(schema.sessionToolCalls.sessionId, sessionId));
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.id).toBe("tc1");
    expect(toolCalls[0]?.toolName).toBe("Write");
    expect((toolCalls[0]?.result as { success: boolean })?.success).toBe(true);

    const [updated] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.sessionId, sessionId));
    expect(updated?.totalTurns).toBe(1);
  });

  it("session_status_changed event updates the session row", async () => {
    const { sessionId } = await manager.createSession("fake", { cwd: "/tmp/x" });

    fake.emit({ type: "session_status_changed", sessionId, status: "streaming" });
    await manager.flushPersist();

    const persisted = await manager.getPersistedSession(sessionId);
    expect(persisted?.status).toBe("streaming");
  });

  it("deleteSession cascades through FK — turns and tool calls disappear", async () => {
    const { sessionId } = await manager.createSession("fake", { cwd: "/tmp/x" });
    fake.emit({ type: "turn_started", sessionId, turnId: "t1" });
    fake.emit({
      type: "tool_call_completed",
      sessionId,
      toolCall: {
        id: "tc1",
        turnId: "t1",
        toolName: "Write",
        toolKind: "file_edit",
        status: "completed",
        arguments: {},
        result: {},
        durationMs: null,
        createdAt: new Date().toISOString(),
      } satisfies SessionToolCallData,
    });
    await manager.flushPersist();

    await manager.deleteSession(sessionId);

    const { drizzle } = await import("drizzle-orm/libsql");
    const { eq } = await import("drizzle-orm");
    const db = drizzle(storage.client, { schema });
    const turns = await db
      .select()
      .from(schema.sessionTurns)
      .where(eq(schema.sessionTurns.sessionId, sessionId));
    const tools = await db
      .select()
      .from(schema.sessionToolCalls)
      .where(eq(schema.sessionToolCalls.sessionId, sessionId));
    expect(turns).toHaveLength(0);
    expect(tools).toHaveLength(0);

    expect(await manager.getPersistedSession(sessionId)).toBeUndefined();
  });

  it("persisted sessions survive a manager + storage restart", async () => {
    const { sessionId } = await manager.createSession("fake", { cwd: "/tmp/x" });
    fake.emit({ type: "turn_started", sessionId, turnId: "t1" });
    fake.emit({ type: "turn_completed", sessionId, turnId: "t1", status: "completed" });
    await manager.flushPersist();

    // Tear down everything except the on-disk storage.
    await manager.shutdown();
    await storage.stop();

    // Boot a fresh manager against the same data dir.
    const storage2 = new StorageManager({ dataDir: tmp, logger: () => undefined });
    await storage2.start();
    const events2 = new DomainEvents();
    const manager2 = new SessionManager(events2, { storage: storage2 });
    await manager2.start();

    try {
      const persisted = await manager2.listPersistedSessions();
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.sessionId).toBe(sessionId);
      expect(persisted[0]?.totalTurns).toBe(1);
    } finally {
      await manager2.shutdown();
      await storage2.stop();
    }
  });

  it("external Drizzle client sees the same session rows (joins work too)", async () => {
    const { sessionId } = await manager.createSession("fake", { cwd: "/tmp/x" });
    fake.emit({ type: "turn_started", sessionId, turnId: "t-external" });
    fake.emit({
      type: "tool_call_completed",
      sessionId,
      toolCall: {
        id: "tc-external",
        turnId: "t-external",
        toolName: "Bash",
        toolKind: "terminal",
        status: "completed",
        arguments: { command: "ls" },
        result: { stdout: "file.txt" },
        durationMs: 10,
        createdAt: new Date().toISOString(),
      } satisfies SessionToolCallData,
    });
    await manager.flushPersist();

    // Query as an external Drizzle user would — import schema and run a join.
    const { drizzle } = await import("drizzle-orm/libsql");
    const { eq } = await import("drizzle-orm");
    const db = drizzle(storage.client, { schema });

    const rows = await db
      .select({
        sessionId: schema.sessions.sessionId,
        provider: schema.sessions.provider,
        toolName: schema.sessionToolCalls.toolName,
        toolStatus: schema.sessionToolCalls.status,
      })
      .from(schema.sessions)
      .leftJoin(
        schema.sessionToolCalls,
        eq(schema.sessionToolCalls.sessionId, schema.sessions.sessionId),
      )
      .where(eq(schema.sessions.sessionId, sessionId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe("fake");
    expect(rows[0]?.toolName).toBe("Bash");
    expect(rows[0]?.toolStatus).toBe("completed");
  });
});

/** Helper extension to build SessionToolCallData without boilerplate. */
function _contentBlockText(text: string): ContentBlock {
  return { type: "text", text } as ContentBlock;
}
