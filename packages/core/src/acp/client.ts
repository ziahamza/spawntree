import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import type {
  ReadableStream as NodeReadableStream,
  WritableStream as NodeWritableStream,
} from "node:stream/web";
import * as acp from "@zed-industries/agent-client-protocol";

/**
 * Zed Agent Client Protocol connection.
 *
 * Spawns an ACP-speaking subprocess (e.g. @zed-industries/claude-code-acp)
 * and wraps its stdin/stdout into a ClientSideConnection. Consumers can
 * send prompts, cancel sessions, and subscribe to session/update
 * notifications through a Node-friendly API.
 *
 * For agents that do NOT speak ACP natively (e.g. Codex), use a facade
 * adapter (see adapters/codex.ts) instead.
 */
export interface ACPConnectionOptions {
  /** Executable to spawn (typically "npx" or the agent binary itself). */
  command: string;
  /** Arguments passed to the executable. */
  args?: readonly string[];
  /** Extra env vars merged over process.env. */
  env?: NodeJS.ProcessEnv;
  /** Label used to prefix stderr log lines; defaults to the command name. */
  label?: string;
  /** Custom Client impl factory; otherwise a permissive default is used. */
  client?: (agent: acp.Agent, dispatch: SessionUpdateDispatch) => acp.Client;
  /** Stderr line handler; defaults to console.error with label prefix. */
  onStderr?: (line: string) => void;
  /** Default client options; ignored if `client` is provided. */
  defaultClient?: DefaultClientOptions;
}

export interface DefaultClientOptions {
  /**
   * How to respond to permission requests. Defaults to "allow_once" —
   * appropriate for spawntree's model where the user has explicitly
   * launched the agent on their own machine. For remote or multi-tenant
   * scenarios, override with a custom `client` that prompts the user.
   *
   * Ignored when `permissionHandler` is set.
   */
  permissionPolicy?: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  /**
   * Async handler invoked on every `request_permission` RPC. When provided,
   * it fully owns the response and `permissionPolicy` is ignored. Use this
   * to surface a real prompt to the user (e.g. via the daemon's SessionManager
   * pendingApprovals map) and resolve the promise once the user decides.
   *
   * Returning `{ outcome: "cancelled" }` aborts the tool call on the agent
   * side; returning `{ outcome: "selected", optionId }` with one of the
   * `allow_*` options proceeds, with `reject_*` denies.
   */
  permissionHandler?: (
    params: acp.RequestPermissionRequest,
  ) => Promise<acp.RequestPermissionResponse>;
  /** If true, fs/read_text_file and fs/write_text_file are served via node:fs. Default true. */
  enableFs?: boolean;
}

export type SessionUpdateDispatch = (notification: acp.SessionNotification) => void;

export class ACPConnection {
  private readonly options: ACPConnectionOptions;
  private readonly sessionUpdateHandlers = new Set<SessionUpdateDispatch>();
  private proc: ChildProcess | null = null;
  private conn: acp.ClientSideConnection | null = null;

  constructor(options: ACPConnectionOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.isAlive) return;

