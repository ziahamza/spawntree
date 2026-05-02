import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ApiClient, deriveRepoId } from "spawntree-core";

const SPAWNTREE_DIR = join(homedir(), ".spawntree");
const RUNTIME_METADATA_PATH = join(SPAWNTREE_DIR, "runtime", "daemon.json");

interface RuntimeMetadata {
  pid: number;
  startedAt: string;
  httpPort: number;
}

/**
 * Check if the daemon is running by verifying the PID file and probing the socket.
 */
export async function isDaemonRunning(): Promise<boolean> {
  const metadata = readRuntimeMetadata();
  if (!metadata) return false;

  const pid = metadata.pid;
  if (!pid || Number.isNaN(pid)) return false;

  // Check if the process is alive
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  // Probe the socket
  try {
    const response = await fetch(`http://127.0.0.1:${metadata.httpPort}/api/v1/daemon`);
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

  const { resolveServerEntry } = await import("spawntree-daemon");
  const daemonEntry = resolveServerEntry();

  const started = await new Promise<boolean>((resolve, reject) => {
    const child = spawn(process.execPath, [daemonEntry], {
      detached: true,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env },
    });

    child.once("error", (err) => {
      reject(new Error(`Failed to start daemon: ${err.message}`));
    });

    child.unref();

    waitForDaemon(10_000).then(resolve).catch(reject);
  });

  if (!started) {
    throw new Error("Daemon did not start within 10 seconds");
  }
}

/**
 * Get an ApiClient connected to the daemon, starting it first if needed.
 */
export async function getClient(): Promise<ApiClient> {
  await ensureDaemon();
  const metadata = readRuntimeMetadata();
  if (!metadata?.httpPort) {
    throw new Error("Daemon metadata missing HTTP port");
  }
  const client = new ApiClient({ baseUrl: `http://127.0.0.1:${metadata.httpPort}` });
  await autoRegisterRepo(client);
  return client;
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
    throw new Error("Not a git repository. spawntree requires a git repository.");
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
    throw new Error("Not a git repository. spawntree requires a git repository.");
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

function readRuntimeMetadata(): RuntimeMetadata | null {
  if (!existsSync(RUNTIME_METADATA_PATH)) return null;
  try {
    return JSON.parse(readFileSync(RUNTIME_METADATA_PATH, "utf-8")) as RuntimeMetadata;
  } catch {
    return null;
  }
}

async function waitForDaemon(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const metadata = readRuntimeMetadata();
    if (metadata?.httpPort && (await isDaemonRunning())) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function autoRegisterRepo(client: ApiClient): Promise<void> {
  try {
    const repoPath = getRepoPath();
    const configPath = resolve(repoPath, "spawntree.yaml");
    if (!existsSync(configPath)) {
      return;
    }
    await client.registerRepo({ repoPath, configPath });
  } catch {
    // Not every command runs in a git repository. Ignore silently.
  }
}
