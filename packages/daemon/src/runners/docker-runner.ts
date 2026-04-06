import Dockerode from "dockerode";
import { PassThrough } from "node:stream";
import type { Service, ServiceConfig, ServiceStatus } from "spawntree-core";
import type { LogStreamer } from "../managers/log-streamer.ts";

export interface DockerRunnerOptions {
  name: string;
  config: ServiceConfig;
  envVars: Record<string, string>;
  allocatedPort: number;
  repoId: string;
  envId: string;
  logStreamer: LogStreamer;
}

export class DockerRunner implements Service {
  readonly name: string;
  readonly type = "container" as const;
  private _status: ServiceStatus = "stopped";
  private container: Dockerode.Container | null = null;
  private docker: Dockerode;
  private readonly config: ServiceConfig;
  private readonly envVars: Record<string, string>;
  private readonly allocatedPort: number;
  private readonly repoId: string;
  private readonly envId: string;
  private readonly logStreamer: LogStreamer;

  constructor(options: DockerRunnerOptions) {
    this.name = options.name;
    this.config = options.config;
    this.envVars = options.envVars;
    this.allocatedPort = options.allocatedPort;
    this.repoId = options.repoId;
    this.envId = options.envId;
    this.logStreamer = options.logStreamer;
    this.docker = new Dockerode();
  }

  private emit(stream: "stdout" | "stderr" | "system", line: string): void {
    this.logStreamer.addLine(this.repoId, this.envId, this.name, stream, line);
  }

  async start(): Promise<void> {
    if (!this.config.image) {
      throw new Error(`Service "${this.name}": image is required for container services`);
    }

    this._status = "starting";

    // Pull image if not present locally
    await this.pullImage(this.config.image);

    // Build environment array
    const mergedEnv: Record<string, string> = {
      ...this.envVars,
      ...this.config.environment,
    };
    const envArray = Object.entries(mergedEnv).map(([k, v]) => `${k}=${v}`);

    // Build port bindings: allocatedPort (host) → config.port (container)
    const containerPort = this.config.port ?? 80;
    const portBindings: Record<string, Array<{ HostPort: string; }>> = {
      [`${containerPort}/tcp`]: [{ HostPort: String(this.allocatedPort) }],
    };
    const exposedPorts: Record<string, Record<string, never>> = {
      [`${containerPort}/tcp`]: {},
    };

    // Build volume bindings
    const binds: string[] = [];
    if (this.config.volumes && this.config.volumes.length > 0) {
      for (const vol of this.config.volumes) {
        const mode = vol.mode ?? "rw";
        binds.push(`${vol.host}:${vol.container}:${mode}`);
      }
    }

    // Build labels
    const labels: Record<string, string> = {
      "spawntree.managed": "true",
      "spawntree.repoId": this.repoId,
      "spawntree.envId": this.envId,
      "spawntree.service": this.name,
    };

    // Build command override
    const cmd = this.config.command ? this.config.command.split(/\s+/) : undefined;

    const createOptions: Dockerode.ContainerCreateOptions = {
      Image: this.config.image,
      Env: envArray,
      ExposedPorts: exposedPorts,
      Labels: labels,
      HostConfig: {
        PortBindings: portBindings,
        Binds: binds.length > 0 ? binds : undefined,
        AutoRemove: false,
      },
    };

    if (cmd && cmd.length > 0) {
      createOptions.Cmd = cmd;
    }

    this.container = await this.docker.createContainer(createOptions);

    await this.container.start();

    // Attach log stream
    this.attachLogs(this.container);

    this._status = "running";
    this.emit("system", `[spawntree-daemon] Container started: ${this.config.image} on port ${this.allocatedPort}`);

    // Watch for container exit
    this.watchExit(this.container);
  }

  async stop(): Promise<void> {
    if (!this.container || this._status === "stopped") return;

    this._status = "stopped";

    try {
      await this.container.stop({ t: 10 });
    } catch (err: unknown) {
      // Container may already be stopped
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("not running") && !msg.includes("No such container")) {
        this.emit("system", `[spawntree-daemon] Warning stopping container: ${msg}`);
      }
    }

    try {
      await this.container.remove({ force: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("No such container")) {
        this.emit("system", `[spawntree-daemon] Warning removing container: ${msg}`);
      }
    }

    this.container = null;
  }

  status(): ServiceStatus {
    return this._status;
  }

  async healthcheck(): Promise<boolean> {
    if (!this.config.healthcheck?.url) {
      // Fall back to docker inspect
      return this.isContainerRunning();
    }

    const url = this.config.healthcheck.url;

    // TCP healthcheck
    if (url.startsWith("tcp://")) {
      const parsed = new URL(url.replace("tcp://", "http://"));
      const { createConnection } = await import("node:net");
      return new Promise<boolean>((resolve) => {
        const socket = createConnection(
          { host: parsed.hostname, port: Number(parsed.port), timeout: 2000 },
          () => {
            socket.destroy();
            resolve(true);
          },
        );
        socket.on("error", () => resolve(false));
        socket.on("timeout", () => {
          socket.destroy();
          resolve(false);
        });
      });
    }

    // HTTP healthcheck
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return resp.ok;
    } catch {
      return false;
    }
  }

  get pid(): undefined {
    return undefined;
  }

  get containerId(): string | undefined {
    return this.container?.id;
  }

  private async pullImage(image: string): Promise<void> {
    this.emit("system", `[spawntree-daemon] Pulling image: ${image}`);

    return new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) {
          // If image already exists locally, Docker may still succeed on create
          // Treat pull errors as warnings if it's a "not found" issue
          this.emit("system", `[spawntree-daemon] Pull warning: ${err.message}`);
          resolve();
          return;
        }

        this.docker.modem.followProgress(
          stream,
          (err2: Error | null) => {
            if (err2) {
              reject(new Error(`Failed to pull image "${image}": ${err2.message}`));
            } else {
              this.emit("system", `[spawntree-daemon] Image ready: ${image}`);
              resolve();
            }
          },
          (event: { status?: string; id?: string; }) => {
            if (event.status) {
              const line = event.id ? `${event.status} ${event.id}` : event.status;
              this.emit("system", line);
            }
          },
        );
      });
    });
  }

  private attachLogs(container: Dockerode.Container): void {
    container.logs(
      { follow: true, stdout: true, stderr: true },
      (err: Error | null, stream?: NodeJS.ReadableStream) => {
        if (err || !stream) {
          this.emit("system", `[spawntree-daemon] Could not attach log stream: ${err?.message ?? "no stream"}`);
          return;
        }

        const stdout = new PassThrough();
        const stderr = new PassThrough();

        container.modem.demuxStream(stream, stdout, stderr);

        this.streamLines(stdout, "stdout");
        this.streamLines(stderr, "stderr");
      },
    );
  }

  private streamLines(stream: NodeJS.ReadableStream, type: "stdout" | "stderr"): void {
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        this.emit(type, line);
      }
    });
    stream.on("end", () => {
      if (buf) this.emit(type, buf);
    });
  }

  private watchExit(container: Dockerode.Container): void {
    container.wait((err: Error | null, data: { StatusCode: number; }) => {
      if (this._status === "stopped") return;
      const code = data?.StatusCode ?? -1;
      this._status = "failed";
      this.emit("system", `[spawntree-daemon] Container exited with code ${code}`);
      this.container = null;
    });
  }

  private async isContainerRunning(): Promise<boolean> {
    if (!this.container) return false;
    try {
      const info = await this.container.inspect();
      return info.State?.Running === true;
    } catch {
      return false;
    }
  }
}