    const label = this.options.label ?? this.options.command;
    this.proc = spawn(this.options.command, (this.options.args ?? []) as string[], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.options.env },
    });

    if (!this.proc.stdout || !this.proc.stdin) {
      throw new Error(`Failed to spawn ${this.options.command}`);
    }

    this.proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (!text) return;
      if (this.options.onStderr) {
        this.options.onStderr(text);
      } else {
        console.error(`[${label} stderr] ${text}`);
      }
    });

    // Web Streams adapted from Node streams (node:stream/web interop).
    const output = Writable.toWeb(this.proc.stdin) as NodeWritableStream<Uint8Array>;
    const input = Readable.toWeb(this.proc.stdout) as NodeReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(
      output as unknown as WritableStream<Uint8Array>,
      input as unknown as ReadableStream<Uint8Array>,
    );

    const dispatch: SessionUpdateDispatch = (notification) => {
      for (const handler of this.sessionUpdateHandlers) {
        handler(notification);
      }
    };

    const clientFactory: (agent: acp.Agent) => acp.Client = this.options.client
      ? (agent) => this.options.client!(agent, dispatch)
      : () => defaultClientImpl(dispatch, this.options.defaultClient ?? {});

    this.conn = new acp.ClientSideConnection(clientFactory, stream);
  }

  get isAlive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && this.conn !== null;
  }

  private requireConn(): acp.ClientSideConnection {
    if (!this.conn) throw new Error("ACPConnection not started");
    return this.conn;
  }

  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return this.requireConn().initialize(params);
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    return this.requireConn().newSession(params);
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    return this.requireConn().loadSession(params);
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    return this.requireConn().prompt(params);
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    await this.requireConn().cancel(params);
  }

  async authenticate(params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return this.requireConn().authenticate(params);
  }

  /** Subscribe to session/update notifications. Returns an unsubscribe function. */
  onSessionUpdate(handler: SessionUpdateDispatch): () => void {
    this.sessionUpdateHandlers.add(handler);
    return () => {
      this.sessionUpdateHandlers.delete(handler);
    };
  }

  async shutdown(): Promise<void> {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.conn = null;
    this.sessionUpdateHandlers.clear();
  }
}

/**
 * Default Client implementation. Handles session/update, auto-responds to
 * permission requests per `permissionPolicy`, and serves fs/read_text_file
 * and fs/write_text_file via node:fs.
 *
 * Exported so callers can inspect or test the permission policy
 * behavior in isolation without spawning a real ACP subprocess.
 */
export function buildDefaultClient(
  dispatch: SessionUpdateDispatch,
  options: DefaultClientOptions = {},
): acp.Client {
  return defaultClientImpl(dispatch, options);
}

function defaultClientImpl(
  dispatch: SessionUpdateDispatch,
  options: DefaultClientOptions,
): acp.Client {
  const policy = options.permissionPolicy ?? "allow_once";
  const enableFs = options.enableFs ?? true;
  const handler = options.permissionHandler;

  const client: acp.Client = {
    sessionUpdate: async (params) => {
      dispatch(params);
    },

    requestPermission: async (params) => {
      // Custom async handler wins — it can suspend on user input.
      if (handler) return handler(params);

      // Exact policy match — always honor if the agent offered it.
      const match = params.options.find((o) => o.kind === policy);
      if (match) {
        return { outcome: { outcome: "selected", optionId: match.optionId } };
      }

      // No exact match. Fail CLOSED when the user asked to reject: if the
      // agent doesn't offer our preferred reject option, picking `options[0]`
      // would silently flip a "reject" policy into an "allow" — a silent
      // security regression. Instead, prefer any other reject-kind option
      // and fall through to cancel if none exist.
      if (policy.startsWith("reject_")) {
        const anyReject = params.options.find(
          (o) => typeof o.kind === "string" && o.kind.startsWith("reject_"),
        );
        if (anyReject) {
          return { outcome: { outcome: "selected", optionId: anyReject.optionId } };
        }
        return { outcome: { outcome: "cancelled" } };
      }

      // Allow-kind policy with no exact match — prefer any other allow option
      // before falling back to the first option offered.
      const anyAllow = params.options.find(
        (o) => typeof o.kind === "string" && o.kind.startsWith("allow_"),
      );
      const chosen = anyAllow ?? params.options[0];
      if (!chosen) {
        return { outcome: { outcome: "cancelled" } };
      }
      return {
        outcome: { outcome: "selected", optionId: chosen.optionId },
      };
    },
  };

  if (enableFs) {
    client.readTextFile = async (params) => {
      const content = await readFile(params.path, "utf8");
      return { content };
    };
    client.writeTextFile = async (params) => {
      await writeFile(params.path, params.content, "utf8");
      return {};
    };
  }

  return client;
}
