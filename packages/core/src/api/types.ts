export type {
  ApiError,
  CreateEnvRequest,
  CreateEnvResponse,
  GetEnvResponse,
  ListEnvsResponse,
  DeleteEnvResponse,
  DownEnvResponse,
  DaemonInfo,
  DbTemplate,
  DumpDbRequest,
  DumpDbResponse,
  RestoreDbRequest,
  RestoreDbResponse,
  EnvInfo,
  LogLine,
  PostgresInstanceInfo,
  RedisInstanceInfo,
  RegisteredRepo,
  RegisterRepoRequest,
  RegisterRepoResponse,
  ListRegisteredReposResponse,
  TunnelDefinition,
  TunnelStatusInfo,
  TunnelTarget,
  UpsertTunnelRequest,
  UpsertTunnelResponse,
  ListTunnelsResponse,
  ListTunnelStatusesResponse,
  StopInfraRequest,
  StopInfraResponse,
  ListDbTemplatesResponse,
} from "../generated/index.js";

export type ServiceInfo = import("../generated/index.js").ServiceInfo;
export type ServiceType = ServiceInfo["type"];
export type ServiceStatus = ServiceInfo["status"];
export type InfraStatus = NonNullable<import("../generated/index.js").PostgresInstanceInfo["status"]>;
export type GetInfraStatusResponse = import("../generated/index.js").InfraStatusResponse;

export interface RepoInfo {
  repoId: string;
  repoPath: string;
  envs: import("../generated/index.js").EnvInfo[];
}

export function deriveRepoId(repoPath: string): string {
  const parts = repoPath.split("/");
  for (let i = parts.length - 1; i >= 0; i--) {
    const segment = parts[i];
    if (segment && segment.length > 0) {
      return segment.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    }
  }
  return "unknown";
}
