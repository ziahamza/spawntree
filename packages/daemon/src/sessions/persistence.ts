import { desc, eq, sql } from "drizzle-orm";
import type {
  CatalogDb,
  ContentBlock,
  SessionEvent,
  SessionInfo,
  SessionStatus,
  SessionToolCallData,
  SessionTurnData,
} from "spawntree-core";
import { sessions, sessionToolCalls, sessionTurns } from "spawntree-core";

/**
 * Mirror ACP session state into the catalog DB. The ACP adapter subprocesses
 * (Claude Code, Codex) still own the live conversation — this module is the
 * durable projection, so:
 *
 *   - sessions survive daemon restart,
 *   - the s3-snapshot replicator captures conversation history end-to-end,
 *   - external Drizzle clients can query turns and tool calls directly via
 *     `POST /api/v1/catalog/query` or a direct libSQL connection.
 *
 * Writers call `persistSessionEvent(db, event, provider)` on every event
 * coming out of an adapter. Idempotency is critical — adapters replay
 * events on reconnect, and we get partial `message_delta` stream chunks
 * between `turn_started` and `turn_completed`. INSERT OR REPLACE +
 * upsert-on-conflict patterns handle the dedup.
 */

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Upsert a row in `sessions`. Called on create AND opportunistically on
 * status transitions / turn events so the row always reflects the latest
 * known state without requiring a prior insert.
 */
export async function upsertSession(
  db: CatalogDb,
  input: {
    sessionId: string;
    provider: string;
    status: SessionStatus;
    workingDirectory: string;
    title?: string | null;
    gitBranch?: string | null;
    gitHeadCommit?: string | null;
    gitRemoteUrl?: string | null;
    totalTurns?: number;
    startedAt?: string | null;
  },
): Promise<void> {
  const updatedAt = nowIso();
  await db
    .insert(sessions)
    .values({
      sessionId: input.sessionId,
      provider: input.provider,
      status: input.status,
      title: input.title ?? null,
      workingDirectory: input.workingDirectory,
      gitBranch: input.gitBranch ?? null,
      gitHeadCommit: input.gitHeadCommit ?? null,
      gitRemoteUrl: input.gitRemoteUrl ?? null,
      totalTurns: input.totalTurns ?? 0,
      startedAt: input.startedAt ?? updatedAt,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: sessions.sessionId,
      set: {
        provider: input.provider,
        status: input.status,
        title: input.title ?? null,
        workingDirectory: input.workingDirectory,
        gitBranch: input.gitBranch ?? null,
        gitHeadCommit: input.gitHeadCommit ?? null,
        gitRemoteUrl: input.gitRemoteUrl ?? null,
        updatedAt,
      },
    });
}

export async function setSessionStatus(
  db: CatalogDb,
  sessionId: string,
  status: SessionStatus,
): Promise<void> {
  await db
    .update(sessions)
    .set({ status, updatedAt: nowIso() })
    .where(eq(sessions.sessionId, sessionId));
}

export async function bumpTotalTurns(db: CatalogDb, sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({
      totalTurns: sql`${sessions.totalTurns} + 1`,
      updatedAt: nowIso(),
    })
    .where(eq(sessions.sessionId, sessionId));
}

export async function upsertTurn(
  db: CatalogDb,
  input: {
    id: string;
    sessionId: string;
    turnIndex: number;
    role: "user" | "assistant";
    content: Array<ContentBlock>;
    modelId?: string | null;
    durationMs?: number | null;
    stopReason?: string | null;
    status: SessionTurnData["status"];
    errorMessage?: string | null;
    createdAt?: string;
  },
): Promise<void> {
  const createdAt = input.createdAt ?? nowIso();
  await db
    .insert(sessionTurns)
    .values({
      id: input.id,
      sessionId: input.sessionId,
      turnIndex: input.turnIndex,
      role: input.role,
      content: input.content,
      modelId: input.modelId ?? null,
      durationMs: input.durationMs ?? null,
      stopReason: input.stopReason ?? null,
      status: input.status,
      errorMessage: input.errorMessage ?? null,
      createdAt,
    })
    .onConflictDoUpdate({
      target: sessionTurns.id,
      set: {
        turnIndex: input.turnIndex,
        role: input.role,
        content: input.content,
        modelId: input.modelId ?? null,
        durationMs: input.durationMs ?? null,
        stopReason: input.stopReason ?? null,
        status: input.status,
        errorMessage: input.errorMessage ?? null,
      },
    });
}

export async function upsertToolCall(
  db: CatalogDb,
  sessionId: string,
  toolCall: SessionToolCallData,
): Promise<void> {
  await db
    .insert(sessionToolCalls)
    .values({
      id: toolCall.id,
      sessionId,
      turnId: toolCall.turnId ?? null,
      toolName: toolCall.toolName,
      toolKind: toolCall.toolKind,
      status: toolCall.status,
      arguments: toolCall.arguments,
      result: toolCall.result,
      durationMs: toolCall.durationMs ?? null,
      createdAt: toolCall.createdAt,
    })
    .onConflictDoUpdate({
      target: sessionToolCalls.id,
      set: {
        turnId: toolCall.turnId ?? null,
        toolName: toolCall.toolName,
        toolKind: toolCall.toolKind,
        status: toolCall.status,
        arguments: toolCall.arguments,
        result: toolCall.result,
        durationMs: toolCall.durationMs ?? null,
      },
    });
}

