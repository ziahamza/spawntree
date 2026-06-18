import { Schema } from "effect";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import Dockerode from "dockerode";
import type {
  BindMount,
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
  LABEL_EPHEMERAL,
  LABEL_REPO_ID,
  LABEL_SANDBOX_ID,
  LABEL_WORKSPACE_MODE,
  nowIso,
  resolveWorkspaceMounts,
} from "../constants.ts";
import { DockerExecSpawner } from "../exec-spawner.ts";

export const DockerSandboxConfig = Schema.Struct({
  /** Image used when a sandbox spec doesn't name one. */
  defaultImage: Schema.optional(Schema.String),
  /** Override the Docker socket (e.g. OrbStack/Colima). Defaults to dockerode's resolution. */
  socketPath: Schema.optional(Schema.String),
});
export type DockerSandboxConfig = Schema.Schema.Type<typeof DockerSandboxConfig>;

/**
 * Resolve the Docker socket. dockerode's default only checks
 * `/var/run/docker.sock`, which most Mac setups (OrbStack, Docker Desktop,
 * Colima, Rancher) do NOT use — they put the socket under $HOME and rely on a
 * docker *context* the CLI reads but dockerode doesn't. So: honor an explicit
 * override, then `DOCKER_HOST`, then probe the well-known per-tool paths.
 */
function resolveDockerSocket(config: DockerSandboxConfig): string | undefined {
  if (config.socketPath) return config.socketPath;
  if (process.env.DOCKER_HOST) return undefined; // dockerode reads DOCKER_HOST itself
  const home = homedir();
  const candidates = [
    "/var/run/docker.sock",
    join(home, ".docker/run/docker.sock"), // Docker Desktop (macOS)
    join(home, ".orbstack/run/docker.sock"), // OrbStack
    join(home, ".colima/default/docker.sock"), // Colima
    join(home, ".rd/docker.sock"), // Rancher Desktop
  ];
  return candidates.find((p) => existsSync(p));
}

function dockerFor(config: DockerSandboxConfig): Dockerode {
  const socketPath = resolveDockerSocket(config);
  return socketPath ? new Dockerode({ socketPath }) : new Dockerode();
}

