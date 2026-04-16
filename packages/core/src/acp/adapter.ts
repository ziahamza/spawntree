/**
 * Normalized view of an ACP-capable coding agent. Spawntree uses this
 * interface regardless of whether the underlying agent speaks real
 * Agent Client Protocol (e.g. Claude Code) or a proprietary JSON-RPC
 * dialect wrapped by a facade (e.g. Codex app-server).
 *
 * Wire shapes below intentionally mirror ACP's session model so that
 * ACP-native adapters can pass data through with minimal translation.
 */
export interface ACPAdapter {
  readonly name: string;

  /** Whether the underlying binary is installed on this machine. */
  isAvailable(): Promise<boolean>;

  /** Enumerate all known sessions (active + historical). */
  discoverSessions(): Promise<DiscoveredSession[]>;

  /**
   * Create a new session and return its id. Only implemented by adapters
   * whose underlying agent does not persist sessions itself (e.g. Claude
   * Code). Codex-style adapters where sessions are created implicitly by
   * the agent and discovered afterwards may leave this undefined.
   */
  createSession?(params: { cwd: string; mcpServers?: unknown[] }): Promise<{ sessionId: string }>;

  /** Full detail for a single session: turns, tool calls, interleaved content. */
  getSessionDetail(sessionId: string): Promise<SessionDetail>;

  /**
   * Send a user message to a session; starts a new turn.
   *
   * Throws `SessionBusyError` if the session already has an in-flight
   * turn. Callers should interrupt the active turn first (or wait for
   * `turn_completed`) before sending another message. ACP does not
   * support parallel turns within one session.
   */
  sendMessage(sessionId: string, content: string): Promise<void>;

  /** Cancel the currently streaming turn, if any. */
  interruptSession(sessionId: string): Promise<void>;

  /** Load a dormant session back into memory. */
  resumeSession(sessionId: string): Promise<void>;

  /**
   * Forget a session owned by this adapter. For adapters with in-memory
   * tracking (Claude Code) this removes the session from the local map.
   * For adapters backed by a persistent agent (Codex) this is typically
   * a no-op — throw `SessionDeleteUnsupportedError` so the API layer can
   * surface HTTP 501 instead of silently lying about success.
   *
   * If omitted on an adapter, `SessionManager.deleteSession` will throw
   * `SessionDeleteUnsupportedError`.
   */
  deleteSession?(sessionId: string): Promise<void>;

  /** Subscribe to real-time session events. Returns an unsubscribe function. */
  onSessionEvent(handler: (event: SessionEvent) => void): () => void;

  /** Release all resources (subprocesses, connections, listeners). */
  shutdown(): Promise<void>;
}

/**
 * Thrown by `sendMessage` when the target session already has an
 * in-flight turn. The HTTP layer translates this to 409 Conflict so the
 * client can interrupt the active turn before retrying.
 */
export class SessionBusyError extends Error {
  readonly code = "SESSION_BUSY";
  readonly sessionId: string;
  readonly activeTurnId: string;

  constructor(sessionId: string, activeTurnId: string) {
    super(
      `Session ${sessionId} has an active turn (${activeTurnId}). ` +
        `Interrupt the active turn before sending a new message.`,
    );
    this.name = "SessionBusyError";
    this.sessionId = sessionId;
    this.activeTurnId = activeTurnId;
  }
}

/**
 * Thrown by `deleteSession` on adapters whose underlying agent persists
 * sessions itself (e.g. Codex). The HTTP layer translates this to 501
 * Not Implemented so clients don't mistakenly believe the session was
 * removed.
 */
export class SessionDeleteUnsupportedError extends Error {
  readonly code = "DELETE_NOT_SUPPORTED";
  readonly sessionId: string;
  readonly provider: string;

  constructor(sessionId: string, provider: string) {
    super(
      `Provider "${provider}" does not support deleting sessions. ` +
        `Session ${sessionId} remains in the agent's history.`,
    );
    this.name = "SessionDeleteUnsupportedError";
    this.sessionId = sessionId;
    this.provider = provider;
  }
}

/**
 * Thrown when a session operation is called on a provider that doesn't
 * support it — most commonly, `createSession` on a provider (like Codex)
 * whose agent creates sessions implicitly.
 *
 * The HTTP layer maps this to 400 Bad Request with code
 * `PROVIDER_CAPABILITY_MISSING` so callers get a clear, actionable error
 * instead of a generic 500.
 */
export class ProviderCapabilityError extends Error {
  readonly code = "PROVIDER_CAPABILITY_MISSING";
  readonly provider: string;
  readonly capability: string;

  constructor(provider: string, capability: string) {
    super(`Provider "${provider}" does not support capability "${capability}".`);
    this.name = "ProviderCapabilityError";
    this.provider = provider;
    this.capability = capability;
  }
}

/**
 * Thrown when the requested provider name isn't registered on the
 * SessionManager. HTTP layer maps to 400 Bad Request.
 */
export class UnknownProviderError extends Error {
  readonly code = "UNKNOWN_PROVIDER";
  readonly provider: string;
  readonly available: readonly string[];

  constructor(provider: string, available: readonly string[]) {
    super(
      `Unknown provider "${provider}". Available: ${
        available.length > 0 ? available.join(", ") : "(none)"
      }.`,
    );
    this.name = "UnknownProviderError";
    this.provider = provider;
    this.available = available;
  }
}

export interface DiscoveredSession {
  sourceId: string;
  provider: string;
  status: SessionStatus;
  title: string | null;
  workingDirectory: string;
  gitBranch: string | null;
  gitHeadCommit: string | null;
  gitRemoteUrl: string | null;
  totalTurns: number;
  startedAt: string | null;
  updatedAt: string;
}

export interface SessionDetail {
  turns: SessionTurnData[];
  toolCalls: SessionToolCallData[];
}

export interface SessionTurnData {
  id: string;
  turnIndex: number;
  role: "user" | "assistant";
  content: ContentBlock[];
  modelId: string | null;
  durationMs: number | null;
  stopReason: string | null;
  status: "streaming" | "completed" | "error" | "cancelled";
  errorMessage: string | null;
  createdAt: string;
}

export interface SessionToolCallData {
  id: string;
  turnId: string | null;
  toolName: string;
  toolKind: "terminal" | "file_edit" | "mcp" | "other";
  status: "pending" | "in_progress" | "completed" | "error";
  arguments: unknown;
  result: unknown;
  durationMs: number | null;
  createdAt: string;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "diff"; path: string; oldText?: string; newText: string }
  | {
      type: "terminal";
      command: string;
      output: string;
      exitCode: number | null;
      durationMs: number | null;
    };

export type SessionStatus = "idle" | "streaming" | "waiting" | "completed" | "error";

export type SessionEvent =
  | { type: "turn_started"; sessionId: string; turnId: string }
  | { type: "message_delta"; sessionId: string; turnId: string; text: string }
  | { type: "tool_call_started"; sessionId: string; toolCall: SessionToolCallData }
  | { type: "tool_call_completed"; sessionId: string; toolCall: SessionToolCallData }
  | { type: "turn_completed"; sessionId: string; turnId: string; status: string }
  | { type: "session_status_changed"; sessionId: string; status: SessionStatus };
