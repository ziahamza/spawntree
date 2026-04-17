import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AddFolderResponse,
  type ConfigPreviewResponse,
  type ConfigSaveResponse,
  type ConfigServiceSuggestion,
  type ConfigSignal,
  type ConfigSuggestResponse,
  type ConfigTestResponse,
  type ConfigTestServiceResult,
  createApiClient,
  type EnvInfo,
  type GitPathInfo,
  type InfraStatusResponse,
  type ServiceInfo,
  type WebRepo,
} from "spawntree-core/browser";

/**
 * The `api` reference is a `let` binding (not `const`) so the host
 * switcher can point the dashboard at a different spawntree daemon
 * without reloading the page. Every call site reads the current binding
 * at call time, so reassigning the client picks up on the next refetch.
 *
 * `setApiBaseUrl("")` or `setApiBaseUrl(undefined)` reverts to same-origin
 * (the default for the local daemon serving this bundle).
 */
let api = createApiClient();
let currentBaseUrl: string = "";

export function setApiBaseUrl(baseUrl: string | undefined | null): void {
  const normalized = baseUrl ?? "";
  currentBaseUrl = normalized;
  api = createApiClient({ baseUrl: normalized || undefined });
}

export function getApiBaseUrl(): string {
  return currentBaseUrl;
}

export type DaemonInfo = Awaited<ReturnType<typeof api.getDaemonInfo>>;
export type Service = ServiceInfo;
export type Env = EnvInfo;
export type EnvListItem = EnvInfo;
export type InfraStatus = InfraStatusResponse;
export type ConfigTestResult = ConfigTestResponse;
export type ConfigPreviewResult = ConfigPreviewResponse;
export type ConfigSuggestResult = ConfigSuggestResponse;
export type ConfigSaveResult = ConfigSaveResponse;
export { ConfigServiceSuggestion, ConfigSignal, ConfigTestServiceResult, GitPathInfo, WebRepo };

export interface Clone {
  id: string;
  path: string;
  branch?: string;
  missing: boolean;
  git?: GitPathInfo;
  envs: EnvListItem[];
  worktrees: Worktree[];
}

export interface Worktree {
  path: string;
  branch: string;
  git?: GitPathInfo;
  envs: EnvListItem[];
}

export interface WebRepoDetail {
  slug: string;
  name: string;
  remoteUrl?: string;
  clones: Clone[];
}

export function deriveEnvStatus(env: EnvListItem): "running" | "starting" | "crashed" | "stopped" {
  if (!env.services?.length) return "stopped";
  if (env.services.some((service) => service.status === "running")) return "running";
  if (env.services.some((service) => service.status === "starting")) return "starting";
  if (env.services.some((service) => service.status === "failed")) return "crashed";
  return "stopped";
}

export function useDaemonInfo() {
  return useQuery({
    queryKey: ["daemon"],
    queryFn: () => api.getDaemonInfo(),
    refetchInterval: 30_000,
  });
}

export function useEnvs() {
  return useQuery({
    queryKey: ["envs"],
    queryFn: async () => (await api.listEnvs()).envs,
    refetchInterval: 30_000,
  });
}

export function useRepoEnvs(repoID: string) {
  return useQuery({
    queryKey: ["repos", repoID, "envs"],
    queryFn: async () => (await api.listEnvs(repoID)).envs,
    enabled: !!repoID,
  });
}

export function useEnvDetail(repoID: string, envID: string, repoPath?: string) {
  return useQuery({
    queryKey: ["repos", repoID, "envs", envID, repoPath],
    queryFn: async () => (await api.getEnv(repoID, envID, repoPath)).env,
    enabled: !!repoID && !!envID,
    refetchInterval: 15_000,
  });
}

export function useInfra() {
  return useQuery({
    queryKey: ["infra"],
    queryFn: () => api.getInfraStatus(),
    refetchInterval: 30_000,
  });
}

export function useWebRepos() {
  return useQuery({
    queryKey: ["web", "repos"],
    queryFn: async () => (await api.listWebRepos()).repos,
    refetchInterval: 30_000,
  });
}

export function useWebRepoDetail(slug: string, enabled = true) {
  return useQuery({
    queryKey: ["web", "repos", slug],
    enabled: !!slug && enabled,
    refetchInterval: 60_000,
    queryFn: async () => {
      const response = await api.getWebRepoDetail(slug);
      const activityScore = (path: string) =>
        Date.parse(response.gitPaths[path]?.activityAt ?? "") || 0;
      const clones: Array<Clone> = response.clones
        .map((clone) => ({
          id: clone.id,
          path: clone.path,
          missing: clone.status === "missing",
          git: response.gitPaths[clone.path],
          envs: response.envs.filter((env) => env.repoPath === clone.path),
          worktrees: (response.worktrees[clone.id] ?? [])
            .filter((worktree) => worktree.path !== clone.path)
            .map((worktree) => ({
              path: worktree.path,
              branch: worktree.branch || response.gitPaths[worktree.path]?.branch || "detached",
              git: response.gitPaths[worktree.path],
              envs: response.envs.filter((env) => env.repoPath === worktree.path),
            }))
            .sort((left, right) => activityScore(right.path) - activityScore(left.path)),
        }))
        .sort((left, right) => activityScore(right.path) - activityScore(left.path));

      return {
        slug: response.repo.slug,
        name: response.repo.name,
        remoteUrl: response.repo.remoteUrl || undefined,
        clones,
      } satisfies WebRepoDetail;
    },
  });
}

