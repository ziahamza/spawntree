import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

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

const SPAWNTREE_HOME = resolve(homedir(), ".spawntree");

export function spawntreeHome(): string {
  return SPAWNTREE_HOME;
}

export function ensureDir(): void {
  const subdirs = [
    SPAWNTREE_HOME,
    resolve(SPAWNTREE_HOME, "repos"),
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

export function socketPath(): string {
  return resolve(SPAWNTREE_HOME, "spawntree.sock");
}

export function stateFileExists(repoId: string): boolean {
  return existsSync(resolve(SPAWNTREE_HOME, "repos", repoId, "state.json"));
}
