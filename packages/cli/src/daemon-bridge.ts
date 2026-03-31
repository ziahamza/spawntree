import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { Agent, fetch as undiciFetch } from "undici";
import { ApiClient, deriveRepoId } from "spawntree-core";

const SPAWNTREE_DIR = join(homedir(), ".spawntree");
const SOCKET_PATH = join(SPAWNTREE_DIR, "spawntree.sock");
const DAEMON_PID_PATH = join(SPAWNTREE_DIR, "daemon.pid");

/**
 * Create a fetch function that routes all requests through the Unix socket.
 * Uses undici's own fetch so the `dispatcher` option is natively supported.
 */
export function createSocketFetch(): typeof fetch {
  const agent = new Agent({ connect: { socketPath: SOCKET_PATH } });
  return (url, init) =>
    undiciFetch(url as string, { ...init, dispatcher: agent }) as unknown as ReturnType<typeof fetch>;
}

/**
 * Check if the daemon is running by verifying the PID file and probing the socket.
 */
export async function isDaemonRunning(): Promise<boolean> {
  if (!existsSync(DAEMON_PID_PATH)) return false;

  let pid: number;
  try {
    pid = parseInt(readFileSync(DAEMON_PID_PATH, "utf-8").trim(), 10);
  } catch {
    return false;
  }

  if (!pid || isNaN(pid)) return false;

  // Check if the process is alive
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  // Probe the socket
  try {
    const socketFetch = createSocketFetch();
    const response = await socketFetch("http://localhost/api/v1/daemon");
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Start the daemon if not running. Waits for the "READY" signal on stdout
 * (up to 10 seconds), then unrefs the child so the CLI can exit independently.
 */
export async function ensureDaemon(): Promise<void> {
  if (await isDaemonRunning()) return;

  // Resolve the daemon binary from the spawntree-daemon package
  let daemonBin: string;
  try {
    // Try to resolve via require.resolve from the installed package
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    daemonBin = require.resolve("spawntree-daemon/dist/server-main.js");
  } catch {
    // Fallback: look relative to this file (monorepo layout)
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    daemonBin = resolve(__dirname, "../../../daemon/dist/server-main.js");
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("node", [daemonBin], {
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env },
    });

    const rl = createInterface({ input: child.stdout! });

    const timeout = setTimeout(() => {
      rl.close();
      child.unref();
      reject(new Error("Daemon did not start within 10 seconds"));
    }, 10_000);

    rl.on("line", (line) => {
      if (line.includes("READY")) {
        clearTimeout(timeout);
        rl.close();
        child.unref();
        resolve();
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      rl.close();
      reject(new Error(`Failed to start daemon: ${err.message}`));
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      rl.close();
      if (code !== null && code !== 0) {
        reject(new Error(`Daemon exited with code ${code}`));
      }
    });
  });
}

/**
 * Get an ApiClient connected to the daemon, starting it first if needed.
 */
export async function getClient(): Promise<ApiClient> {
  await ensureDaemon();
  return new ApiClient(createSocketFetch(), "http://localhost");
}

/**
 * Derive the repoId from the current directory's git root.
 */
export function getCurrentRepoId(): string {
  let repoRoot: string;
  try {
    repoRoot = execSync("git rev-parse --show-toplevel", {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      "Not a git repository. spawntree requires a git repository.",
    );
  }
  return deriveRepoId(repoRoot);
}

/**
 * Get the current git root directory.
 */
export function getRepoPath(): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      "Not a git repository. spawntree requires a git repository.",
    );
  }
}

/**
 * Get the current environment ID (branch name, sanitized: / → -).
 * If a prefix is provided, appends it as `${branch}-${prefix}`.
 */
export function getCurrentEnvId(prefix?: string): string {
  let branch: string;
  try {
    branch = execSync("git branch --show-current", {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    branch = "detached";
  }

  const safeBranch = branch.replace(/\//g, "-") || "detached";
  return prefix ? `${safeBranch}-${prefix}` : safeBranch;
}
