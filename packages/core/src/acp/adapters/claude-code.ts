import { execSync } from "node:child_process";
import type * as acp from "@zed-industries/agent-client-protocol";
import { detectGitMetadata } from "../../lib/git.ts";
import { ACPConnection } from "../client.ts";
import { SessionBusyError, SessionResumeFailedError } from "../adapter.ts";
import type {
  ACPAdapter,
  AdoptedSession,
  DiscoveredSession,
  SessionDetail,
  SessionEvent,
  SessionStatus,
  SessionToolCallData,
  SessionTurnData,
} from "../adapter.ts";

/**
 * Adapter for Claude Code via @zed-industries/claude-code-acp.
 *
 * Claude Code speaks Agent Client Protocol natively (through the Zed
 * adapter package). This class owns the subprocess, creates sessions,
 * dispatches prompts, and translates ACP session/update notifications
 * into the normalized SessionEvent stream spawntree consumes.
 *
 * Unlike Codex, Claude Code does not persist session history itself;
 * sessions live in memory for the lifetime of this adapter instance.
 * Durable persistence is the daemon's responsibility.
 */
export interface ClaudeCodeAdapterOptions {
  /** Override the spawn command. Defaults to `npx` with the claude-code-acp package. */
  command?: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Identity reported in the ACP initialize handshake. */
  clientName?: string;
  clientVersion?: string;
  /** Forwarded to the default ACP Client. */
  permissionPolicy?: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  /**
   * Forwarded to the default ACP Client. When set, takes precedence over
   * `permissionPolicy` and lets the caller (typically the daemon's
   * SessionManager) suspend on real user input before resolving.
   */
  permissionHandler?: (
    params: acp.RequestPermissionRequest,
  ) => Promise<acp.RequestPermissionResponse>;
}

interface TrackedSession {
  sourceId: string;
  cwd: string;
  status: SessionStatus;
  title: string | null;
  turns: SessionTurnData[];
  toolCalls: SessionToolCallData[];
  turnCounter: number;
  activeTurnId: string | null;
  createdAt: string;
  updatedAt: string;
  gitBranch: string | null;
  gitHeadCommit: string | null;
  gitRemoteUrl: string | null;
  /**
   * False when the session was reconstructed from the daemon's catalog
   * (cross-restart adoption) and the ACP subprocess has not yet been told
   * about it via `loadSession`. Flipped to true after `ensureSubprocessHasSession`
   * runs successfully, OR set true on `createSession` since the subprocess
   * created the session itself.
   */
  loadedInSubprocess: boolean;
  /**
   * MCP server list the session was opened with. Replayed verbatim on
   * `loadSession` so a session that gets re-loaded into the subprocess
   * (e.g. after a connection bounce, or any adapter lifecycle that
   * re-issues `loadSession`) keeps the same tool surface it had during
   * its first run. `null` when we don't know — currently the case for
   * sessions adopted from the catalog after a daemon restart, because
   * the catalog schema doesn't persist this list yet. Cross-restart
   * persistence is a follow-up (would require an `mcp_servers` JSON
   * column on `sessions`).
   */
  mcpServers: acp.McpServer[] | null;
  /**
   * Set when an attempt to resume this session via ACP `loadSession`
   * failed and we don't intend to retry. The session is then treated
   * as read-only — `sendMessage` / `interruptSession` throw
   * `SessionResumeFailedError` immediately and the Studio surfaces a
   * banner instead of looping the failing RPC. Sessions imported from
   * `~/.claude/projects/` (discovered from disk) are the main source
   * of these failures: their `.jsonl` exists but the agent's own
   * session registry may not, so `loadSession` returns "session not
   * found" even though the transcript is readable.
   */
  resumeFailed: boolean;
}

export class ClaudeCodeAdapter implements ACPAdapter {
  readonly name = "claude-code";

