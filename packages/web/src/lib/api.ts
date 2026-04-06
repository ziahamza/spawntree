import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DaemonInfo {
  version: string
  uptime: number
  repoCount: number
  activeEnvs: number
}

export interface Service {
  name: string
  type: 'process' | 'postgres' | 'redis' | 'container' | 'external'
  status: 'running' | 'stopped' | 'failed' | 'starting'
  port?: number
  pid?: number
  url?: string
  containerId?: string
}

// Matches Go EnvInfo struct JSON tags
export interface Env {
  envId: string
  repoId: string
  repoPath: string
  branch: string
  basePort: number
  createdAt: string
  services: Service[]
}

// Alias fields for frontend convenience (mapped from Env)
export interface EnvListItem {
  envId: string
  repoId: string
  repoPath: string
  branch: string
  basePort: number
  createdAt: string
  services: Service[]
}

export interface InfraStatus {
  postgres: {
    status: 'running' | 'stopped' | 'crashed'
    version?: string
    port?: number
    containerID?: string
  }
  redis: {
    status: 'running' | 'stopped' | 'crashed'
    port?: number
    containerID?: string
  }
}

export interface Clone {
  id: string
  path: string
  branch?: string
  missing: boolean
  git?: GitPathInfo
  envs: EnvListItem[]
  worktrees: Worktree[]
}

export interface Worktree {
  path: string
  branch: string
  git?: GitPathInfo
  envs: EnvListItem[]
}

export interface GitPathInfo {
  branch: string
  headRef: string
  activityAt: string
  insertions: number
  deletions: number
  hasUncommittedChanges: boolean
  isMergedIntoBase: boolean
  isBaseOutOfDate: boolean
  isBaseBranch: boolean
  canArchive: boolean
  baseRefName?: string
}

export interface WebRepo {
  slug: string
  name: string
  remoteUrl?: string
  cloneCount: number
  activeEnvCount: number
  overallStatus: 'running' | 'starting' | 'stopped' | 'crashed' | 'offline'
  updatedAt: string
}

export interface WebRepoDetail {
  slug: string
  name: string
  remoteUrl?: string
  clones: Clone[]
}

export function deriveEnvStatus(env: EnvListItem): 'running' | 'starting' | 'crashed' | 'stopped' {
  if (!env.services?.length) return 'stopped'
  if (env.services.some(s => s.status === 'running')) return 'running'
  if (env.services.some(s => s.status === 'starting')) return 'starting'
  if (env.services.some(s => s.status === 'failed')) return 'crashed'
  return 'stopped'
}

// ─── Fetch helpers ─────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }
  // 204 No Content
  if (res.status === 204) return undefined as unknown as T
  return res.json() as Promise<T>
}

// ─── Query hooks ───────────────────────────────────────────────────────────────

export function useDaemonInfo() {
  return useQuery<DaemonInfo>({
    queryKey: ['daemon'],
    queryFn: () => apiFetch<DaemonInfo>('/daemon'),
    refetchInterval: 5000,
  })
}

export function useEnvs() {
  return useQuery<EnvListItem[]>({
    queryKey: ['envs'],
    queryFn: async () => {
      const res = await apiFetch<{ envs: EnvListItem[] }>('/envs')
      return res.envs ?? []
    },
    refetchInterval: 5000,
  })
}

export function useRepoEnvs(repoID: string) {
  return useQuery<EnvListItem[]>({
    queryKey: ['repos', repoID, 'envs'],
    queryFn: async () => {
      const res = await apiFetch<{ envs: EnvListItem[] }>(`/repos/${repoID}/envs`)
      return res.envs ?? []
    },
    refetchInterval: 5000,
    enabled: !!repoID,
  })
}

export function useEnvDetail(repoID: string, envID: string, repoPath?: string) {
  return useQuery<Env>({
    queryKey: ['repos', repoID, 'envs', envID, repoPath],
    queryFn: async () => {
      const res = await apiFetch<{ env: Env }>(
        `/repos/${repoID}/envs/${envID}${repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : ''}`,
      )
      return res.env
    },
    refetchInterval: 5000,
    enabled: !!repoID && !!envID,
  })
}

