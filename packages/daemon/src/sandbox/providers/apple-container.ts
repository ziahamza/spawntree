import { Schema } from "effect";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type {
  ProcessSpawner,
  Sandbox,
  SandboxContext,
  SandboxHandle,
  SandboxProvider,
  SandboxRuntimeStatus,
  SandboxSpec,
  SandboxStatus,
} from "spawntree-core";
import {
  buildSandboxLabels,
  containerNameFor,
  DEFAULT_SANDBOX_IMAGE,
  errMessage,
  nowIso,
  resolveWorkspaceMounts,
} from "../constants.ts";
import { AppleContainerExecSpawner } from "../exec-spawner.ts";

const execFileP = promisify(execFile);

export const AppleContainerSandboxConfig = Schema.Struct({
  defaultImage: Schema.optional(Schema.String),
  /** Path to the `container` binary. Defaults to `container` on PATH. */
  binaryPath: Schema.optional(Schema.String),
});
export type AppleContainerSandboxConfig = Schema.Schema.Type<typeof AppleContainerSandboxConfig>;

const NAME_PREFIX = "spawntree-";

/** Recover the spawntree sandbox id from a runtime container name. */
function idFromName(name: string): string | null {
  return name.startsWith(NAME_PREFIX) ? name.slice(NAME_PREFIX.length) : null;
}

function parseStatus(raw: string): SandboxStatus {
  // Apple `container inspect`/`ls --format json` shape is not contractually
  // stable yet; scan for a recognizable status token and default to running
  // (a successful inspect means the container exists and we keep it up).
  const lower = raw.toLowerCase();
  if (/"status"\s*:\s*"running"|"state"\s*:\s*"running"/.test(lower)) return "running";
  if (/stopped/.test(lower)) return "stopped";
  if (/exited|dead/.test(lower)) return "exited";
  return "running";
}

class AppleSandboxHandle implements SandboxHandle {
  private readonly binary: string;
  private readonly name: string;
  sandbox: Sandbox;

  constructor(binary: string, name: string, sandbox: Sandbox) {
    this.binary = binary;
    this.name = name;
    this.sandbox = sandbox;
  }

  async status(): Promise<SandboxRuntimeStatus> {
    try {
      const { stdout } = await execFileP(this.binary, ["inspect", this.name]);
      const status = parseStatus(stdout);
      this.sandbox = { ...this.sandbox, status, updatedAt: nowIso() };
      return { status, healthy: status === "running" };
    } catch (err) {
      return { status: "exited", healthy: false, error: errMessage(err) };
    }
  }

  spawner(): ProcessSpawner {
    return new AppleContainerExecSpawner(this.name, this.binary, this.sandbox.id);
  }

