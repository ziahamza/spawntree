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

  /** Send a user message to a session; starts a new turn. */
  sendMessage(sessionId: string, content: string): Promise<void>;

  /** Cancel the currently streaming turn, if any. */
  interruptSession(sessionId: string): Promise<void>;

  /** Load a dormant session back into memory. */
  resumeSession(sessionId: string): Promise<void>;

  /** Subscribe to real-time session events. Returns an unsubscribe function. */
  onSessionEvent(handler: (event: SessionEvent) => void): () => void;

  /** Release all resources (subprocesses, connections, listeners). */
  shutdown(): Promise<void>;
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