export function useInfra() {
  return useQuery<InfraStatus>({
    queryKey: ['infra'],
    queryFn: () => apiFetch<InfraStatus>('/infra'),
    refetchInterval: 5000,
  })
}

export function useWebRepos() {
  return useQuery<WebRepo[]>({
    queryKey: ['web', 'repos'],
    queryFn: async () => {
      const res = await apiFetch<{ repos: WebRepo[] }>('/web/repos')
      return res.repos ?? []
    },
    refetchInterval: 5000,
  })
}

export function useWebRepoDetail(slug: string, enabled = true) {
  return useQuery<WebRepoDetail>({
    queryKey: ['web', 'repos', slug],
    queryFn: async () => {
      const res = await apiFetch<{
        repo: WebRepo
        clones: Array<{ id: string; repoId: string; path: string; status: string; lastSeenAt: string }>
        worktrees: Record<string, Array<{ path: string; branch: string; headRef: string }>>
        envs: EnvListItem[]
        gitPaths: Record<string, GitPathInfo>
      }>(`/web/repos/${slug}`)
      const envs = res.envs ?? []
      const gitPaths = res.gitPaths ?? {}
      const activityScore = (path: string) => Date.parse(gitPaths[path]?.activityAt ?? '') || 0
      // Transform backend shapes to frontend types
      const clones: Clone[] = (res.clones ?? [])
        .map((c) => ({
          id: c.id,
          path: c.path,
          missing: c.status === 'missing',
          git: gitPaths[c.path],
          envs: envs.filter((env) => env.repoPath === c.path),
          worktrees: (res.worktrees?.[c.id] ?? [])
            .filter((wt) => wt.path !== c.path)
            .map((wt) => ({
              path: wt.path,
              branch: wt.branch || gitPaths[wt.path]?.branch || 'detached',
              git: gitPaths[wt.path],
              envs: envs.filter((env) => env.repoPath === wt.path),
            }))
            .sort((a, b) => activityScore(b.path) - activityScore(a.path)),
        }))
        .sort((a, b) => activityScore(b.path) - activityScore(a.path))
      return {
        slug: res.repo.slug,
        name: res.repo.name,
        remoteUrl: res.repo.remoteUrl,
        clones,
      }
    },
    refetchInterval: 5000,
    enabled: !!slug && enabled,
  })
}

// ─── Mutation hooks ────────────────────────────────────────────────────────────

export function useCreateEnv() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { repoPath: string; configFile?: string; envId?: string }) =>
      apiFetch<Env>('/envs', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['envs'] })
      qc.invalidateQueries({ queryKey: ['web', 'repos'] })
    },
  })
}

export function useStopEnv() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ repoID, envID, repoPath }: { repoID: string; envID: string; repoPath?: string }) =>
      apiFetch<void>(
        `/repos/${repoID}/envs/${envID}/down${repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : ''}`,
        { method: 'POST' },
      ),
    onSuccess: (_data, { repoID, envID }) => {
      qc.invalidateQueries({ queryKey: ['repos', repoID, 'envs', envID] })
      qc.invalidateQueries({ queryKey: ['repos', repoID, 'envs'] })
      qc.invalidateQueries({ queryKey: ['envs'] })
      qc.invalidateQueries({ queryKey: ['web', 'repos'] })
    },
  })
}

export function useDeleteEnv() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ repoID, envID, repoPath }: { repoID: string; envID: string; repoPath?: string }) =>
      apiFetch<void>(`/repos/${repoID}/envs/${envID}${repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : ''}`, {
        method: 'DELETE',
      }),
    onSuccess: (_data, { repoID }) => {
      qc.invalidateQueries({ queryKey: ['repos', repoID, 'envs'] })
      qc.invalidateQueries({ queryKey: ['envs'] })
      qc.invalidateQueries({ queryKey: ['web', 'repos'] })
    },
  })
}

export function useDiscover() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => apiFetch<void>('/discover', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['web', 'repos'] })
      qc.invalidateQueries({ queryKey: ['envs'] })
    },
  })
}

export interface AddFolderResult {
  repo?: WebRepo
  clone?: { id: string; repoId: string; path: string; status: string }
  watchedPath?: { path: string; scanChildren: boolean }
  importedCount?: number
  remotes?: { name: string; url: string }[]
}