  logs(onLine: (stream: "stdout" | "stderr" | "system", line: string) => void): () => void {
    const proc = spawn(this.binary, ["logs", "-f", this.name], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const reader = (chunk: Buffer, stream: "stdout" | "stderr") => {
      for (const line of chunk.toString().split("\n")) {
        if (line) onLine(stream, line);
      }
    };
    proc.stdout?.on("data", (c: Buffer) => reader(c, "stdout"));
    proc.stderr?.on("data", (c: Buffer) => reader(c, "stderr"));
    proc.on("error", (err) => onLine("system", `log stream error: ${errMessage(err)}`));
    return () => {
      proc.kill();
    };
  }

  async restart(): Promise<void> {
    try {
      await execFileP(this.binary, ["restart", this.name]);
    } catch {
      // Fallback for runtimes without `restart`: stop then start.
      await execFileP(this.binary, ["stop", this.name]).catch(() => {});
      await execFileP(this.binary, ["start", this.name]);
    }
  }

  async stop(): Promise<void> {
    await execFileP(this.binary, ["stop", this.name]).catch((err) => {
      const msg = errMessage(err);
      if (!msg.includes("not running") && !msg.includes("not found")) throw err;
    });
  }

  async remove(): Promise<void> {
    await this.stop();
    await execFileP(this.binary, ["rm", "-f", this.name]).catch((err) => {
      if (!errMessage(err).includes("not found")) throw err;
    });
  }
}

export const appleContainerSandboxProvider: SandboxProvider<AppleContainerSandboxConfig> = {
  id: "apple-container",
  kind: "sandbox",
  configSchema: AppleContainerSandboxConfig,

  async isAvailable(): Promise<boolean> {
    // Apple `container` runs Linux containers in lightweight VMs, Apple-silicon
    // macOS 26+ only. Gate on platform/arch, then probe the binary.
    if (process.platform !== "darwin" || process.arch !== "arm64") return false;
    try {
      await execFileP("container", ["--version"]);
      return true;
    } catch {
      return false;
    }
  },

  async create(
    id: string,
    spec: SandboxSpec,
    config: AppleContainerSandboxConfig,
    ctx: SandboxContext,
  ): Promise<SandboxHandle> {
    const binary = config.binaryPath ?? "container";
    const image = spec.image ?? config.defaultImage ?? DEFAULT_SANDBOX_IMAGE;
    const name = containerNameFor(id);
    const mounts = resolveWorkspaceMounts(spec);
    const labels = buildSandboxLabels(id, spec);

    const args = ["run", "-d", "--name", name];
    for (const m of mounts) {
      args.push("-v", `${m.host}:${m.container}${m.mode === "ro" ? ":ro" : ""}`);
    }
    for (const [k, v] of Object.entries(spec.env ?? {})) args.push("-e", `${k}=${v}`);
    for (const [k, v] of Object.entries(labels)) args.push("--label", `${k}=${v}`);
    args.push(image, "sleep", "infinity");

    await execFileP(binary, args);

    const sandbox: Sandbox = {
      id,
      providerId: "apple-container",
      runtimeId: name, // CLI runtime targets by name; stable + derivable from id
      name,
      managed: true,
      status: "running",
      image,
      workspaceMode: spec.workspace.mode,
      mounts,
      labels,
      ephemeral: spec.ephemeral ?? false,
      repoId: spec.repoId ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    ctx.logger("info", `created apple-container sandbox ${id}`, { name, image });
    return new AppleSandboxHandle(binary, name, sandbox);
  },

  async adopt(
    runtimeId: string,
    config: AppleContainerSandboxConfig,
    _ctx: SandboxContext,
  ): Promise<SandboxHandle | null> {
    const binary = config.binaryPath ?? "container";
    const id = idFromName(runtimeId);
    if (!id) return null;
    try {
      const { stdout } = await execFileP(binary, ["inspect", runtimeId]);
      const sandbox: Sandbox = {
        id,
        providerId: "apple-container",
        runtimeId,
        name: runtimeId,
        managed: true,
        status: parseStatus(stdout),
        image: "",
        workspaceMode: "mount",
        mounts: [],
        labels: {},
        ephemeral: false,
        repoId: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      return new AppleSandboxHandle(binary, runtimeId, sandbox);
    } catch {
      return null;
    }
  },

  async list(config: AppleContainerSandboxConfig, ctx: SandboxContext): Promise<Sandbox[]> {
    const binary = config.binaryPath ?? "container";
    let parsed: unknown;
    try {
      const { stdout } = await execFileP(binary, ["list", "--all", "--format", "json"]);
      parsed = JSON.parse(stdout);
    } catch (err) {
      ctx.logger("warn", `apple-container list failed: ${errMessage(err)}`);
      return [];
    }
    const rows = Array.isArray(parsed) ? parsed : [];
    const out: Sandbox[] = [];
    for (const row of rows) {
      // Names live under different keys across versions; check the common ones.
      const r = row as Record<string, unknown>;
      const name =
        (typeof r.name === "string" && r.name) ||
        (typeof r.Name === "string" && r.Name) ||
        ((r.configuration as { id?: string } | undefined)?.id ?? "");
      const id = typeof name === "string" ? idFromName(name) : null;
      if (!id || typeof name !== "string") continue;
      out.push({
        id,
        providerId: "apple-container",
        runtimeId: name,
        name,
        managed: true,
        status: parseStatus(JSON.stringify(row)),
        image: "",
        workspaceMode: "mount",
        mounts: [],
        labels: {},
        ephemeral: false,
        repoId: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
    return out;
  },
};
