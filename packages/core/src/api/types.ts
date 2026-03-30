// Service types
export type ServiceStatus = "starting" | "running" | "failed" | "stopped";
export type ServiceType = "process" | "container" | "postgres" | "redis";
export type InfraStatus = "running" | "stopped" | "starting" | "error";

export interface ServiceInfo {
  name: string;
  type: ServiceType;
  status: ServiceStatus;
  port: number;
  pid?: number;
  url?: string;
  containerId?: string;
}

export interface EnvInfo {
  envId: string;
  repoId: string;
  repoPath: string;
  branch: string;
  basePort: number;
  createdAt: string;
  services: ServiceInfo[];
}

export interface RepoInfo {
  repoId: string;
  repoPath: string;
  envs: EnvInfo[];
}

export interface DaemonInfo {
  version: string;
  pid: number;
  uptime: number;
  repos: number;
  activeEnvs: number;
}

export interface PostgresInstanceInfo {
  version: string;
  status: InfraStatus;
  containerId?: string;
  port: number;
  dataDir: string;
  databases: string[];
}

export interface RedisInstanceInfo {
  status: InfraStatus;
  containerId?: string;
  port: number;
  allocatedDbIndices: number;
}

export interface InfraStatusResponse {
  postgres: PostgresInstanceInfo[];
  redis: RedisInstanceInfo | null;
}

// Request/Response types for each endpoint

export interface CreateEnvRequest {
  repoPath: string;
  envId?: string;
  prefix?: string;
  envOverrides?: Record<string, string>;
  configFile?: string;
}

export interface CreateEnvResponse {
  env: EnvInfo;
}

export interface GetEnvResponse {
  env: EnvInfo;
}

export interface ListEnvsResponse {
  envs: EnvInfo[];
}

export interface DeleteEnvResponse {
  ok: boolean;
}

export interface DownEnvResponse {
  ok: boolean;
}

export interface LogLine {
  ts: string;
  service: string;
  stream: "stdout" | "stderr" | "system";
  line: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface GetInfraStatusResponse extends InfraStatusResponse {}

export interface StopInfraRequest {
  target: "postgres" | "redis" | "all";
  version?: string;
}

export interface StopInfraResponse {
  ok: boolean;
}

export interface DbTemplate {
  name: string;
  size: number;
  createdAt: string;
  sourceDatabaseUrl?: string;
}

export interface ListDbTemplatesResponse {
  templates: DbTemplate[];
}

export interface DumpDbRequest {
  repoPath: string;
  envId: string;
  dbName: string;
  templateName: string;
}

export interface DumpDbResponse {
  template: DbTemplate;
}

export interface RestoreDbRequest {
  repoPath: string;
  envId: string;
  dbName: string;
  templateName: string;
}

export interface RestoreDbResponse {
  ok: boolean;
}

export interface ApiError {
  error: string;
  code: string;
  details?: unknown;
}

/**
 * Derive a stable repo ID from an absolute repo path.
 * Pure function — no Node.js imports, safe for edge runtimes.
 */
export function deriveRepoId(repoPath: string): string {
  const parts = repoPath.split("/");
  // Walk backwards to find the last non-empty segment
  for (let i = parts.length - 1; i >= 0; i--) {
    const segment = parts[i];
    if (segment && segment.length > 0) {
      return segment.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    }
  }
  return "unknown";
}
