import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { Agent, fetch as undiciFetch } from "undici";
import { ApiClient, deriveRepoId } from "spawntree-core";

const SPAWNTREE_DIR = join(homedir(), ".spawntree");
const SOCKET_PATH = join(SPAWNTREE_DIR, "spawntree.sock");
const RUNTIME_METADATA_PATH = join(SPAWNTREE_DIR, "runtime", "daemon.json");

interface RuntimeMetadata {
  pid: number;
  startedAt: string;
  socketPath: string;
  httpPort: number;
}

/**
 * Create a fetch function that routes all requests through the Unix socket.
 * Uses undici's own fetch so the `dispatcher` option is natively supported.
 */
export function createSocketFetch(): typeof fetch {
  const agent = new Agent({ connect: { socketPath: SOCKET_PATH } });
  return (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const requestInit =
      input instanceof Request
        ? {
            method: input.method,
            headers: input.headers,
            body: input.body as any,
            duplex: input.body ? "half" : undefined,
            redirect: input.redirect,
            signal: input.signal,
          }
        : {};

    return undiciFetch(url, {
      ...requestInit,
      ...(init as RequestInit | undefined),
      duplex:
        (requestInit as { body?: BodyInit | null }).body ??
        (init as RequestInit | undefined)?.body
          ? "half"
          : undefined,
      dispatcher: agent,
    } as any) as unknown as ReturnType<typeof fetch>;
  };
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
    const socketFetch = createSocketFetch();
    const response = await socketFetch("http://localhost/api/v1/daemon");
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Start the native daemon if not running.
 * Readiness is health-based: wait until the socket responds and runtime metadata
 * includes the loopback HTTP listener.
 */
export async function ensureDaemon(): Promise<void> {
  if (await isDaemonRunning()) return;

  const { resolveDaemonBinary } = await import("spawntree-daemon");
  const daemonBin = resolveDaemonBinary();

  const started = await new Promise<boolean>((resolve, reject) => {
    const child = spawn(daemonBin, [], {
      detached: true,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env },
    });

    child.once("error", (err) => {
      reject(new Error(`Failed to start daemon: ${err.message}`));
    });

    child.unref();

    waitForDaemon(10_000)
      .then(resolve)
      .catch(reject);
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
  const client = new ApiClient(createSocketFetch(), "http://localhost");
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
    if (metadata?.httpPort && await isDaemonRunning()) {
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