export interface AddFolderProbeResult {
  path: string
  exists: boolean
  isGitRepo: boolean
  canScanChildren: boolean
  childRepoCount: number
}

export interface ConfigTestResult {
  ok: boolean
  serviceNames: string[]
  services: ConfigTestServiceResult[]
}

export interface ConfigSignal {
  kind: string
  label: string
  detail: string
}

export interface ConfigServiceSuggestion {
  id: string
  name: string
  type: 'process' | 'container' | 'postgres' | 'redis'
  command?: string
  image?: string
  port?: number
  healthcheckUrl?: string
  dependsOn?: string[]
  source?: string
  reason?: string
  selected: boolean
}

export interface ConfigTestServiceResult {
  name: string
  type: string
  status: string
  url?: string
  previewUrl?: string
  probeOk: boolean
  probeStatusCode?: number
  probeBodyPreview?: string
  probeError?: string
  logs: string[]
}

export interface ConfigPreviewResult {
  ok: boolean
  previewId: string
  env: Env
}

export interface ConfigSuggestResult {
  signals: ConfigSignal[]
  services: ConfigServiceSuggestion[]
}

export interface ConfigSaveResult {
  ok: boolean
  configPath: string
  saveMode: 'repo' | 'global'
}

export function useAddFolder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { path: string; remoteName?: string; scanChildren?: boolean }) =>
      apiFetch<AddFolderResult>('/web/repos/add', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['web', 'repos'] })
    },
  })
}

export function useProbeAddPath() {
  return useMutation({
    mutationFn: (body: { path: string }) =>
      apiFetch<AddFolderProbeResult>('/web/repos/probe', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  })
}

export function useRelinkClone() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      repoSlug,
      cloneID,
      newPath,
    }: {
      repoSlug: string
      cloneID: string
      newPath: string
    }) =>
      apiFetch<Clone>(`/web/repos/${repoSlug}/clones/${cloneID}`, {
        method: 'PATCH',
        body: JSON.stringify({ path: newPath }),
      }),
    onSuccess: (_data, { repoSlug }) => {
      qc.invalidateQueries({ queryKey: ['web', 'repos', repoSlug] })
      qc.invalidateQueries({ queryKey: ['web', 'repos'] })
    },
  })
}

export function useDeleteClone() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ repoSlug, cloneID }: { repoSlug: string; cloneID: string }) =>
      apiFetch<void>(`/web/repos/${repoSlug}/clones/${cloneID}`, { method: 'DELETE' }),
    onSuccess: (_data, { repoSlug }) => {
      qc.invalidateQueries({ queryKey: ['web', 'repos', repoSlug] })
      qc.invalidateQueries({ queryKey: ['web', 'repos'] })
    },
  })
}

export function useArchiveWorktree() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ repoSlug, path }: { repoSlug: string; path: string }) =>
      apiFetch<void>(`/web/repos/${repoSlug}/worktrees/archive`, {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    onSuccess: (_data, { repoSlug }) => {
      qc.invalidateQueries({ queryKey: ['web', 'repos', repoSlug] })
      qc.invalidateQueries({ queryKey: ['web', 'repos'] })
      qc.invalidateQueries({ queryKey: ['envs'] })
    },
  })
}

export function useTestConfig() {
  return useMutation({
    mutationFn: (body: { repoPath: string; content: string }) =>
      apiFetch<ConfigTestResult>('/web/config/test', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  })
}

export function useSuggestConfig() {
  return useMutation({
    mutationFn: (body: { repoPath: string }) =>
      apiFetch<ConfigSuggestResult>('/web/config/suggest', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  })
}

export function useStartConfigPreview() {
  return useMutation({
    mutationFn: (body: { repoPath: string; content: string; serviceName?: string }) =>
      apiFetch<ConfigPreviewResult>('/web/config/preview/start', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  })
}

export function useStopConfigPreview() {
  return useMutation({
    mutationFn: (body: { previewId: string }) =>
      apiFetch<void>('/web/config/preview/stop', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  })
}

export function useSaveConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { repoPath: string; content: string; saveMode: 'repo' | 'global' }) =>
      apiFetch<ConfigSaveResult>('/web/config/save', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['web', 'repos'] })
      qc.invalidateQueries({ queryKey: ['envs'] })
    },
  })
}
