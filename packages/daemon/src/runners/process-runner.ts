import { spawn, type ChildProcess } from "node:child_process";
import type { Service, ServiceStatus } from "spawntree-core";
import type { ServiceConfig } from "spawntree-core";
import type { LogStreamer } from "../managers/log-streamer.js";

export interface ProcessRunnerOptions {
  name: string;
  config: ServiceConfig;
  envVars: Record<string, string>;
  cwd: string;
  repoId: string;
  envId: string;
  logStreamer: LogStreamer;
}

export class ProcessRunner implements Service {
  readonly name: string;
  readonly type = "process" as const;
  private _status: ServiceStatus = "stopped";
  private process: ChildProcess | null = null;
  private readonly config: ServiceConfig;
  private readonly envVars: Record<string, string>;
  private readonly cwd: string;
  private readonly repoId: string;
  private readonly envId: string;
  private readonly logStreamer: LogStreamer;

  constructor(options: ProcessRunnerOptions) {
    this.name = options.name;
    this.config = options.config;
    this.envVars = options.envVars;
    this.cwd = options.cwd;
    this.repoId = options.repoId;
    this.envId = options.envId;
    this.logStreamer = options.logStreamer;
  }

  async start(): Promise<void> {
    if (!this.config.command) {
      throw new Error(`Service "${this.name}": command is required for process services`);
    }

    this._status = "starting";

    const emit = (stream: "stdout" | "stderr" | "system", line: string) => {
      this.logStreamer.addLine(this.repoId, this.envId, this.name, stream, line);
    };

    const [cmd, ...args] = this.config.command.split(/\s+/);
    this.process = spawn(cmd, args, {
      cwd: this.cwd,
      env: { ...globalThis.process.env, ...this.envVars },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Stream stdout line by line
    if (this.process.stdout) {
      let stdoutBuf = "";
      this.process.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) {
          emit("stdout", line);
        }
      });
      this.process.stdout.on("end", () => {
        if (stdoutBuf) emit("stdout", stdoutBuf);
      });
    }

    // Stream stderr line by line
    if (this.process.stderr) {
      let stderrBuf = "";
      this.process.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop() ?? "";
        for (const line of lines) {
          emit("stderr", line);
        }
      });
      this.process.stderr.on("end", () => {
        if (stderrBuf) emit("stderr", stderrBuf);
      });
    }

    this.process.on("error", (err) => {
      this._status = "failed";
      emit("system", `[spawntree] Process error: ${err.message}`);
    });

    this.process.on("exit", (code, signal) => {
      if (this._status !== "stopped") {
        this._status = "failed";
        emit("system", `[spawntree] Process exited with code=${code} signal=${signal}`);
      }
    });

    // Wait briefly for early crash detection
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._status = "running";
        resolve();
      }, 500);

      this.process!.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to start "${this.name}": ${err.message}`));
      });

      this.process!.on("exit", (code) => {
        if (this._status === "starting") {
          clearTimeout(timer);
          reject(new Error(`"${this.name}" exited immediately with code ${code}`));
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.process || this._status === "stopped") return;

    this._status = "stopped";

    return new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        this.process?.kill("SIGKILL");
      }, 10_000);

      this.process!.on("exit", () => {
        clearTimeout(killTimer);
        this.process = null;
        resolve();
      });

      this.process!.kill("SIGTERM");
    });
  }

  status(): ServiceStatus {
    return this._status;
  }

  async healthcheck(): Promise<boolean> {
    if (!this.config.healthcheck?.url) return this._status === "running";

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

  get pid(): number | undefined {
    return this.process?.pid;
  }
}
