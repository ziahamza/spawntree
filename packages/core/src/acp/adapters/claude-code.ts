import { execSync } from "node:child_process";
import type * as acp from "@zed-industries/agent-client-protocol";
import { detectGitMetadata } from "../../lib/git.ts";
import { ACPConnection } from "../client.ts";
import { SessionBusyError } from "../adapter.ts";
import type {
  ACPAdapter,
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
}

export class ClaudeCodeAdapter implements ACPAdapter {
  readonly name = "claude-code";

  private readonly options: ClaudeCodeAdapterOptions;
  private readonly sessions = new Map<string, TrackedSession>();
  private eventHandlers: Array<(event: SessionEvent) => void> = [];
  private connection: ACPConnection | null = null;
  private started = false;
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
      env: this.options.env,
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

      await connection.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      } satisfies acp.InitializeRequest);

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

    const response = await conn.newSession({
      cwd: params.cwd,
      mcpServers: (params.mcpServers as acp.McpServer[] | undefined) ?? [],
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
    });

    return { sessionId: response.sessionId };
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
    return { turns: [...s.turns], toolCalls: [...s.toolCalls] };
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    await this.ensureStarted();
    const conn = this.requireConnection();
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}. Call createSession first.`);
    }

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
    await conn.cancel({ sessionId } satisfies acp.CancelNotification);
  }

  async resumeSession(sessionId: string): Promise<void> {
    await this.ensureStarted();
    const conn = this.requireConnection();
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session: ${sessionId}`);
    await conn.loadSession({
      sessionId,
      cwd: s.cwd,
      mcpServers: [],
    } satisfies acp.LoadSessionRequest);
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
