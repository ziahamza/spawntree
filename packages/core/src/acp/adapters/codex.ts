import { execSync } from "node:child_process";
import { JsonRpcTransport } from "../json-rpc.ts";
import { SessionBusyError, SessionDeleteUnsupportedError } from "../adapter.ts";
import type {
  ACPAdapter,
  ContentBlock,
  DiscoveredSession,
  SessionDetail,
  SessionEvent,
  SessionStatus,
  SessionToolCallData,
  SessionTurnData,
} from "../adapter.ts";

/**
 * ACP facade over the Codex app-server.
 *
 * Codex CLI does not speak Agent Client Protocol natively — it exposes its
 * own JSON-RPC 2.0 surface via `codex app-server --listen stdio://`. This
 * adapter wraps that surface behind the ACPAdapter interface, mapping
 * Codex wire types (CodexThread, CodexTurn, CodexThreadItem) onto the
 * normalized DiscoveredSession / SessionDetail / SessionEvent shapes so
 * the rest of spawntree doesn't need to know about Codex specifics.
 *
 * Protocol uses camelCase (Rust serde convention). See `codex-rs/app-server/`.
 */
export class CodexACPAdapter implements ACPAdapter {
  readonly name = "codex";

  private readonly clientName: string;
  private readonly clientVersion: string;

  private transport: JsonRpcTransport | null = null;
  private initialized = false;
  /**
   * In-flight start promise. Concurrent `ensureStarted` callers await
   * the same promise instead of skipping early — without this guard,
   * `this.transport?.isAlive` becomes true as soon as the subprocess
   * spawns, but `await transport.initialize(...)` is still running, so
   * a second caller could try to send RPC through an un-initialized
   * transport and hit a handshake-race failure.
   */
  private startPromise: Promise<void> | null = null;
  private eventHandlers: Array<(event: SessionEvent) => void> = [];
  /** Track active turn IDs per thread so `turn/interrupt` has a target. */
  private readonly activeTurns = new Map<string, string>();

  constructor(options: { clientName?: string; clientVersion?: string } = {}) {
    this.clientName = options.clientName ?? "spawntree";
    this.clientVersion = options.clientVersion ?? "0.0.0";
  }

