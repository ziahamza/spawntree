import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

/**
 * JSON-RPC 2.0 transport over stdio. Used by adapters that wrap agents
 * which speak their own JSON-RPC dialect (e.g. Codex app-server), not
 * the Agent Client Protocol. For ACP agents, use ClientSideConnection
 * from @zed-industries/agent-client-protocol directly.
 */
export interface JsonRpcTransportOptions {
  /** Label used to prefix stderr log lines. Defaults to the command name. */
  label?: string;
  /** Extra env vars merged on top of process.env. */
  env?: NodeJS.ProcessEnv;
  /** Callback for raw stderr lines; if omitted, lines are logged to console.error. */
  onStderr?: (line: string) => void;
}

export class JsonRpcTransport extends EventEmitter {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly label: string;
  private readonly extraEnv: NodeJS.ProcessEnv | undefined;
  private readonly onStderr: ((line: string) => void) | undefined;

  private proc: ChildProcess | null = null;
  private requestId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private initialized = false;

  constructor(
    command: string,
    args: readonly string[] = [],
    options: JsonRpcTransportOptions = {},
  ) {
    super();
    this.command = command;
    this.args = args;
    this.label = options.label ?? command;
    this.extraEnv = options.env;
    this.onStderr = options.onStderr;
  }

  async start(): Promise<void> {
    this.proc = spawn(this.command, this.args as string[], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.extraEnv },
    });

    if (!this.proc.stdout || !this.proc.stdin) {
      throw new Error(`Failed to spawn ${this.command}`);
    }

    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        // Non-JSON lines (startup banners, etc.) — ignored.
      }
    });

    this.proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (!text) return;
      if (this.onStderr) {
        this.onStderr(text);
      } else if (!text.includes("WARN") && !text.includes("DEBUG")) {
        console.error(`[${this.label} stderr] ${text}`);
      }
    });

    this.proc.on("exit", (code) => {
      this.emit("exit", code);
      for (const [, { reject }] of this.pending) {
        reject(new Error(`${this.label} exited with code ${code}`));
      }
      this.pending.clear();
    });
  }

  private handleMessage(msg: {
    id?: number;
    method?: string;
    result?: unknown;
    error?: unknown;
    params?: unknown;
  }): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (msg.method) {
      this.emit("notification", msg.method, msg.params);
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("Transport not started");
    }

    const id = ++this.requestId;
    // The `jsonrpc: "2.0"` field is required by the JSON-RPC 2.0 spec.
    // Codex's app-server happens to be permissive today, but strict
    // servers (and future Codex versions) would reject messages without
    // it. Always send it.
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      stdin.write(msg + "\n");
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.proc?.stdin) {
      throw new Error("Transport not started");
    }
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} });
    this.proc.stdin.write(msg + "\n");
  }

  /**
   * MCP-style handshake: sends `initialize` request, awaits result, then
   * sends the `initialized` notification. Idempotent within one transport.
   */
  async initialize(clientInfo: { name: string; version: string }): Promise<unknown> {
    if (this.initialized) {
      throw new Error("Already initialized");
    }
    // Set the flag before awaiting to guard against concurrent callers.
    this.initialized = true;
    try {
      const result = await this.request("initialize", {
        clientInfo,
        capabilities: { experimentalApi: true },
      });
      await this.notify("initialized");
      return result;
    } catch (err) {
      this.initialized = false;
      throw err;
    }
  }

  get isAlive(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  async shutdown(): Promise<void> {
    // Reject all pending requests before clearing — otherwise their promises hang forever.
    for (const [, { reject }] of this.pending) {
      reject(new Error(`${this.label} shut down`));
    }
    this.pending.clear();
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.initialized = false;
  }
}
