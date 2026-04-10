import { type ChildProcess, spawn } from "node:child_process";
import type { Service, ServiceConfig, ServiceStatus } from "spawntree-core";
import type { LogStreamer } from "../managers/log-streamer.ts";

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

    // Build the command with framework-specific port flag injection
    // (vite, next, etc. ignore the PORT env var and need explicit --port)
    let command = this.config.command;
    const port = this.envVars.PORT;
    if (port && !command.includes("--port")) {
      command = injectFrameworkFlags(command, port);
    }

    // Use shell mode to support complex commands (pipes, env vars, sh -c, etc.)
    this.process = spawn(command, {
      cwd: this.cwd,
      env: { ...globalThis.process.env, ...this.envVars },
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      detached: process.platform !== "win32",
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
        this._status = code === 0 ? "stopped" : "failed";
        emit("system", `[spawntree] Process exited with code=${code} signal=${signal}`);
      }
    });

    // Wait briefly for early crash detection
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
      };
      const timer = setTimeout(() => {
        this._status = "running";
        settle(resolve);
      }, 100);

      const markRunning = () => {
        clearTimeout(timer);
        this._status = "running";
        settle(resolve);
      };

      this.process!.on("error", (err) => {
        clearTimeout(timer);
        settle(() => reject(new Error(`Failed to start "${this.name}": ${err.message}`)));
      });

      this.process!.stdout?.once("data", markRunning);
      this.process!.stderr?.once("data", markRunning);

      this.process!.on("exit", (code) => {
        if (this._status === "starting" && code === 0) {
          clearTimeout(timer);
          this._status = "stopped";
          settle(resolve);
          return;
        }

        if (this._status === "starting") {
          clearTimeout(timer);
          settle(() => reject(new Error(`"${this.name}" exited immediately with code ${code}`)));
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.process || this._status === "stopped") return;

    this._status = "stopped";
    const processToStop = this.process;

    // If process already exited (crashed), just clean up
    if (processToStop.exitCode !== null || processToStop.signalCode !== null) {
      this.process = null;
      return;
    }

    return new Promise<void>((resolve) => {
      const startedAt = Date.now();
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const killTimer = setTimeout(() => {
        this.killProcess(processToStop, "SIGKILL");
      }, 10_000);

      processToStop.once("exit", () => {
        clearTimeout(killTimer);
        this.process = null;
        this.logStreamer.addLine(
          this.repoId,
          this.envId,
          this.name,
          "system",
          `[spawntree] Process stopped in ${Date.now() - startedAt}ms`,
        );
        settle();
      });

      this.killProcess(processToStop, "SIGTERM");
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

  private killProcess(processToStop: ChildProcess, signal: NodeJS.Signals): void {
    if (process.platform !== "win32" && processToStop.pid && processToStop.spawnargs.length > 0) {
      try {
        process.kill(-processToStop.pid, signal);
        return;
      } catch {
        // fall back to the direct child if process-group signaling is unavailable
      }
    }
    processToStop.kill(signal);
  }
}

/**
 * Inject framework-specific port/host flags into a command string.
 * Frameworks like vite, next.js, astro, etc. ignore the PORT env var
 * and need explicit CLI flags. This mirrors portless's injectFrameworkFlags.
 */
function injectFrameworkFlags(command: string, port: string): string {
  const cmd = command.toLowerCase();

  if (/\bvite\b/.test(cmd) || /\breact-router\b/.test(cmd)) {
    return `${command} --port ${port} --host 127.0.0.1 --strictPort`;
  }
  if (/\bnext\b/.test(cmd)) {
    return `${command} --port ${port} --hostname 127.0.0.1`;
  }
  if (/\bastro\b/.test(cmd) || /\bnuxt\b/.test(cmd)) {
    return `${command} --port ${port} --host 127.0.0.1`;
  }
  if (/\bexpo\b/.test(cmd) || /\breact-native\b/.test(cmd)) {
    return `${command} --port ${port}`;
  }
  // Frameworks that respect PORT env var (express, fastify, hono, django, flask, rails):
  // no injection needed
  return command;
}