/**
 * Route a `SessionEvent` coming off an ACP adapter into the catalog.
 * Invoked for every event in `SessionManager.subscribeToAdapter`. Most
 * event kinds touch one or two rows; the aggregate effect is that
 * `sessions` / `session_turns` / `session_tool_calls` always reflect the
 * latest adapter state without us having to call `getSessionDetail` on
 * every read.
 *
 * We DO NOT insert full turn rows from `message_delta` — those would
 * produce a new row on every token chunk. We only touch turn rows on the
 * lifecycle events (`turn_started`, `turn_completed`), and leave
 * content/stopReason hydration to the adapter's next `getSessionDetail`
 * call if needed.
 */
export async function persistSessionEvent(db: CatalogDb, event: SessionEvent): Promise<void> {
  switch (event.type) {
    case "turn_started": {
      await upsertTurn(db, {
        id: event.turnId,
        sessionId: event.sessionId,
        // We don't know the real turnIndex without querying the adapter.
        // A `getSessionDetail` reconciliation on list refreshes the correct
        // index; for now use the current count as a best-effort so we don't
        // collide with existing rows.
        turnIndex: await nextTurnIndex(db, event.sessionId),
        role: "assistant",
        content: [],
        status: "streaming",
      });
      await bumpTotalTurns(db, event.sessionId);
      return;
    }
    case "turn_completed": {
      await db
        .update(sessionTurns)
        .set({ status: event.status as SessionTurnData["status"] })
        .where(eq(sessionTurns.id, event.turnId));
      await db
        .update(sessions)
        .set({ updatedAt: nowIso() })
        .where(eq(sessions.sessionId, event.sessionId));
      return;
    }
    case "tool_call_started":
    case "tool_call_completed":
    case "tool_call_awaiting_approval": {
      await upsertToolCall(db, event.sessionId, event.toolCall);
      return;
    }
    case "session_status_changed": {
      await setSessionStatus(db, event.sessionId, event.status);
      return;
    }
    case "message_delta": {
      // No-op for persistence — the adapter's next `getSessionDetail` call
      // will produce the final content. Persisting every token chunk would
      // make the catalog a write-amplification nightmare.
      return;
    }
  }
}

async function nextTurnIndex(db: CatalogDb, sessionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)`.as("count") })
    .from(sessionTurns)
    .where(eq(sessionTurns.sessionId, sessionId));
  return Number(row?.count ?? 0);
}

/**
 * Read the persisted session list. Returned in the `SessionInfo` shape so
 * it drops straight into the existing HTTP response envelope.
 */
export async function listPersistedSessions(db: CatalogDb): Promise<Array<SessionInfo>> {
  const rows = await db.select().from(sessions).orderBy(desc(sessions.updatedAt));
  return rows.map(rowToSessionInfo);
}

export async function getPersistedSession(
  db: CatalogDb,
  sessionId: string,
): Promise<SessionInfo | undefined> {
  const [row] = await db.select().from(sessions).where(eq(sessions.sessionId, sessionId)).limit(1);
  return row ? rowToSessionInfo(row) : undefined;
}

export async function deletePersistedSession(db: CatalogDb, sessionId: string): Promise<void> {
  // FK cascades drop turns + tool calls.
  await db.delete(sessions).where(eq(sessions.sessionId, sessionId));
}

/**
 * Backfill a turn's final content + metadata from an adapter's session
 * detail. Called by `SessionManager` after `turn_completed` lands: by
 * then the adapter's `getSessionDetail` returns the fully-assembled
 * `ContentBlock[]`, stop reason, and duration, which `persistSessionEvent`
 * couldn't know (it deliberately skips `message_delta` chunks to avoid
 * write amplification).
 *
 * Idempotent: the UPDATE touches whatever turn row is present. If the
 * turn hasn't been inserted yet (rare — would mean `turn_completed` fired
 * before `turn_started` landed in the queue), the UPDATE affects 0 rows
 * and that's fine.
 */
export async function hydrateTurnContent(db: CatalogDb, turn: SessionTurnData): Promise<void> {
  await db
    .update(sessionTurns)
    .set({
      turnIndex: turn.turnIndex,
      role: turn.role,
      // Drizzle's JSON column type expects mutable; the SessionTurnData
      // schema marks content readonly. Spread to satisfy both.
      content: [...turn.content],
      modelId: turn.modelId ?? null,
      durationMs: turn.durationMs ?? null,
      stopReason: turn.stopReason ?? null,
      status: turn.status,
      errorMessage: turn.errorMessage ?? null,
    })
    .where(eq(sessionTurns.id, turn.id));
}

/**
 * Mark every tool call left in `awaiting_approval` as `error` with a
 * "daemon restarted" hint. The agent that requested permission died
 * with the previous daemon process, so its Promise will never resolve;
 * showing the tool call as forever-pending in the UI would be a lie.
 */
export async function abortPendingApprovalsOnRestart(db: CatalogDb): Promise<void> {
  await db
    .update(sessionToolCalls)
    .set({
      status: "error",
      result: { error: "daemon restarted while awaiting approval" },
    })
    .where(eq(sessionToolCalls.status, "awaiting_approval"));
}

function rowToSessionInfo(row: typeof sessions.$inferSelect): SessionInfo {
  return {
    sessionId: row.sessionId,
    provider: row.provider,
    status: row.status as SessionStatus,
    title: row.title,
    workingDirectory: row.workingDirectory,
    gitBranch: row.gitBranch,
    gitHeadCommit: row.gitHeadCommit,
    gitRemoteUrl: row.gitRemoteUrl,
    totalTurns: row.totalTurns,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
  };
}
