import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";

interface EnvState {
  envName: string;
  branch: string;
  basePort: number;
  pids: Record<string, number>;
  createdAt: string;
}

export class StateManager {
  private readonly spawntreeDir: string;

  constructor(spawntreeDir: string) {
    this.spawntreeDir = spawntreeDir;
  }

  /**
   * Create state directory for an environment.
   */
  createStateDir(envName: string): string {
    const stateDir = resolve(this.spawntreeDir, "state", envName);
    mkdirSync(stateDir, { recursive: true });
    return stateDir;
  }

  /**
   * Create log directory for an environment.
   */
  createLogDir(envName: string): string {
    const logDir = resolve(this.spawntreeDir, "logs", envName);
    mkdirSync(logDir, { recursive: true });
    return logDir;
  }

  /**
   * Create PID directory for an environment.
   */
  createPidDir(envName: string): string {
    const pidDir = resolve(this.spawntreeDir, "pids", envName);
    mkdirSync(pidDir, { recursive: true });
    return pidDir;
  }

  /**
   * Save a PID for a service in an environment.
   */
  savePid(envName: string, serviceName: string, pid: number): void {
    const pidDir = this.createPidDir(envName);
    writeFileSync(resolve(pidDir, `${serviceName}.pid`), String(pid));
  }

  /**
   * Read all PIDs for an environment.
   */
  readPids(envName: string): Record<string, number> {
    const pidDir = resolve(this.spawntreeDir, "pids", envName);
    const pids: Record<string, number> = {};

    if (!existsSync(pidDir)) return pids;

    for (const file of readdirSync(pidDir)) {
      if (file.endsWith(".pid")) {
        const serviceName = file.replace(".pid", "");
        try {
          const pid = parseInt(readFileSync(resolve(pidDir, file), "utf-8").trim(), 10);
          if (!isNaN(pid)) {
            pids[serviceName] = pid;
          }
        } catch {
          // ignore unreadable PID files
        }
      }
    }

    return pids;
  }

  /**
   * Clean up stale PIDs (processes that are no longer running).
   * Returns the cleaned-up service names.
   */
  cleanStalePids(envName: string): string[] {
    const pids = this.readPids(envName);
    const cleaned: string[] = [];

    for (const [serviceName, pid] of Object.entries(pids)) {
      if (!this.isPidAlive(pid)) {
        // Kill orphan if somehow still alive as zombie
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead
        }

        // Remove PID file
        const pidFile = resolve(this.spawntreeDir, "pids", envName, `${serviceName}.pid`);
        try {
          rmSync(pidFile);
        } catch {
          // ignore
        }

        cleaned.push(serviceName);
      }
    }

    return cleaned;
  }

  /**
   * Save environment state.
   */
  saveState(envName: string, state: EnvState): void {
    const stateDir = this.createStateDir(envName);
    writeFileSync(resolve(stateDir, "env.json"), JSON.stringify(state, null, 2) + "\n");
  }

  /**
   * Read environment state.
   */
  readState(envName: string): EnvState | null {
    const stateFile = resolve(this.spawntreeDir, "state", envName, "env.json");
    try {
      return JSON.parse(readFileSync(stateFile, "utf-8")) as EnvState;
    } catch {
      return null;
    }
  }

  /**
   * Remove all state for an environment.
   */
  removeAll(envName: string): void {
    for (const subdir of ["state", "logs", "pids", "envs"]) {
      const dir = resolve(this.spawntreeDir, subdir, envName);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  /**
   * List all environment names that have state.
   */
  listEnvs(): string[] {
    const stateDir = resolve(this.spawntreeDir, "state");
    if (!existsSync(stateDir)) return [];
    return readdirSync(stateDir).filter((entry) => !entry.startsWith("."));
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
