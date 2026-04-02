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
  status: 'running' | 'stopped' | 'crashed' | 'starting'
  command?: string
  image?: string
  port?: number
  proxyURL?: string
  uptime?: number
  lastLog?: string
}

export interface Env {
  id: string
  repoID: string
  name: string
  status: 'running' | 'stopped' | 'crashed' | 'starting'
  services: Service[]
  configPath: string
  createdAt: string
  updatedAt: string
}

export interface EnvListItem {
  id: string
  repoID: string
  name: string
  status: 'running' | 'stopped' | 'crashed' | 'starting'
  serviceCount: number
  configPath: string
  updatedAt: string
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
  worktrees: Worktree[]
}

export interface Worktree {
  path: string
  branch: string
  envs: EnvListItem[]
}

export interface WebRepo {
  slug: string
  name: string
  remoteUrl?: string
  cloneCount: number
  activeEnvCount: number
  overallStatus: 'running' | 'stopped' | 'crashed' | 'offline'
  updatedAt: string
}

export interface WebRepoDetail {
  slug: string
  name: string
  remoteUrl?: string
  clones: Clone[]
  worktrees: Record<string, Worktree[]>
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

export function useEnvDetail(repoID: string, envID: string) {
  return useQuery<Env>({
    queryKey: ['repos', repoID, 'envs', envID],
    queryFn: async () => {
      const res = await apiFetch<{ env: Env }>(`/repos/${repoID}/envs/${envID}`)
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

export function useWebRepoDetail(slug: string) {
  return useQuery<WebRepoDetail>({
    queryKey: ['web', 'repos', slug],
    queryFn: async () => {
      const res = await apiFetch<{ repo: WebRepo; clones: Clone[]; worktrees: Record<string, Worktree[]> }>(`/web/repos/${slug}`)
      return {
        slug: res.repo.slug,
        name: res.repo.name,
        remoteUrl: res.repo.remoteUrl,
        clones: res.clones ?? [],
        worktrees: res.worktrees ?? {},
      }
    },
    refetchInterval: 5000,
    enabled: !!slug,
  })
}

// ─── Mutation hooks ────────────────────────────────────────────────────────────

export function useCreateEnv() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { configPath: string; envName?: string }) =>
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
    mutationFn: ({ repoID, envID }: { repoID: string; envID: string }) =>
      apiFetch<void>(`/repos/${repoID}/envs/${envID}/down`, { method: 'POST' }),
    onSuccess: (_data, { repoID, envID }) => {
      qc.invalidateQueries({ queryKey: ['repos', repoID, 'envs', envID] })
      qc.invalidateQueries({ queryKey: ['repos', repoID, 'envs'] })
      qc.invalidateQueries({ queryKey: ['envs'] })
    },
  })
}

export function useDeleteEnv() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ repoID, envID }: { repoID: string; envID: string }) =>
      apiFetch<void>(`/repos/${repoID}/envs/${envID}`, { method: 'DELETE' }),
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
  repo: WebRepo
  clone: { id: string; repoId: string; path: string; status: string }
  remotes?: { name: string; url: string }[]
}

export function useAddFolder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { path: string; remoteName?: string }) =>
      apiFetch<AddFolderResult>('/web/repos/add', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['web', 'repos'] })
    },
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
