import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface PortSlot {
  envKey: string;
  basePort: number;
  allocatedAt: string;
}

export interface PortRegistryState {
  slots: PortSlot[];
}

export interface RepoEnvRecord {
  envId: string;
  repoId: string;
  repoPath: string;
  branch: string;
  basePort: number;
  createdAt: string;
  services: Array<{
    name: string;
    type: string;
    port: number;
    pid?: number;
  }>;
}

export interface RepoState {
  repoId: string;
  repoPath: string;
  envs: RepoEnvRecord[];
}

export interface RuntimeMetadata {
  pid: number;
  startedAt: string;
  httpPort: number;
}

const SPAWNTREE_HOME = resolve(homedir(), ".spawntree");

export function spawntreeHome(): string {
  return SPAWNTREE_HOME;
}

export function ensureDir(): void {
  const subdirs = [
    SPAWNTREE_HOME,
    resolve(SPAWNTREE_HOME, "repos"),
    resolve(SPAWNTREE_HOME, "runtime"),
  ];
  for (const dir of subdirs) {
    mkdirSync(dir, { recursive: true });
  }
}

export function ensureRepoDir(repoId: string): void {
  const repoDir = resolve(SPAWNTREE_HOME, "repos", repoId);
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(resolve(repoDir, "logs"), { recursive: true });
}

export function saveDaemonPid(pid: number): void {
  ensureDir();
  writeFileSync(resolve(SPAWNTREE_HOME, "daemon.pid"), String(pid));
}

export function loadPortRegistry(): PortRegistryState {
  const file = resolve(SPAWNTREE_HOME, "port-registry.json");
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as PortRegistryState;
  } catch {
    return { slots: [] };
  }
}

export function savePortRegistry(state: PortRegistryState): void {
  ensureDir();
  writeFileSync(
    resolve(SPAWNTREE_HOME, "port-registry.json"),
    JSON.stringify(state, null, 2) + "\n",
  );
}

export function loadRepoState(repoId: string): RepoState | null {
  const file = resolve(SPAWNTREE_HOME, "repos", repoId, "state.json");
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as RepoState;
  } catch {
    return null;
  }
}

export function saveRepoState(repoId: string, state: RepoState): void {
  ensureRepoDir(repoId);
  writeFileSync(
    resolve(SPAWNTREE_HOME, "repos", repoId, "state.json"),
    JSON.stringify(state, null, 2) + "\n",
  );
}

export function logDir(repoId: string, envId: string): string {
  const dir = resolve(SPAWNTREE_HOME, "repos", repoId, "logs", envId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function runtimeMetadataPath(): string {
  return resolve(SPAWNTREE_HOME, "runtime", "daemon.json");
}

export function saveRuntimeMetadata(metadata: RuntimeMetadata): void {
  ensureDir();
  writeFileSync(runtimeMetadataPath(), JSON.stringify(metadata, null, 2) + "\n");
}

// ─── Host binding (--host + --host-key) ─────────────────────────────────────

/**
 * The daemon's record of "I'm bound to host X with credential Y." Persisted
 * at `~/.spawntree/host.json` (0600) so subsequent `spawntree daemon`
 * invocations pick up the binding without re-passing CLI args.
 *
 * Override semantics: if either `--host` or `--host-key` is passed, the
 * pair is written to disk on boot, replacing whatever was there before.
 * To unbind: `rm ~/.spawntree/host.json`.
 */
export interface HostBinding {
  /** Base URL of the spawntree-host server, e.g. `http://controller:7777`. */
  url: string;
  /** Bearer token issued by `POST /api/daemons` on the host. `dh_…` shape. */
  key: string;
}

/**
 * Resolve the binding path against an optional `dataDir`. Defaults to
 * `~/.spawntree/host.json`. Tests pass an explicit dir so they don't
 * touch the real home directory.
 */
export function hostBindingPath(dataDir: string = SPAWNTREE_HOME): string {
  return resolve(dataDir, "host.json");
}

/**
 * Read the persisted host binding, or `null` if none. Returns `null` (not
 * throw) on a corrupt file so the daemon can boot in standalone mode and
 * surface the issue via logs rather than crash.
 */
export function loadHostBinding(dataDir: string = SPAWNTREE_HOME): HostBinding | null {
  const path = hostBindingPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<HostBinding>;
    if (typeof parsed.url !== "string" || typeof parsed.key !== "string") {
      return null;
    }
    return { url: parsed.url, key: parsed.key };
  } catch {
    return null;
  }
}

/**
 * Persist the host binding with `0600` perms. Re-chmods on every save in
 * case the file was created with a default umask before — same posture as
 * `storage.json` since the file contents are equally sensitive (the bearer
 * token is the daemon's identity to the host).
 */
export function saveHostBinding(
  binding: HostBinding,
  dataDir: string = SPAWNTREE_HOME,
): void {
  mkdirSync(dataDir, { recursive: true });
  const path = hostBindingPath(dataDir);
  writeFileSync(
    path,
    JSON.stringify(binding, null, 2) + "\n",
    { encoding: "utf-8", mode: 0o600 },
  );
  try {
    chmodSync(path, 0o600);
  } catch {
    // Non-POSIX filesystems: chmod is a no-op.
  }
}

/** `rm <dataDir>/host.json`. Used by future `spawntree host unbind`. */
export function clearHostBinding(dataDir: string = SPAWNTREE_HOME): void {
  const path = hostBindingPath(dataDir);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