  private readonly options: ClaudeCodeAdapterOptions;
  private readonly sessions = new Map<string, TrackedSession>();
  private eventHandlers: Array<(event: SessionEvent) => void> = [];
  private connection: ACPConnection | null = null;
  private started = false;
  /**
   * Capabilities returned by the agent in the `initialize()` handshake.
   * Captured so `ensureSubprocessHasSession` can short-circuit with a
   * clear error when the agent doesn't support `loadSession` (rather than
   * failing later inside the ACP wire call). Null until the first
   * successful handshake.
   */
  private agentCapabilities: acp.AgentCapabilities | null = null;
  /**
   * In-flight start promise. Concurrent `ensureStarted()` callers (e.g.
   * the two arms of `Promise.all([getSessionInfo, getSessionDetail])`
   * in the GET /:id route) await the same promise instead of racing the
   * `initialize()` handshake. Without this guard the second caller
   * could see `this.connection.isAlive` true while `initialize()` is
   * still in flight, and send prompts against an un-initialized link.
   */
  private startPromise: Promise<void> | null = null;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.options = options;
  }

  async isAvailable(): Promise<boolean> {
    try {
      execSync("which npx", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (this.started && this.connection?.isAlive) return;
    // Concurrent callers piggyback on the in-flight start so the
    // initialize() handshake doesn't race.
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    // If a previous start() threw before `this.started = true`, shut down
    // the stale connection so we don't leak its subprocess on retry.
    if (this.connection) {
      await this.connection.shutdown().catch(() => {});
      this.connection = null;
    }

    const command = this.options.command ?? "npx";
    const args = this.options.args ?? ["-y", "@zed-industries/claude-code-acp"];
    const connection = new ACPConnection({
      command,
      args,
      // Strip env vars that signal "we're already inside a Claude Code
      // session" before spawning claude-code-acp. Without this, when the
      // spawntree daemon is launched from inside Claude Code (common
      // during development on the spawntree codebase itself), the
      // subprocess inherits CLAUDECODE=1 from the harness and refuses
      // to start with: "Claude Code cannot be launched inside another
      // Claude Code session." Setting these to `undefined` makes Node's
      // child_process spawn treat them as unset in the child, regardless
      // of what's in the daemon's own process.env.
      //
      // Custom `env` from `this.options.env` is spread FIRST so the
      // explicit unsets win the merge — callers that pass through
      // `process.env` (or any env carrying these keys) would otherwise
      // reintroduce CLAUDECODE and hit the nested-Claude refusal this
      // block exists to prevent.
      env: {
        ...this.options.env,
        CLAUDECODE: undefined,
        CLAUDE_CODE_ENTRYPOINT: undefined,
        CLAUDE_CODE_SSE_PORT: undefined,
      },
      label: "claude-code",
      defaultClient: {
        permissionPolicy: this.options.permissionPolicy ?? "allow_once",
        permissionHandler: this.options.permissionHandler,
      },
    });

    try {
      await connection.start();

      // Register the notification handler BEFORE initialize() so we don't
      // miss any session/update events emitted during the handshake.
      connection.onSessionUpdate((notification) => {
        this.handleSessionUpdate(notification);
      });

      const initResponse = await connection.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      } satisfies acp.InitializeRequest);

      // Cache capabilities so `ensureSubprocessHasSession` can pre-check
      // `loadSession` support and produce a clear error instead of a
      // generic ACP failure when adopting a session from the catalog.
      this.agentCapabilities = initResponse.agentCapabilities ?? null;

      // Publish connection + started AFTER the handshake so concurrent
      // callers entering ensureStarted() during initialize() correctly
      // see started === false and wait on the shared startPromise.
      this.connection = connection;
      this.started = true;
    } catch (err) {
      // Handshake failed — kill the subprocess so a retry creates a fresh one
      // instead of overwriting this.connection and leaking the old process.
      await connection.shutdown().catch(() => {});
      this.connection = null;
      this.started = false;
      throw err;
    }
  }

  async createSession(params: {
    cwd: string;
    mcpServers?: unknown[];
  }): Promise<{ sessionId: string }> {
    await this.ensureStarted();
    const conn = this.requireConnection();

    const mcpServers = (params.mcpServers as acp.McpServer[] | undefined) ?? [];
    const response = await conn.newSession({
      cwd: params.cwd,
      mcpServers,
    });

    const now = new Date().toISOString();
    const git = detectGitMetadata(params.cwd);
    this.sessions.set(response.sessionId, {
      sourceId: response.sessionId,
      cwd: params.cwd,
      status: "idle",
      title: null,
      turns: [],
      toolCalls: [],
      turnCounter: 0,
      activeTurnId: null,
      createdAt: now,
      updatedAt: now,
      gitBranch: git.branch,
      gitHeadCommit: git.headCommit,
      gitRemoteUrl: git.remoteUrl,
      // Subprocess just created this session, so it already knows about it.
      loadedInSubprocess: true,
      mcpServers,
      resumeFailed: false,
    });

    return { sessionId: response.sessionId };
  }

  /**
   * Re-introduce a session that was created in a previous adapter lifetime
   * and persisted in the daemon's catalog. Synchronous and cheap — only
   * touches the in-memory `Map`; the ACP subprocess is told about the
   * session lazily, the first time `sendMessage`/`resumeSession`/`interruptSession`
   * is called for it (see `ensureSubprocessHasSession`).
   *
   * Idempotent: re-adopting an already-tracked session is a no-op so a
   * boot-time hydration that races with a discovery pass doesn't clobber
   * fresh in-memory state with stale catalog state.
   */
  adoptSession(input: AdoptedSession): void {
    if (this.sessions.has(input.sessionId)) return;

    // Reconstruct the per-session turn counter so the next sendMessage()
    // doesn't reuse an existing turn id. Turn ids follow the pattern
    // `${sessionId}-turn-${n}`; parse the suffix and take the max. Fall
    // back to user-turn count when the suffix isn't parseable (e.g.
    // legacy ids from a different scheme).
    let maxCounter = 0;
    for (const t of input.turns) {
      const m = /-turn-(\d+)/.exec(t.id);
      if (m && m[1]) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > maxCounter) maxCounter = n;
      }
    }
    if (maxCounter === 0) {
      maxCounter = input.turns.filter((t) => t.role === "user").length;
    }

    this.sessions.set(input.sessionId, {
      sourceId: input.sessionId,
      cwd: input.cwd,
      // Anything that was streaming when the previous daemon died is
      // stuck — the subprocess is gone. Mark idle so the UI doesn't show
      // a forever-spinning row; the catalog still has the partial turn.
      status: input.status === "streaming" ? "idle" : input.status,
      title: input.title,
      turns: [...input.turns],
      toolCalls: [...input.toolCalls],
      turnCounter: maxCounter,
      activeTurnId: null,
      createdAt: input.startedAt,
      updatedAt: input.updatedAt,
      gitBranch: input.gitBranch,
      gitHeadCommit: input.gitHeadCommit,
      gitRemoteUrl: input.gitRemoteUrl,
      loadedInSubprocess: false,
      // The catalog doesn't yet persist the original MCP server list, so
      // post-restart adoption can't recover it. `null` signals "unknown"
      // to `ensureSubprocessHasSession`, which then falls back to an
      // empty list and emits a warning.
      mcpServers: null,
      resumeFailed: false,
    });
  }

  /**
   * Make sure the ACP subprocess knows about `sessionId` before we send
   * it a request that references it (`prompt`, `cancel`). Sessions that
   * were just created via `createSession()` are already loaded; sessions
   * adopted from the catalog after a daemon restart need an explicit
   * `loadSession` RPC to re-establish state on the agent side.
   *
   * If the agent's `initialize` response did not advertise the
   * `loadSession` capability, throws a typed error so the caller can
   * surface a clear diagnostic instead of an opaque "method not supported"
   * from the ACP wire layer.
   */
  private async ensureSubprocessHasSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.loadedInSubprocess) return;
    // A previous attempt already failed; fail fast instead of replaying
    // the same RPC on every interaction. The Studio renders a read-only
    // banner when this flag is exposed via getSessionDetail.
    if (session.resumeFailed) {
      throw new SessionResumeFailedError(sessionId, this.name);
    }

    if (!this.agentCapabilities?.loadSession) {
      // Map capability-missing to the same typed error as a runtime
      // "session not found", so the HTTP layer returns 409 Conflict and
      // the Studio renders the read-only banner instead of treating it
      // as an opaque 500. The sticky flag is also set: a given agent
      // build either advertises `loadSession` or it doesn't, so this
      // failure is permanent for the lifetime of this subprocess.
      session.resumeFailed = true;
      throw new SessionResumeFailedError(sessionId, this.name);
    }

    const conn = this.requireConnection();
    // Replay the original MCP server list when we know it so the resumed
    // session keeps the same tool surface; fall back to empty when the
    // session was adopted from the catalog (where this list isn't yet
    // persisted) and warn so the gap is visible in logs.
    const mcpServers = session.mcpServers ?? [];
    if (session.mcpServers === null) {
      process.stderr.write(
        `[spawntree-daemon] loadSession ${sessionId}: original mcpServers unknown ` +
          `(catalog does not persist this list across restarts); resuming with empty list\n`,
      );
    }
    try {
      await conn.loadSession({
        sessionId,
        cwd: session.cwd,
        mcpServers,
      } satisfies acp.LoadSessionRequest);
      session.loadedInSubprocess = true;
    } catch (err) {
      // Distinguish definitive failures from transient ones. "Session
      // not found" / "unknown session" / "does not exist" responses
      // from the agent are permanent (the .jsonl exists but the agent
      // was never told about the session, so the only safe state is
      // read-only). Network/connection errors and other transient
      // failures (ACP disconnect during boot race, brief subprocess
      // restart) should NOT freeze the session: retrying on the next
      // interaction is the correct behavior. The earlier "any error
      // is sticky" rule converted otherwise-recoverable hiccups into
      // permanent read-only mode until daemon restart.
      const permanent = isPermanentLoadSessionFailure(err);
      if (permanent) {
        session.resumeFailed = true;
        process.stderr.write(
          `[spawntree-daemon] loadSession ${sessionId} failed permanently: ${String(err)} — marking session as resume-failed (read-only)\n`,
        );
        throw new SessionResumeFailedError(sessionId, this.name, err);
      }
      process.stderr.write(
        `[spawntree-daemon] loadSession ${sessionId} failed (transient, will retry): ${String(err)}\n`,
      );
      // Re-throw the raw error so the HTTP layer returns 500 and the
      // client retries naturally; no sticky flag, so the next call
      // will attempt loadSession again.
      throw err;
    }
  }

  async discoverSessions(): Promise<DiscoveredSession[]> {
    const out: DiscoveredSession[] = [];
    for (const s of this.sessions.values()) {
      out.push({
        sourceId: s.sourceId,
        provider: this.name,
        status: s.status,
        title: s.title,
        workingDirectory: s.cwd,
        gitBranch: s.gitBranch,
        gitHeadCommit: s.gitHeadCommit,
        gitRemoteUrl: s.gitRemoteUrl,
        // Normalize to "conversation turns" = number of user messages so the
        // value matches CodexACPAdapter. We store user and assistant records
        // as separate entries in `s.turns`, so counting user-role entries
        // gives the conversational turn count the UI expects.
        totalTurns: s.turns.filter((t) => t.role === "user").length,
        startedAt: s.createdAt,
        updatedAt: s.updatedAt,
      });
    }
    return out;
  }

  async getSessionDetail(sessionId: string): Promise<SessionDetail> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session: ${sessionId}`);
    return {
      turns: [...s.turns],
      toolCalls: [...s.toolCalls],
      // Surface the read-only state so the UI can render its banner
      // without having to attempt a sendMessage first to discover the
      // resume failure.
      resumeFailed: s.resumeFailed,
    };
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    await this.ensureStarted();
    const conn = this.requireConnection();
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}. Call createSession first.`);
    }
    // Adopted sessions need a one-shot loadSession before the subprocess
    // accepts prompts referencing this id. Throws if the agent doesn't
    // advertise the loadSession capability.
    await this.ensureSubprocessHasSession(sessionId);

    // Reject concurrent sends — ACP does not support parallel turns within
    // one session. Allowing two sendMessage() calls would race: both would
    // overwrite `session.activeTurnId`, and inbound session/update
    // notifications would be misattributed to whichever turn id won the
    // race. Clients should interrupt the active turn first.
    if (session.activeTurnId !== null) {
      throw new SessionBusyError(sessionId, session.activeTurnId);
    }

    const turnId = `${sessionId}-turn-${++session.turnCounter}`;
    session.activeTurnId = turnId;
    session.status = "streaming";
    session.updatedAt = new Date().toISOString();

    session.turns.push({
      id: `${turnId}-user`,
      turnIndex: session.turns.length,
      role: "user",
      content: [{ type: "text", text: content }],
      modelId: null,
      durationMs: null,
      stopReason: null,
      status: "completed",
      errorMessage: null,
      createdAt: session.updatedAt,
    });

    this.emitEvent({ type: "turn_started", sessionId, turnId });
    this.emitEvent({ type: "session_status_changed", sessionId, status: "streaming" });

    const promptParams: acp.PromptRequest = {
      sessionId,
      prompt: [{ type: "text", text: content }],
    };

    conn.prompt(promptParams).then(
      (response) => {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        s.status = "idle";
        s.activeTurnId = null;
        s.updatedAt = new Date().toISOString();
        // Mark the agent turn record as completed so getSessionDetail() reflects reality.
        const agentTurn = s.turns.find((t) => t.id === `${turnId}-agent`);
        if (agentTurn) {
          agentTurn.status = "completed";
          agentTurn.stopReason = response.stopReason;
        }
        // Claude Code's ACP wrapper does not always emit a final tool_call_update
        // with a terminal status, so tools can linger in "pending"/"in_progress"
        // after the turn finishes. Close them out here so spinners stop.
        for (const tc of s.toolCalls) {
          if (tc.turnId !== turnId) continue;
          if (tc.status === "pending" || tc.status === "in_progress") {
            tc.status = "completed";
            this.emitEvent({
              type: "tool_call_completed",
              sessionId,
              toolCall: tc,
            });
          }
        }
        this.emitEvent({
          type: "turn_completed",
          sessionId,
          turnId,
          status: response.stopReason,
        });
        this.emitEvent({ type: "session_status_changed", sessionId, status: "idle" });
      },
      (err: unknown) => {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        s.status = "error";
        s.activeTurnId = null;
        s.updatedAt = new Date().toISOString();
        const message = err instanceof Error ? err.message : String(err);
        // Mark the agent turn record as errored.
        const agentTurn = s.turns.find((t) => t.id === `${turnId}-agent`);
        if (agentTurn) {
          agentTurn.status = "error";
          agentTurn.errorMessage = message;
        }
        for (const tc of s.toolCalls) {
          if (tc.turnId !== turnId) continue;
          if (tc.status === "pending" || tc.status === "in_progress") {
            tc.status = "error";
            this.emitEvent({
              type: "tool_call_completed",
              sessionId,
              toolCall: tc,
            });
          }
        }
        this.emitEvent({
          type: "turn_completed",
          sessionId,
          turnId,
          status: `error: ${message}`,
        });
        this.emitEvent({ type: "session_status_changed", sessionId, status: "error" });
      },
    );
  }

  async interruptSession(sessionId: string): Promise<void> {
    const conn = this.connection;
    if (!conn) return;
    // Cancelling a session the subprocess never heard of is a no-op on
    // the agent side and on ours — only flush the wire when the session
    // is actually loaded there. Adopted-but-never-touched sessions never
    // had an active turn anyway, so there's nothing to cancel.
    const session = this.sessions.get(sessionId);
    if (!session || !session.loadedInSubprocess) return;
    await conn.cancel({ sessionId } satisfies acp.CancelNotification);
  }

  async resumeSession(sessionId: string): Promise<void> {
    await this.ensureStarted();
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session: ${sessionId}`);
    // Idempotent: if the session is already loaded into the subprocess,
    // ensureSubprocessHasSession is a no-op. Otherwise it sends the
    // ACP loadSession RPC.
    await this.ensureSubprocessHasSession(sessionId);
  }

  /**
   * Forget a Claude Code session. Since Claude Code sessions live only in
   * memory (the ACP subprocess has no durable session store), this simply
   * removes the local tracking record. If a turn is in flight we attempt
   * to cancel it first so the subprocess doesn't keep streaming into a
   * handler that no longer exists.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // Idempotent — deleting an unknown session is a no-op, not an error.
      return;
    }

    if (session.activeTurnId && this.connection?.isAlive) {
      await this.connection.cancel({ sessionId } satisfies acp.CancelNotification).catch(() => {});
    }

    this.sessions.delete(sessionId);
  }

  onSessionEvent(handler: (event: SessionEvent) => void): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx !== -1) this.eventHandlers.splice(idx, 1);
    };
  }

  async shutdown(): Promise<void> {
    await this.connection?.shutdown();
    this.connection = null;
    this.started = false;
    this.eventHandlers = [];
    this.sessions.clear();
    this.agentCapabilities = null;
  }

  private async ensureStarted(): Promise<void> {
    if (!this.started || !this.connection?.isAlive) {
      await this.start();
    }
  }

  private requireConnection(): ACPConnection {
    if (!this.connection) throw new Error("Claude Code adapter not started");
    return this.connection;
  }

  private emitEvent(event: SessionEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  private handleSessionUpdate(notification: acp.SessionNotification): void {
    const session = this.sessions.get(notification.sessionId);
    if (!session) return;

    const update = notification.update;
    const activeTurnId = session.activeTurnId;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const text = extractText(update.content);
        if (text && activeTurnId) {
          this.appendAssistantText(session, activeTurnId, text);
          this.emitEvent({
            type: "message_delta",
            sessionId: session.sourceId,
            turnId: activeTurnId,
            text,
          });
        }
        break;
      }
      case "user_message_chunk": {
        // Echoed user content — already recorded locally when we called sendMessage.
        break;
      }
      case "tool_call": {
        const existing = session.toolCalls.find((t) => t.id === update.toolCallId);
        if (existing) {
          // Claude Code sometimes emits two tool_call notifications with the
          // same id — first with a generic title and empty args, then with the
          // enriched title and real arguments. Merge the second into the first
          // so we don't duplicate rows in memory.
          if (update.status) existing.status = mapToolStatus(update.status);
          if (update.kind) existing.toolKind = mapToolKind(update.kind);
          if (update.title) existing.toolName = update.title;
          if (update.rawInput !== undefined) existing.arguments = update.rawInput ?? null;
          this.emitEvent({
            type:
              existing.status === "completed" || existing.status === "error"
                ? "tool_call_completed"
                : "tool_call_started",
            sessionId: session.sourceId,
            toolCall: existing,
          });
          break;
        }
        const toolCall: SessionToolCallData = {
          id: update.toolCallId,
          turnId: activeTurnId,
          toolName: update.title,
          toolKind: mapToolKind(update.kind),
          status: mapToolStatus(update.status),
          arguments: update.rawInput ?? null,
          result: null,
          durationMs: null,
          createdAt: new Date().toISOString(),
        };
        session.toolCalls.push(toolCall);
        this.emitEvent({
          type: "tool_call_started",
          sessionId: session.sourceId,
          toolCall,
        });
        break;
      }
      case "tool_call_update": {
        const existing = session.toolCalls.find((t) => t.id === update.toolCallId);
        if (!existing) break;
        if (update.status) existing.status = mapToolStatus(update.status);
        if (update.kind) existing.toolKind = mapToolKind(update.kind);
        if (update.title) existing.toolName = update.title;
        if (update.rawOutput !== undefined) existing.result = update.rawOutput;
        if (existing.status === "completed" || existing.status === "error") {
          this.emitEvent({
            type: "tool_call_completed",
            sessionId: session.sourceId,
            toolCall: existing,
          });
        }
        break;
      }
      case "plan":
      case "available_commands_update":
      case "current_mode_update":
        // Not currently mapped to SessionEvent; consumers may subscribe to
        // the raw ACP stream via ACPConnection.onSessionUpdate if needed.
        break;
    }
  }

  private appendAssistantText(session: TrackedSession, turnId: string, text: string): void {
    const turnRecordId = `${turnId}-agent`;
    let turn = session.turns.find((t) => t.id === turnRecordId);
    if (!turn) {
      turn = {
        id: turnRecordId,
        turnIndex: session.turns.length,
        role: "assistant",
        content: [{ type: "text", text: "" }],
        modelId: null,
        durationMs: null,
        stopReason: null,
        status: "streaming",
        errorMessage: null,
        createdAt: new Date().toISOString(),
      };
      session.turns.push(turn);
    }
    const last = turn.content[turn.content.length - 1];
    if (last && last.type === "text") {
      last.text += text;
    } else {
      turn.content.push({ type: "text", text });
    }
    session.updatedAt = new Date().toISOString();
  }
}

function extractText(content: acp.ContentBlock): string | null {
  if (content.type === "text") return content.text;
  return null;
}

/**
 * Pattern-match a `loadSession` rejection to decide whether it is
 * permanently unrecoverable (the agent does not know this session)
 * versus a transient hiccup (connection dropped, agent restarted,
 * boot race). Permanent failures freeze the session into read-only
 * mode; transient ones must be retried so the session stays usable.
 *
 * The ACP wire layer surfaces server errors as `Error` instances with
 * the JSON-RPC error payload stringified into `.message`. We probe
 * both the structured `code` (if present) and known substrings, which
 * cover the responses currently emitted by claude-code-acp.
 */
function isPermanentLoadSessionFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const raw = err.message ?? "";
  const msg = raw.toLowerCase();
  if (msg.includes("not found")) return true;
  if (msg.includes("unknown session")) return true;
  if (msg.includes("session does not exist")) return true;
  if (msg.includes("no such session")) return true;
  // Some agents stringify the full JSON-RPC payload — attempt to parse
  // and look at the structured `code` / `message` fields too.
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown };
    // -32602 = Invalid params; claude-code-acp uses this for unknown
    // session id specifically. Pair with a message guard so other
    // invalid-params failures (malformed cwd, etc.) stay transient.
    if (
      parsed.code === -32602 &&
      typeof parsed.message === "string" &&
      /not found|unknown session|does not exist/i.test(parsed.message)
    ) {
      return true;
    }
  } catch {
    // Not a JSON payload — pattern match above is the final word.
  }
  return false;
}

function mapToolKind(kind: string | undefined | null): SessionToolCallData["toolKind"] {
  switch (kind) {
    case "execute":
      return "terminal";
    case "edit":
    case "move":
    case "delete":
      return "file_edit";
    case "read":
    case "search":
    case "fetch":
    case "think":
    case "switch_mode":
    case "other":
    case undefined:
    case null:
    default:
      return "other";
  }
}

function mapToolStatus(status: string | undefined | null): SessionToolCallData["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "pending":
      return "pending";
    case "in_progress":
      return "in_progress";
    case "failed":
      return "error";
    case undefined:
    case null:
    default:
      return "in_progress";
  }
}
