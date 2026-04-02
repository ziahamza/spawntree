import { createFileRoute, Link } from '@tanstack/react-router'
import { ChevronRight, GitBranch, Folder } from 'lucide-react'
import { useWebRepoDetail, useDeleteClone, useRelinkClone } from '../lib/api'
import { WarningBanner } from '../components/WarningBanner'
import { StatusDot } from '../components/StatusDot'
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

function WorktreeRow({ wt, slug }: { wt: Worktree; slug: string }) {
  return (
    <div className="pl-6 border-l border-border-subtle ml-4 py-1">
      <div className="flex items-center gap-2 py-1 text-xs text-muted">
        <GitBranch className="w-3 h-3 flex-shrink-0" />
        <span className="font-mono truncate" title={wt.branch}>
          {wt.branch}
        </span>
        <span className="text-muted/50 font-mono truncate hidden sm:block" title={wt.path}>
          {wt.path}
        </span>
      </div>
      {wt.envs.length > 0 && (
        <div className="mt-1 space-y-1">
          {wt.envs.map((env) => (
            <EnvRow key={env.id} env={env} slug={slug} />
          ))}
        </div>
      )}
    </div>
  )
}

function EnvRow({ env, slug }: { env: EnvListItem; slug: string }) {
  return (
    <Link
      to="/repos/$slug/envs/$envId"
      params={{ slug, envId: env.id }}
      className="flex items-center gap-2 py-1.5 px-3 rounded-md text-xs hover:bg-surface transition-colors"
    >
      <StatusDot status={envStatusDot(env.status)} />
      <span className="text-foreground font-medium">{env.name}</span>
      <span className="text-muted capitalize">{env.status}</span>
      <span className="text-muted ml-auto">{env.serviceCount} svc</span>
    </Link>
  )
}

function CloneSection({
  clone,
  slug,
  onRelink,
  onRemove,
  relinkingId,
  removingId,
}: {
  clone: Clone
  slug: string
  onRelink: (id: string) => void
  onRemove: (id: string) => void
  relinkingId: string | null
  removingId: string | null
}) {
  return (
    <div className="rounded-lg border border-border bg-surface mb-4 overflow-hidden">
      {/* Clone header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
        <Folder className="w-4 h-4 text-muted flex-shrink-0" />
        <span className="font-mono text-sm text-foreground truncate flex-1" title={clone.path}>
          {clone.path}
        </span>
        {clone.missing && (
          <span className="text-xs text-orange bg-orange/10 border border-orange/30 rounded px-2 py-0.5 flex-shrink-0">
            missing
          </span>
        )}
      </div>

      {/* Warning banner for missing clone */}
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

      {/* Worktrees */}
      {!clone.missing && clone.worktrees.length > 0 && (
        <div className="p-3 space-y-1">
          {clone.worktrees.map((wt, i) => (
            <WorktreeRow key={i} wt={wt} slug={slug} />
          ))}
        </div>
      )}

      {!clone.missing && clone.worktrees.length === 0 && (
        <div className="px-4 py-3 text-xs text-muted">No worktrees found</div>
      )}
    </div>
  )
}

function RepoDetail() {
  const { slug } = Route.useParams()
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
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1 text-xs text-muted mb-6">
        <Link to="/" className="hover:text-foreground transition-colors">
          Home
        </Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-foreground font-medium">{repo.name}</span>
      </nav>

      {/* Title */}
      <div className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-foreground">{repo.name}</h1>
        {repo.remoteUrl && (
          <p className="text-xs text-muted font-mono mt-1">{repo.remoteUrl}</p>
        )}
      </div>

      {/* Summary warning for missing clones */}
      {missingClones.length > 0 && (
        <div className="mb-4 text-xs text-orange bg-warning-bg border border-warning-border rounded-md px-3 py-2">
          {missingClones.length} clone{missingClones.length !== 1 ? 's' : ''} missing from disk
        </div>
      )}

      {/* Clones */}
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
            />
          ))
        )}
      </div>
    </div>
  )
}
