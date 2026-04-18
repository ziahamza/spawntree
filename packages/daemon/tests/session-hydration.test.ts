import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  schema,
  type ACPAdapter,
  type ACPSessionDetail,
  type ContentBlock,
  type DiscoveredSession,
  type SessionEvent,
} from "spawntree-core";
import { DomainEvents } from "../src/events/domain-events.ts";
import { SessionManager } from "../src/sessions/session-manager.ts";
import { StorageManager } from "../src/storage/manager.ts";

/**
 * Prove the hydration path: `persistSessionEvent` deliberately skips
 * `message_delta` to avoid write amplification, so the turn's `content`
 * column is initially empty. On `turn_completed` the SessionManager calls
 * the adapter's `getSessionDetail` once and backfills the final content,
 * stop reason, duration, and model id.
 *
 * External Drizzle readers then see complete turn rows without having to
 * call the adapter subprocess themselves — that's the whole point.
 */

class HydratingFakeAdapter implements ACPAdapter {
  readonly provider = "fake-hydrate";
  private handlers = new Set<(event: SessionEvent) => void>();
  private discovered: Array<DiscoveredSession> = [];
  // Turn details the adapter "knows about". The test seeds this before
  // firing turn_completed so hydration reads back the right content.
  private turnBank = new Map<string, ACPSessionDetail["turns"][number]>();

  async isAvailable() {
    return true;
  }
  async discoverSessions() {
    return this.discovered;
  }
  async getSessionDetail(_sessionId: string): Promise<ACPSessionDetail> {
    return { turns: [...this.turnBank.values()], toolCalls: [] };
  }
  async createSession({ cwd }: { cwd: string }) {
    const sessionId = `fake-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.discovered.push({
      sourceId: sessionId,
      status: "idle" as const,
      title: null,
      workingDirectory: cwd,
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

  emit(event: SessionEvent) {
    for (const h of this.handlers) h(event);
  }

  stashTurn(turn: ACPSessionDetail["turns"][number]): void {
    this.turnBank.set(turn.id, turn);
  }
}

describe("SessionManager turn hydration", () => {
  let tmp: string;
  let storage: StorageManager;
  let manager: SessionManager;
  let fake: HydratingFakeAdapter;

  beforeEach(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-hydrate-"));
    storage = new StorageManager({ dataDir: tmp, logger: () => undefined });
    await storage.start();
    const events = new DomainEvents();
    manager = new SessionManager(events, { storage });
    await manager.start();
    fake = new HydratingFakeAdapter();
    manager.registerAdapter("fake-hydrate", fake);
  });

  afterEach(async () => {
    await manager.shutdown();
    await storage.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("backfills turn content on turn_completed", async () => {
    const { sessionId } = await manager.createSession("fake-hydrate", { cwd: "/tmp/x" });

    // Start the turn — at this point the catalog row has empty content
    // because `persistSessionEvent` intentionally skips message_delta
    // frames and doesn't materialise content from turn_started alone.
    fake.emit({ type: "turn_started", sessionId, turnId: "t1" });

    // Stash the "final" turn state in the adapter, then fire the
    // completion — hydration should pull this through.
    const finalContent: Array<ContentBlock> = [
      { type: "text", text: "Hello from Claude!" } as ContentBlock,
    ];
    fake.stashTurn({
      id: "t1",
      turnIndex: 0,
      role: "assistant",
      content: finalContent,
      modelId: "claude-sonnet-4.7",
      durationMs: 1234,
      stopReason: "end_turn",
      status: "completed",
      errorMessage: null,
      createdAt: new Date().toISOString(),
    });
    fake.emit({ type: "turn_completed", sessionId, turnId: "t1", status: "completed" });

    await manager.flushPersist();

    const db = drizzle(storage.client, { schema });
    const [row] = await db
      .select()
      .from(schema.sessionTurns)
      .where(eq(schema.sessionTurns.id, "t1"));

    expect(row).toBeDefined();
    expect(row?.status).toBe("completed");
    expect(row?.modelId).toBe("claude-sonnet-4.7");
    expect(row?.durationMs).toBe(1234);
    expect(row?.stopReason).toBe("end_turn");
    const content = row?.content as Array<ContentBlock> | null;
    expect(content).toHaveLength(1);
    expect((content![0] as { text: string }).text).toBe("Hello from Claude!");
  });

  it("hydration is a no-op if the adapter doesn't know the turn", async () => {
    const { sessionId } = await manager.createSession("fake-hydrate", { cwd: "/tmp/x" });
    fake.emit({ type: "turn_started", sessionId, turnId: "orphan" });
    // Don't stash anything in the adapter's turnBank; getSessionDetail
    // will return an empty turns array, and hydration has nothing to do.
    fake.emit({ type: "turn_completed", sessionId, turnId: "orphan", status: "completed" });

    await manager.flushPersist();

    const db = drizzle(storage.client, { schema });
    const [row] = await db
      .select()
      .from(schema.sessionTurns)
      .where(eq(schema.sessionTurns.id, "orphan"));
    // Status update from persistSessionEvent still landed; content is
    // still empty because hydration had nothing to write.
    expect(row?.status).toBe("completed");
    expect(row?.content).toEqual([]);
  });

  it("hydration failure (adapter error) doesn't poison the persist queue", async () => {
    const { sessionId } = await manager.createSession("fake-hydrate", { cwd: "/tmp/x" });

    // Replace the adapter's getSessionDetail with one that throws, then
    // emit turn_completed. The hydration call throws, is logged, and the
    // queue continues to accept subsequent events.
    fake.getSessionDetail = async () => {
      throw new Error("simulated adapter failure");
    };

    fake.emit({ type: "turn_started", sessionId, turnId: "t-fail" });
    fake.emit({ type: "turn_completed", sessionId, turnId: "t-fail", status: "completed" });
    fake.emit({ type: "turn_started", sessionId, turnId: "t-after" });

    await manager.flushPersist();

    const db = drizzle(storage.client, { schema });
    const rows = await db
      .select({ id: schema.sessionTurns.id, status: schema.sessionTurns.status })
      .from(schema.sessionTurns);
    const ids = rows.map((r) => r.id).sort();
    // Both turns should still have been persisted — hydration failure
    // doesn't block other writes.
    expect(ids).toEqual(["t-after", "t-fail"]);
  });
});