export function useWebRepoTree(slug: string, enabled = true) {
  return useQuery({
    queryKey: ["web", "repos", slug, "tree"],
    enabled: !!slug && enabled,
    refetchInterval: 30_000,
    queryFn: async () => {
      const response = await api.getWebRepoTree(slug);
      const clones: Array<Clone> = response.clones.map((clone) => ({
        id: clone.id,
        path: clone.path,
        missing: clone.status === "missing",
        envs: response.envs.filter((env) => env.repoPath === clone.path),
        worktrees: (response.worktrees[clone.id] ?? [])
          .filter((worktree) => worktree.path !== clone.path)
          .map((worktree) => ({
            path: worktree.path,
            branch: worktree.branch || "detached",
            envs: response.envs.filter((env) => env.repoPath === worktree.path),
          })),
      }));

      return {
        slug: response.repo.slug,
        name: response.repo.name,
        remoteUrl: response.repo.remoteUrl || undefined,
        clones,
      } satisfies WebRepoDetail;
    },
  });
}

export function useCreateEnv() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { repoPath: string; configFile?: string; envId?: string }) =>
      (await api.createEnv(body)).env,
    onSuccess: () => {
      invalidateAppQueries(queryClient);
    },
  });
}

export function useStopEnv() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { repoID: string; envID: string; repoPath?: string }) =>
      api.downEnv(input.repoID, input.envID, input.repoPath),
    onSuccess: () => {
      invalidateAppQueries(queryClient);
    },
  });
}

export function useDeleteEnv() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { repoID: string; envID: string; repoPath?: string }) =>
      api.deleteEnv(input.repoID, input.envID, input.repoPath),
    onSuccess: () => {
      invalidateAppQueries(queryClient);
    },
  });
}

export function useDiscover() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await queryClient.invalidateQueries({ queryKey: ["web", "repos"] });
    },
  });
}

export type AddFolderResult = AddFolderResponse;

export function useAddFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { path: string; remoteName?: string; scanChildren?: boolean }) =>
      api.addFolder(body),
    onSuccess: () => {
      invalidateAppQueries(queryClient);
    },
  });
}

export function useProbeAddPath() {
  return useMutation({
    mutationFn: (body: { path: string }) => api.probeAddPath(body),
  });
}

export function useRelinkClone() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { repoSlug: string; cloneID: string; newPath: string }) =>
      api.relinkClone(input.repoSlug, input.cloneID, { path: input.newPath }),
    onSuccess: () => {
      invalidateAppQueries(queryClient);
    },
  });
}

export function useDeleteClone() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { repoSlug: string; cloneID: string }) =>
      api.deleteClone(input.repoSlug, input.cloneID),
    onSuccess: () => {
      invalidateAppQueries(queryClient);
    },
  });
}

export function useArchiveWorktree() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { repoSlug: string; path: string }) =>
      api.archiveWorktree(input.repoSlug, { path: input.path }),
    onSuccess: () => {
      invalidateAppQueries(queryClient);
    },
  });
}

export function useTestConfig() {
  return useMutation({
    mutationFn: (body: { repoPath: string; content: string }) => api.testConfig(body),
  });
}

export function useSuggestConfig() {
  return useMutation({
    mutationFn: (body: { repoPath: string }) => api.suggestConfig(body),
  });
}

export function useStartConfigPreview() {
  return useMutation({
    mutationFn: (body: { repoPath: string; content: string; serviceName?: string }) =>
      api.startConfigPreview(body),
  });
}

export function useStopConfigPreview() {
  return useMutation({
    mutationFn: (body: { previewId: string }) => api.stopConfigPreview(body),
  });
}

export function useSaveConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { repoPath: string; content: string; saveMode: "repo" | "global" }) =>
      api.saveConfig(body),
    onSuccess: () => {
      invalidateAppQueries(queryClient);
    },
  });
}

export function createApiEventSource(since?: number) {
  return new EventSource(api.getEventsUrl(since));
}

export function createLogEventSource(
  repoID: string,
  envID: string,
  options: {
    repoPath?: string;
    service?: string | null;
    lines?: number;
  } = {},
) {
  return new EventSource(
    api.getLogStreamUrl(repoID, envID, {
      repoPath: options.repoPath,
      service: options.service ?? undefined,
      lines: options.lines,
    }),
  );
}

function invalidateAppQueries(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ["daemon"] });
  void queryClient.invalidateQueries({ queryKey: ["envs"] });
  void queryClient.invalidateQueries({ queryKey: ["infra"] });
  void queryClient.invalidateQueries({ queryKey: ["web", "repos"] });
}
