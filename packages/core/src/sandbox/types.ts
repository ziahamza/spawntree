import { Schema } from "effect";
import type { Readable, Writable } from "node:stream";

/**
 * Sandbox provider contracts for the spawntree daemon.
 *
 * Sessions normally run as naked host processes. A *sandbox* runs the agent
 * subprocess inside a container/VM instead, behind a pluggable provider
 * (Docker, Apple `container`, …). The abstraction is split along the same
 * lines as the storage layer: dependency-pure interfaces + a map registry
 * live here in `core`; the concrete provider implementations (which pull in
 * `dockerode` / shell the `container` CLI) live in the daemon.
 *
 * This file holds the process-spawning seam (`ProcessSpawner`). The provider /
 * handle / sandbox record contracts are appended below by the sandbox
 * abstraction work.
 */

// ─── Process spawning seam ────────────────────────────────────────────────

/**
 * The structural subset of a child process that the ACP / JSON-RPC transports
 * actually consume. A Node `ChildProcess` satisfies this directly (the stdio
 * fields are intentionally nullable to match it); a sandbox spawner returns an
 * adapter that bridges to a process running *inside* a container.
 */
export interface SpawnedProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  /** Exit code once the process has exited, else null (matches ChildProcess.exitCode). */
  readonly exitCode: number | null;
  /** Send a termination signal. Mirrors ChildProcess.kill. */
  kill(signal?: NodeJS.Signals | number): boolean;
  /** Subscribe to process exit. Only "exit" is required by current consumers. */
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface SpawnOptions {
  /** Env overlaid on the spawner's base environment. */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the spawned process. */
  cwd?: string;
}

/**
 * Abstracts *where* an agent subprocess is spawned. The default `HostSpawner`
 * runs it on the daemon host, inheriting `process.env` (today's behavior). A
 * sandbox provider returns a spawner that runs the command inside its
 * container/VM (e.g. `docker exec -i` / `container exec -i`), so the entire
 * ACP / JSON-RPC layer above works unchanged.
 */
export interface ProcessSpawner {
  /** Stable id, for diagnostics ("host", "docker:sbx_…", "apple-container:sbx_…"). */
  readonly id: string;
  spawn(
    command: string,
    args: readonly string[],
    opts?: SpawnOptions,
  ): Promise<SpawnedProcess> | SpawnedProcess;
}

// ─── Sandbox lifecycle status ─────────────────────────────────────────────

/**
 * Lifecycle of a sandbox as the daemon sees it. Distinct from a *session*
 * status — a single sandbox may host zero or many sessions.
 */
export const SandboxStatus = Schema.Literals([
  "creating", // runtime container being created/started
  "running", // up and ready to exec agents into
  "stopped", // intentionally stopped (restartable)
  "exited", // the runtime container exited on its own
  "error", // create/start failed
  "removing", // being torn down
]);
export type SandboxStatus = Schema.Schema.Type<typeof SandboxStatus>;

export interface SandboxRuntimeStatus {
  readonly status: SandboxStatus;
  readonly healthy: boolean;
  readonly error?: string;
  readonly info?: Record<string, unknown>;
}

// ─── What a caller asks for when creating a sandbox ───────────────────────

export type WorkspaceMode = "mount" | "clone";

/**
 * How the repo gets into the sandbox.
 *
 * - `mount`: bind-mount a host worktree into the container at the SAME
 *   absolute path. Load-bearing: cwd, host-side git detection, and the
 *   default ACP client's `node:fs` handlers all line up with no path
 *   translation. The manager rejects a mount whose host path ≠ container path.
 * - `clone`: clone the repo fresh inside the container (full isolation; no
 *   host worktree). The connection runs with `enableFs:false`.
 */
export type WorkspaceSpec =
  | { readonly mode: "mount"; readonly worktreePath: string }
  | {
      readonly mode: "clone";
      readonly repoUrl: string;
      readonly ref: string;
      readonly containerPath: string;
    };

export interface BindMount {
  readonly host: string;
  readonly container: string;
  readonly mode?: "rw" | "ro";
}

export interface SandboxSpec {
  readonly workspace: WorkspaceSpec;
  /** Image override; falls back to provider/config default. */
  readonly image?: string;
  /**
   * Env injected into the container (credentials, git identity). The sandbox
   * spawner does NOT inherit the daemon's `process.env`, so anything the agent
   * needs (ANTHROPIC_API_KEY, GH token, GIT_AUTHOR_*) must be set here.
   */
  readonly env?: Record<string, string>;
  /** Extra bind mounts beyond the workspace (caches, etc.). */
  readonly extraMounts?: readonly BindMount[];
  readonly resources?: { readonly cpus?: number; readonly memoryMb?: number };
  /** Provider-specific labels merged with the spawntree.* defaults. */
  readonly labels?: Record<string, string>;
  /** Ephemeral sandboxes are torn down when their owning session ends. */
  readonly ephemeral?: boolean;
  /** Soft link to a spawntree repo, for catalog + cleanup. No FK. */
  readonly repoId?: string;
}

