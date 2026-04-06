import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ChevronRight, Folder, GitBranch, Play, Settings2 } from 'lucide-react'
import { useCreateEnv, useWebRepoDetail, useDeleteClone, useRelinkClone, deriveEnvStatus } from '../lib/api'
import { WarningBanner } from '../components/WarningBanner'
import { StatusDot } from '../components/StatusDot'
import { AddConfigDialog } from '../components/AddConfigDialog'
import type { Status } from '../components/StatusDot'
import type { Clone, Worktree, EnvListItem } from '../lib/api'

export const Route = createFileRoute('/repos/$slug')({
  component: RepoDetail,
})

function envStatusDot(status: string): Status {
  if (status === 'running') return 'running'
  if (status === 'starting') return 'starting'
  if (status === 'crashed') return 'crashed'
  return 'stopped'
}

function StartButton({
  path,
  slug,
  onNeedConfig,
}: {
  path: string
  slug: string
  onNeedConfig: (path: string) => void
}) {
  const navigate = useNavigate()
  const createEnv = useCreateEnv()

  async function handleStart() {
    try {
      const env = await createEnv.mutateAsync({ repoPath: path })
      navigate({
        to: '/repos/$slug/envs/$envId',
        params: { slug, envId: env.envId },
        search: { repoPath: env.repoPath },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/config file not found|no such file|spawntree\.yaml/i.test(message)) {
        onNeedConfig(path)
        return
      }
      window.alert(message)
    }
  }

  return (
    <button
      type="button"
      onClick={handleStart}
      disabled={createEnv.isPending}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-muted hover:text-foreground hover:border-foreground/30 transition-colors disabled:opacity-50 min-h-[32px]"
    >
      <Play className="w-3 h-3" />
      {createEnv.isPending ? 'Starting…' : 'Start'}
    </button>
  )
}

function AddConfigButton({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(path)}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-muted hover:text-foreground hover:border-foreground/30 transition-colors min-h-[32px]"
    >
      <Settings2 className="w-3 h-3" />
      Add Config
    </button>
  )
}

function EnvRow({ env, slug }: { env: EnvListItem; slug: string }) {
  const status = deriveEnvStatus(env)
  const serviceCount = env.services?.length ?? 0
  return (
    <Link
      to="/repos/$slug/envs/$envId"
      params={{ slug, envId: env.envId }}
      search={{ repoPath: env.repoPath }}
      className="flex items-center gap-2 py-1.5 px-3 rounded-md text-xs hover:bg-surface transition-colors"
    >
      <StatusDot status={envStatusDot(status)} />
      <span className="text-foreground font-medium">{env.envId}</span>
      <span className="text-muted capitalize">{status}</span>
      <span className="text-muted ml-auto">{serviceCount} svc</span>
    </Link>
  )
}

function WorktreeRow({ wt, slug, onOpenConfig }: { wt: Worktree; slug: string; onOpenConfig: (path: string) => void }) {
  return (
    <div className="pl-6 border-l border-border-subtle ml-4 py-2">
      <div className="flex items-start gap-2 py-1 text-xs text-muted">
        <GitBranch className="w-3 h-3 flex-shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="font-mono truncate text-foreground" title={wt.path}>
            {wt.path}
          </div>
          <div className="font-mono truncate" title={wt.branch}>
            {wt.branch}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <AddConfigButton path={wt.path} onOpen={onOpenConfig} />
          <StartButton path={wt.path} slug={slug} onNeedConfig={onOpenConfig} />
        </div>
      </div>
      {wt.envs.length > 0 ? (
        <div className="mt-1 space-y-1">
          {wt.envs.map((env) => (
            <EnvRow key={`${wt.path}:${env.envId}:${env.repoPath}`} env={env} slug={slug} />
          ))}
        </div>
      ) : (
        <div className="mt-1 px-3 py-1 text-[11px] text-muted">No envs running from this worktree</div>
      )}
    </div>
  )
}