function toEnvArray(env: Record<string, string> | undefined): string[] {
  return Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`);
}

function mountsToBinds(mounts: readonly BindMount[]): string[] {
  return mounts.map((m) => `${m.host}:${m.container}:${m.mode ?? "rw"}`);
}

function bindsToMounts(binds: string[] | undefined): BindMount[] {
  return (binds ?? []).map((b) => {
    const [host, container, mode] = b.split(":");
    return { host: host ?? "", container: container ?? "", mode: mode === "ro" ? "ro" : "rw" };
  });
}

function mapDockerState(info: Dockerode.ContainerInspectInfo): SandboxStatus {
  const state = info.State;
  switch (state?.Status) {
    case "running":
    case "restarting":
      return "running";
    case "created":
      return "creating";
    case "paused":
      return "stopped";
    case "removing":
      return "removing";
    case "exited":
    case "dead":
      return state.ExitCode === 0 ? "stopped" : "exited";
    default:
      return state?.Running ? "running" : "exited";
  }
}

/** Map a Docker summary state string ("running"|"exited"|"created"|…) to SandboxStatus. */
function mapDockerStateString(state: string | undefined): SandboxStatus {
  switch (state) {
    case "running":
    case "restarting":
      return "running";
    case "created":
      return "creating";
    case "paused":
      return "stopped";
    case "removing":
      return "removing";
    case "exited":
    case "dead":
      return "exited";
    default:
      return "exited";
  }
}

// A sandbox id is the spawntree label when we created it, else the raw
// container id (so external containers are addressable for management too).
function sandboxFromInspect(info: Dockerode.ContainerInspectInfo): Sandbox {
  const labels = info.Config?.Labels ?? {};
  const managedId = labels[LABEL_SANDBOX_ID];
  return {
    id: managedId ?? info.Id,
    providerId: "docker",
    runtimeId: info.Id,
    name: info.Name ? info.Name.replace(/^\//, "") : null,
    managed: Boolean(managedId),
    status: mapDockerState(info),
    image: info.Config?.Image ?? "",
    workspaceMode: labels[LABEL_WORKSPACE_MODE] === "clone" ? "clone" : "mount",
    mounts: bindsToMounts(info.HostConfig?.Binds ?? undefined),
    labels,
    ephemeral: labels[LABEL_EPHEMERAL] === "true",
    repoId: labels[LABEL_REPO_ID] ?? null,
    createdAt: info.Created ?? nowIso(),
    updatedAt: nowIso(),
  };
}

// Build a Sandbox from a `listContainers` summary (no per-container inspect —
// fast even with many containers). Binds aren't in the summary; detail views
// re-inspect via the handle's status().
function sandboxFromListInfo(c: Dockerode.ContainerInfo): Sandbox {
  const labels = c.Labels ?? {};
  const managedId = labels[LABEL_SANDBOX_ID];
  const name = c.Names && c.Names.length > 0 ? c.Names[0]!.replace(/^\//, "") : null;
  return {
    id: managedId ?? c.Id,
    providerId: "docker",
    runtimeId: c.Id,
    name,
    managed: Boolean(managedId),
    status: mapDockerStateString(c.State),
    image: c.Image ?? "",
    workspaceMode: labels[LABEL_WORKSPACE_MODE] === "clone" ? "clone" : "mount",
    mounts: [],
    labels,
    ephemeral: labels[LABEL_EPHEMERAL] === "true",
    repoId: labels[LABEL_REPO_ID] ?? null,
    createdAt: c.Created ? new Date(c.Created * 1000).toISOString() : nowIso(),
    updatedAt: nowIso(),
  };
}

async function pullImage(docker: Dockerode, image: string, ctx: SandboxContext): Promise<void> {
  await new Promise<void>((resolve) => {
    void docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err || !stream) {
        // Image may already exist locally; create() will surface a real error if not.
        ctx.logger("warn", `sandbox image pull warning: ${err?.message ?? "no stream"}`, { image });
        resolve();
        return;
      }
      docker.modem.followProgress(stream, (err2: Error | null) => {
        if (err2) ctx.logger("warn", `sandbox image pull error: ${err2.message}`, { image });
        resolve();
      });
    });
  });
}

function lineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buf = "";
  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  });
  stream.on("end", () => {
    if (buf) onLine(buf);
  });
}

class DockerSandboxHandle implements SandboxHandle {
  private readonly container: Dockerode.Container;
  sandbox: Sandbox;

  constructor(container: Dockerode.Container, sandbox: Sandbox) {
    this.container = container;
    this.sandbox = sandbox;
  }

  async status(): Promise<SandboxRuntimeStatus> {
    try {
      const info = await this.container.inspect();
      const status = mapDockerState(info);
      this.sandbox = { ...this.sandbox, status, updatedAt: nowIso() };
      return { status, healthy: status === "running" };
    } catch (err) {
      return { status: "error", healthy: false, error: errMessage(err) };
    }
  }

  spawner(): ProcessSpawner {
    return new DockerExecSpawner(this.container, this.sandbox.id);
  }

  logs(onLine: (stream: "stdout" | "stderr" | "system", line: string) => void): () => void {
    let cancelled = false;
    let logStream: NodeJS.ReadableStream | undefined;
    void this.container.logs(
      { follow: true, stdout: true, stderr: true, tail: 200 },
      (err: Error | null, stream?: NodeJS.ReadableStream) => {
        if (cancelled) return;
        if (err || !stream) {
          onLine("system", `could not attach log stream: ${err?.message ?? "no stream"}`);
          return;
        }
        logStream = stream;
        const out = new PassThrough();
        const errp = new PassThrough();
        this.container.modem.demuxStream(stream, out, errp);
        lineReader(out, (l) => onLine("stdout", l));
        lineReader(errp, (l) => onLine("stderr", l));
      },
    );
    return () => {
      cancelled = true;
      try {
        (logStream as { destroy?: () => void } | undefined)?.destroy?.();
      } catch {
        // already closed
      }
    };
  }

  async restart(): Promise<void> {
    await this.container.restart();
  }

  async stop(): Promise<void> {
    try {
      await this.container.stop({ t: 10 });
    } catch (err) {
      const msg = errMessage(err);
      if (!msg.includes("not running") && !msg.includes("No such container")) throw err;
    }
  }

  async remove(): Promise<void> {
    await this.stop();
    try {
      await this.container.remove({ force: true });
    } catch (err) {
      if (!errMessage(err).includes("No such container")) throw err;
    }
  }
}

export const dockerSandboxProvider: SandboxProvider<DockerSandboxConfig> = {
  id: "docker",
  kind: "sandbox",
  configSchema: DockerSandboxConfig,

  async isAvailable(): Promise<boolean> {
    try {
      const docker = dockerFor({});
      await Promise.race([
        docker.ping(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("docker ping timeout")), 2000),
        ),
      ]);
      return true;
    } catch {
      return false;
    }
  },

  async create(
    id: string,
    spec: SandboxSpec,
    config: DockerSandboxConfig,
    ctx: SandboxContext,
  ): Promise<SandboxHandle> {
    const docker = dockerFor(config);
    const image = spec.image ?? config.defaultImage ?? DEFAULT_SANDBOX_IMAGE;
    await pullImage(docker, image, ctx);

    const mounts = resolveWorkspaceMounts(spec);
    const labels = buildSandboxLabels(id, spec);

    const hostConfig: Dockerode.HostConfig = {
      Binds: mounts.length > 0 ? mountsToBinds(mounts) : undefined,
      AutoRemove: false, // survive agent exit + daemon restart so we can re-adopt
    };
    if (spec.resources?.cpus) hostConfig.NanoCpus = Math.round(spec.resources.cpus * 1e9);
    if (spec.resources?.memoryMb) hostConfig.Memory = spec.resources.memoryMb * 1024 * 1024;

    const container = await docker.createContainer({
      name: containerNameFor(id),
      Image: image,
      // Idle entrypoint: the container stays up so we exec agents into it on demand.
      Cmd: ["sleep", "infinity"],
      Env: toEnvArray(spec.env),
      Labels: labels,
      HostConfig: hostConfig,
    });
    await container.start();

    const sandbox: Sandbox = {
      id,
      providerId: "docker",
      runtimeId: container.id,
      name: containerNameFor(id),
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
    ctx.logger("info", `created docker sandbox ${id}`, { runtimeId: container.id, image });
    return new DockerSandboxHandle(container, sandbox);
  },

  async adopt(
    runtimeId: string,
    config: DockerSandboxConfig,
    _ctx: SandboxContext,
  ): Promise<SandboxHandle | null> {
    const docker = dockerFor(config);
    try {
      const container = docker.getContainer(runtimeId);
      const info = await container.inspect();
      return new DockerSandboxHandle(container, sandboxFromInspect(info));
    } catch {
      return null; // container gone — manager treats as adopt-miss
    }
  },

  // List ALL containers on the host, not just spawntree-created ones, so the
  // management UI can surface and operate on the user's existing containers
  // (each carries `managed: false` unless we created it). Summary-based — no
  // per-container inspect, so it stays fast with many containers.
  async list(config: DockerSandboxConfig, _ctx: SandboxContext): Promise<Sandbox[]> {
    const docker = dockerFor(config);
    const containers = await docker.listContainers({ all: true });
    return containers.map(sandboxFromListInfo);
  },
};