  async isAvailable(): Promise<boolean> {
    try {
      execSync("which codex", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    // Fully started and transport healthy — nothing to do.
    if (this.initialized && this.transport?.isAlive) return;
    // Another caller is already starting — piggyback on that promise so
    // we don't double-spawn or race the initialize() handshake.
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    // If a previous start() threw after spawning but before completing the
    // handshake, tear down the dangling transport so we don't leak the
    // subprocess on retry.
    if (this.transport) {
      await this.transport.shutdown().catch(() => {});
      this.transport = null;
    }

    const transport = new JsonRpcTransport("codex", ["app-server", "--listen", "stdio://"], {
      label: "codex",
    });

    // Register notification and exit handlers BEFORE initialize() so we don't
    // miss any notifications emitted during or immediately after the handshake.
    transport.on("notification", (method: string, params: unknown) => {
      this.handleNotification(method, params);
    });
    transport.on("exit", () => {
      this.activeTurns.clear();
    });

    try {
      await transport.start();
      await transport.initialize({
        name: this.clientName,
        version: this.clientVersion,
      });
      // Only publish `this.transport` AFTER the handshake completes.
      // Before this point, `isAlive` must read false so concurrent
      // ensureStarted() callers hit the startPromise branch rather than
      // skipping and sending RPC against an un-initialized transport.
      this.transport = transport;
      this.initialized = true;
    } catch (err) {
      // Handshake failed — kill the subprocess so isAlive becomes false and
      // the next ensureStarted() can retry cleanly instead of getting stuck
      // on a live-but-uninitialized transport.
      await transport.shutdown().catch(() => {});
      this.transport = null;
      this.initialized = false;
      throw err;
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const p = params as Record<string, unknown>;
    const threadId = (p["threadId"] as string) ?? "";

    switch (method) {
      case "turn/started": {
        const turn = p["turn"] as { id: string } | undefined;
        if (turn) {
          this.activeTurns.set(threadId, turn.id);
          this.emitEvent({ type: "turn_started", sessionId: threadId, turnId: turn.id });
        }
        break;
      }
      case "item/agentMessage/delta": {
        const delta = p["delta"] as string | undefined;
        const turnId = (p["turnId"] as string) ?? "";
        if (delta) {
          this.emitEvent({
            type: "message_delta",
            sessionId: threadId,
            // Match the `-agent` suffix applied in mapCodexThreadDetail so
            // downstream consumers keyed by mapped turn.id resolve correctly.
            turnId: turnId ? `${turnId}-agent` : turnId,
            text: delta,
          });
        }
        break;
      }
      case "turn/completed": {
        const turn = p["turn"] as { id: string; status?: string } | undefined;
        if (turn) {
          this.activeTurns.delete(threadId);
          this.emitEvent({
            type: "turn_completed",
            sessionId: threadId,
            turnId: turn.id,
            status: (turn.status as string) ?? "completed",
          });
        }
        break;
      }
      case "thread/status/changed": {
        const status = p["status"] as { type: string } | undefined;
        if (status) {
          this.emitEvent({
            type: "session_status_changed",
            sessionId: threadId,
            status: mapCodexStatus(status),
          });
        }
        break;
      }
    }
  }

  private emitEvent(event: SessionEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  private getTransport(): JsonRpcTransport {
    const transport = this.transport;
    if (!transport?.isAlive) {
      throw new Error("Codex transport not started");
    }
    return transport;
  }

  async discoverSessions(): Promise<DiscoveredSession[]> {
    await this.ensureStarted();
    const transport = this.getTransport();
    const sessions: DiscoveredSession[] = [];
    let cursor: string | undefined;

    do {
      const result = (await transport.request("thread/list", {
        limit: 50,
        ...(cursor ? { cursor } : {}),
      })) as { data: CodexThread[]; nextCursor: string | null };

      for (const thread of result.data) {
        sessions.push(mapCodexThread(thread));
      }

      cursor = result.nextCursor ?? undefined;
    } while (cursor);

    return sessions;
  }

  async getSessionDetail(sessionId: string): Promise<SessionDetail> {
    await this.ensureStarted();
    const transport = this.getTransport();

    const result = (await transport.request("thread/read", {
      threadId: sessionId,
      includeTurns: true,
    })) as { thread: CodexThread };

    return mapCodexThreadDetail(result.thread);
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    await this.ensureStarted();
    const transport = this.getTransport();

    // Reject concurrent sends on the same thread — Codex turns are strictly
    // sequential. If a turn is already in flight, the caller must interrupt
    // it before starting a new one.
    const activeTurnId = this.activeTurns.get(sessionId);
    if (activeTurnId) {
      throw new SessionBusyError(sessionId, activeTurnId);
    }

    const listResult = (await transport.request("thread/loaded/list")) as {
      data: string[];
    };
    if (!listResult.data.includes(sessionId)) {
      await transport.request("thread/resume", { threadId: sessionId });
    }

    await transport.request("turn/start", {
      threadId: sessionId,
      input: [{ type: "text", text: content }],
    });
  }

  async interruptSession(sessionId: string): Promise<void> {
    await this.ensureStarted();
    const transport = this.getTransport();
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) {
      return;
    }
    await transport.request("turn/interrupt", { threadId: sessionId, turnId });
  }

  async resumeSession(sessionId: string): Promise<void> {
    await this.ensureStarted();
    const transport = this.getTransport();
    await transport.request("thread/resume", { threadId: sessionId });
  }

  /**
   * Codex persists threads in its own app-server and does not expose a
   * delete RPC. We surface `SessionDeleteUnsupportedError` so the HTTP
   * layer returns 501 Not Implemented rather than a misleading 200 ok.
   * Prevents clients from thinking the session has been removed when it
   * still shows up in `thread/list`.
   */
  async deleteSession(sessionId: string): Promise<void> {
    throw new SessionDeleteUnsupportedError(sessionId, this.name);
  }

  onSessionEvent(handler: (event: SessionEvent) => void): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx !== -1) this.eventHandlers.splice(idx, 1);
    };
  }

  async shutdown(): Promise<void> {
    await this.transport?.shutdown();
    this.transport = null;
    this.initialized = false;
    this.eventHandlers = [];
    this.activeTurns.clear();
  }

  private async ensureStarted(): Promise<void> {
    if (!this.initialized || !this.transport?.isAlive) {
      await this.start();
    }
  }
}

// ─── Codex wire protocol ────────────────────────────────────────────────

interface CodexThread {
  id: string;
  preview: string;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  status: { type: string; activeFlags?: unknown };
  cwd: string;
  cliVersion: string;
  gitInfo?: { sha: string; branch: string; originUrl: string } | null;
  name?: string | null;
  turns?: CodexTurn[];
}

interface CodexTurn {
  id: string;
  items: CodexThreadItem[];
  status: string;
  error?: { message: string } | null;
}

interface CodexThreadItem {
  type: string;
  id: string;
  text?: string;
  content?: unknown[];
  command?: string;
  cwd?: string;
  aggregatedOutput?: { output: string };
  exitCode?: number;
  durationMs?: number;
  changes?: Array<{ path: string; patch: string }>;
  status?: string;
  tool?: string;
  server?: string;
  arguments?: unknown;
  result?: unknown;
}

function mapTurnStatus(status: string | undefined): SessionTurnData["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "in_progress":
    case "inProgress":
      return "streaming";
    case "cancelled":
    case "canceled":
    case "interrupted":
      return "cancelled";
    case "failed":
    case "error":
      return "error";
    case undefined:
    default:
      return "completed";
  }
}