function CloneSection({
  clone,
  slug,
  onRelink,
  onRemove,
  relinkingId,
  removingId,
  onOpenConfig,
}: {
  clone: Clone
  slug: string
  onRelink: (id: string) => void
  onRemove: (id: string) => void
  relinkingId: string | null
  removingId: string | null
  onOpenConfig: (path: string) => void
}) {
  return (
    <div className="rounded-lg border border-border bg-surface mb-4 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
        <Folder className="w-4 h-4 text-muted flex-shrink-0" />
        <span className="font-mono text-sm text-foreground truncate flex-1" title={clone.path}>
          {clone.path}
        </span>
        {!clone.missing && (
          <div className="flex items-center gap-2">
            <AddConfigButton path={clone.path} onOpen={onOpenConfig} />
            <StartButton path={clone.path} slug={slug} onNeedConfig={onOpenConfig} />
          </div>
        )}
        {clone.missing && (
          <span className="text-xs text-orange bg-orange/10 border border-orange/30 rounded px-2 py-0.5 flex-shrink-0">
            missing
          </span>
        )}
      </div>

      {clone.missing && (
        <div className="p-3">
          <WarningBanner
            cloneID={clone.id}
            path={clone.path}
            onRelink={onRelink}
            onRemove={onRemove}
            isRelinking={relinkingId === clone.id}
            isRemoving={removingId === clone.id}
          />
        </div>
      )}

      {!clone.missing && clone.envs.length > 0 && (
        <div className="p-3 border-b border-border-subtle">
          <div className="text-[11px] text-muted uppercase tracking-wider mb-2">Root envs</div>
          <div className="space-y-1">
            {clone.envs.map((env) => (
              <EnvRow key={`${clone.path}:${env.envId}:${env.repoPath}`} env={env} slug={slug} />
            ))}
          </div>
        </div>
      )}

      {!clone.missing && clone.worktrees.length > 0 && (
        <div className="p-3 space-y-1">
          {clone.worktrees.map((wt) => (
            <WorktreeRow key={wt.path} wt={wt} slug={slug} onOpenConfig={onOpenConfig} />
          ))}
        </div>
      )}

      {!clone.missing && clone.envs.length === 0 && clone.worktrees.length === 0 && (
        <div className="px-4 py-3 text-xs text-muted">No worktrees or envs found</div>
      )}
    </div>
  )
}

function RepoDetail() {
  const { slug } = Route.useParams()
  const [configPath, setConfigPath] = useState<string | null>(null)
  const { data: repo, isLoading, error } = useWebRepoDetail(slug)
  const relinkClone = useRelinkClone()
  const deleteClone = useDeleteClone()

  function handleRelink(cloneID: string) {
    const newPath = window.prompt('Enter new path for this clone:')
    if (!newPath) return
    relinkClone.mutate({ repoSlug: slug, cloneID, newPath })
  }

  function handleRemove(cloneID: string) {
    if (!window.confirm('Remove this clone from spawntree?')) return
    deleteClone.mutate({ repoSlug: slug, cloneID })
  }

  function handleOpenConfig(path: string) {
    setConfigPath(path)
  }

  if (isLoading) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="h-6 w-48 bg-surface rounded animate-pulse mb-6" />
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-24 rounded-lg bg-surface border border-border animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  if (error || !repo) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <p className="text-red text-sm">{error?.message ?? 'Repo not found'}</p>
      </div>
    )
  }

  const missingClones = repo.clones.filter((c) => c.missing)

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <nav className="flex items-center gap-1 text-xs text-muted mb-6">
        <Link to="/" className="hover:text-foreground transition-colors">
          Home
        </Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-foreground font-medium">{repo.name}</span>
      </nav>

      <div className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-foreground">{repo.name}</h1>
        {repo.remoteUrl && (
          <p className="text-xs text-muted font-mono mt-1">{repo.remoteUrl}</p>
        )}
      </div>

      {missingClones.length > 0 && (
        <div className="mb-4 text-xs text-orange bg-warning-bg border border-warning-border rounded-md px-3 py-2">
          {missingClones.length} clone{missingClones.length !== 1 ? 's' : ''} missing from disk
        </div>
      )}

      <div>
        <h2 className="text-xs font-medium text-muted uppercase tracking-wider mb-3">
          Clones ({repo.clones.length})
        </h2>
        {repo.clones.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface px-4 py-6 text-center text-sm text-muted">
            No clones found for this repo
          </div>
        ) : (
          repo.clones.map((clone) => (
            <CloneSection
              key={clone.id}
              clone={clone}
              slug={slug}
              onRelink={handleRelink}
              onRemove={handleRemove}
              relinkingId={relinkClone.isPending ? (relinkClone.variables?.cloneID ?? null) : null}
              removingId={deleteClone.isPending ? (deleteClone.variables?.cloneID ?? null) : null}
              onOpenConfig={handleOpenConfig}
            />
          ))
        )}
      </div>

      <AddConfigDialog
        open={!!configPath}
        repoPath={configPath}
        onOpenChange={(open) => {
          if (!open) setConfigPath(null)
        }}
      />
    </div>
  )
}
