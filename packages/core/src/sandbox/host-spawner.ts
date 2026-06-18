import { spawn } from "node:child_process";
import type { ProcessSpawner, SpawnOptions, SpawnedProcess } from "./types.ts";

/**
 * Default ProcessSpawner: runs the command as a child process on the daemon
 * host, merging the caller's env over `process.env`. This reproduces the exact
 * behavior the ACP / JSON-RPC transports had before the spawner seam existed,
 * so selecting no sandbox is a zero-behavior-change path.
 *
 * Note the deliberate asymmetry vs. sandbox spawners: the host spawner inherits
 * `process.env` (the daemon and its sessions share one machine + credentials);
 * sandbox spawners must NOT, since that would leak the daemon's host
 * environment and secrets across the container boundary.
 */
export class HostSpawner implements ProcessSpawner {
  readonly id = "host";

  spawn(command: string, args: readonly string[], opts: SpawnOptions = {}): SpawnedProcess {
    return spawn(command, args as string[], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
  }
}

/** Shared singleton — stateless, safe to reuse across connections. */
export const hostSpawner: ProcessSpawner = new HostSpawner();