function mapToolStatus(status: string | undefined): SessionToolCallData["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "pending":
      return "pending";
    case "in_progress":
    case "inProgress":
      return "in_progress";
    case "failed":
    case "error":
      return "error";
    case undefined:
    default:
      return "completed";
  }
}

function mapCodexStatus(status: { type: string }): SessionStatus {
  switch (status.type) {
    case "active":
      return "streaming";
    case "idle":
      return "idle";
    case "systemError":
      return "error";
    case "notLoaded":
      return "idle";
    default:
      return "idle";
  }
}

function mapCodexThread(thread: CodexThread): DiscoveredSession {
  return {
    sourceId: thread.id,
    provider: "codex",
    status: mapCodexStatus(thread.status),
    title: thread.name ?? thread.preview ?? null,
    workingDirectory: thread.cwd,
    gitBranch: thread.gitInfo?.branch ?? null,
    gitHeadCommit: thread.gitInfo?.sha ?? null,
    gitRemoteUrl: thread.gitInfo?.originUrl ?? null,
    // Normalized semantics: "conversation turns" = number of user messages.
    // Each CodexTurn contains one user message + its agent response, so
    // turns.length matches the conversational turn count reported by
    // ClaudeCodeAdapter (which counts user-role entries in its flat list).
    // Note: `thread/list` omits `turns` by default, so list mode reports 0
    // and callers should use `getSessionDetail` for accurate counts.
    totalTurns: thread.turns?.length ?? 0,
    startedAt: new Date(thread.createdAt * 1000).toISOString(),
    updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
  };
}

function mapCodexThreadDetail(thread: CodexThread): SessionDetail {
  const turns: SessionTurnData[] = [];
  const toolCalls: SessionToolCallData[] = [];

  for (const [i, turn] of (thread.turns ?? []).entries()) {
    const userItems = turn.items.filter((item) => item.type === "userMessage");
    const agentItems = turn.items.filter((item) => item.type !== "userMessage");

    if (userItems.length > 0) {
      const userContent: ContentBlock[] = [];
      for (const item of userItems) {
        if (item.content) {
          for (const c of item.content as Array<{ type: string; text?: string }>) {
            if (c.type === "text" && c.text) {
              userContent.push({ type: "text", text: c.text });
            }
          }
        }
      }
      if (userContent.length > 0) {
        turns.push({
          id: `${turn.id}-user`,
          turnIndex: i * 2,
          role: "user",
          content: userContent,
          modelId: null,
          durationMs: null,
          stopReason: null,
          status: "completed",
          errorMessage: null,
          createdAt: new Date(thread.createdAt * 1000).toISOString(),
        });
      }
    }

    const agentContent: ContentBlock[] = [];
    for (const item of agentItems) {
      switch (item.type) {
        case "agentMessage":
          if (item.text) {
            agentContent.push({ type: "text", text: item.text });
          }
          break;
        case "commandExecution":
          agentContent.push({
            type: "terminal",
            command: item.command ?? "",
            output: item.aggregatedOutput?.output ?? "",
            exitCode: item.exitCode ?? null,
            durationMs: item.durationMs ?? null,
          });
          toolCalls.push({
            id: item.id,
            turnId: turn.id,
            toolName: item.command ?? "shell",
            toolKind: "terminal",
            status: mapToolStatus(item.status),
            arguments: { command: item.command, cwd: item.cwd },
            result: { output: item.aggregatedOutput?.output, exitCode: item.exitCode },
            durationMs: item.durationMs ?? null,
            createdAt: new Date(thread.createdAt * 1000).toISOString(),
          });
          break;
        case "fileChange":
          for (const change of item.changes ?? []) {
            agentContent.push({
              type: "diff",
              path: change.path,
              newText: change.patch,
            });
            toolCalls.push({
              id: `${item.id}-${change.path}`,
              turnId: turn.id,
              toolName: change.path,
              toolKind: "file_edit",
              status: "completed",
              arguments: { path: change.path },
              result: { patch: change.patch },
              durationMs: null,
              createdAt: new Date(thread.createdAt * 1000).toISOString(),
            });
          }
          break;
        case "mcpToolCall":
          toolCalls.push({
            id: item.id,
            turnId: turn.id,
            toolName: `${item.server}/${item.tool}`,
            toolKind: "mcp",
            status: mapToolStatus(item.status),
            arguments: item.arguments,
            result: item.result,
            durationMs: item.durationMs ?? null,
            createdAt: new Date(thread.createdAt * 1000).toISOString(),
          });
          break;
      }
    }

    if (agentContent.length > 0) {
      turns.push({
        id: `${turn.id}-agent`,
        turnIndex: i * 2 + 1,
        role: "assistant",
        content: agentContent,
        modelId: null,
        durationMs: null,
        stopReason: turn.status === "completed" ? "end_turn" : (turn.status ?? null),
        status: mapTurnStatus(turn.status),
        errorMessage: turn.error?.message ?? null,
        createdAt: new Date(thread.createdAt * 1000).toISOString(),
      });
    }
  }

  return { turns, toolCalls };
}