/** A live, persisted sandbox record. */
export interface Sandbox {
  readonly id: string; // spawntree id "sbx_…", or the runtime container id for adopted/external containers
  readonly providerId: string; // "docker" | "apple-container"
  readonly runtimeId: string; // container id assigned by the runtime
  /** Human container name (e.g. "spawntree-sbx_…" or an external container's name). */
  readonly name: string | null;
  /** True when spawntree created this sandbox (vs. an external container we adopted for management). */
  readonly managed: boolean;
  readonly status: SandboxStatus;
  readonly image: string;
  readonly workspaceMode: WorkspaceMode;
  readonly mounts: readonly BindMount[];
  readonly labels: Record<string, string>;
  readonly ephemeral: boolean;
  readonly repoId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ─── Shared context passed to every provider ──────────────────────────────

export interface SandboxContext {
  /** Absolute path to the spawntree data directory (e.g. ~/.spawntree). */
  readonly dataDir: string;
  /** Structured log emitter. Providers should use this, not console.*. */
  readonly logger: (
    level: "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
}

// ─── Provider + handle contracts ──────────────────────────────────────────

/**
 * A live, provider-owned sandbox. Owns lifecycle and is the thing that hands
 * back a `ProcessSpawner` bound to its container. Mirrors
 * `PrimaryStorageHandle`.
 */
export interface SandboxHandle {
  /** Current snapshot of the sandbox record. */
  readonly sandbox: Sandbox;
  status(): Promise<SandboxRuntimeStatus>;
  /** A ProcessSpawner that runs commands INSIDE this sandbox. */
  spawner(): ProcessSpawner;
  /** Follow combined logs. Returns an unsubscribe fn. */
  logs(onLine: (stream: "stdout" | "stderr" | "system", line: string) => void): () => void;
  restart(): Promise<void>;
  stop(): Promise<void>;
  /** Stop (if needed) and delete the runtime container. */
  remove(): Promise<void>;
}

/**
 * A pluggable sandbox backend. Built-ins (Docker, Apple `container`) register
 * themselves with a `SandboxRegistry`; the daemon-side `SandboxManager`
 * instantiates and tracks them from persisted config. Mirrors
 * `PrimaryStorageProvider`.
 */
export interface SandboxProvider<Config = unknown> {
  readonly id: string; // "docker" | "apple-container"
  readonly kind: "sandbox";
  /** Effect Schema describing valid config; validated before create()/adopt(). */
  readonly configSchema?: Schema.Top;
  /** Cheap, side-effect-free probe: is this runtime usable on this host? */
  isAvailable(): Promise<boolean>;
  /**
   * Create + start a sandbox. `id` is the spawntree-assigned id (generated by
   * the manager); the provider stamps it on the runtime container as a label
   * so `adopt`/`list` can recover it after a restart.
   */
  create(
    id: string,
    spec: SandboxSpec,
    config: Config,
    ctx: SandboxContext,
  ): Promise<SandboxHandle>;
  /** Re-attach to an already-running runtime container after a daemon restart. */
  adopt(runtimeId: string, config: Config, ctx: SandboxContext): Promise<SandboxHandle | null>;
  /** Enumerate runtime containers this provider manages (by spawntree.* labels). */
  list(config: Config, ctx: SandboxContext): Promise<Sandbox[]>;
}

// ─── Persisted config shape (`<dataDir>/sandboxes.json`) ──────────────────

export const SandboxProviderEntry = Schema.Struct({
  id: Schema.String, // provider id ("docker" | "apple-container")
  enabled: Schema.Boolean,
  config: Schema.Unknown, // provider-specific; validated by provider.configSchema
});
export type SandboxProviderEntry = Schema.Schema.Type<typeof SandboxProviderEntry>;

export const SandboxConfig = Schema.Struct({
  /** Provider used when a session requests a sandbox without naming one. */
  defaultProvider: Schema.optional(Schema.String),
  providers: Schema.Array(SandboxProviderEntry),
});
export type SandboxConfig = Schema.Schema.Type<typeof SandboxConfig>;

/** Both built-ins enabled; `availableProviders()` filters by `isAvailable()`. */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  providers: [
    { id: "docker", enabled: true, config: {} },
    { id: "apple-container", enabled: true, config: {} },
  ],
};
