import { useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import * as Collapsible from '@radix-ui/react-collapsible'
import { ChevronRight, FolderOpen, GitBranch } from 'lucide-react'
import { useWebRepos, useEnvs } from '../lib/api'
import { StatusDot } from './StatusDot'
import type { Status } from './StatusDot'

function chevronClass(open: boolean) {
  return `w-3 h-3 text-muted transition-transform duration-150 ${open ? 'rotate-90' : ''}`
}

interface RepoTreeProps {
  onNavigate?: () => void
}

export function RepoTree({ onNavigate }: RepoTreeProps) {
  const { data: repos, isLoading } = useWebRepos()
  const { data: envs } = useEnvs()
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname

  const [openRepos, setOpenRepos] = useState<Set<string>>(new Set())

  function toggleRepo(slug: string) {
    setOpenRepos((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }

  if (isLoading) {
    return (
      <div className="p-3 text-xs text-muted space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-4 bg-surface rounded animate-pulse" />
        ))}
      </div>
    )
  }

  if (!repos || repos.length === 0) {
    return (
      <div className="p-3 text-xs text-muted">
        <p className="mb-2">No repos linked yet.</p>
        <p>Click <strong>+ Add</strong> to link your first repo.</p>
      </div>
    )
  }

  return (
    <nav className="py-1">
      {repos.map((repo) => {
        const isOpen = openRepos.has(repo.slug)
        const repoPath = `/repos/${repo.slug}`
        const isRepoActive = currentPath.startsWith(repoPath)

        // Build env list for this repo from the flat env list (keyed by repoID)
        // Since WebRepo only has counts, we rely on activeEnvCount for status.
        const repoStatus: Status =
          repo.overallStatus === 'running'
            ? 'running'
            : repo.overallStatus === 'crashed'
              ? 'crashed'
              : repo.overallStatus === 'offline'
                ? 'offline'
                : 'stopped'

        const repoEnvs = envs?.filter((e) => e.repoID === repo.slug) ?? []

        return (
          <Collapsible.Root
            key={repo.slug}
            open={isOpen}
            onOpenChange={() => toggleRepo(repo.slug)}
          >
            <div
              className={`flex items-center gap-1 px-2 py-1 rounded-md mx-1 group ${
                isRepoActive ? 'bg-blue/10' : 'hover:bg-surface'
              }`}
            >
              <Collapsible.Trigger asChild>
                <button
                  className="flex items-center gap-1 flex-1 min-w-0 text-left focus:outline-none"
                  onClick={() => toggleRepo(repo.slug)}
                >
                  <ChevronRight className={chevronClass(isOpen)} />
                  <StatusDot status={repoStatus} className="flex-shrink-0" />
                  <Link
                    to="/repos/$slug"
                    params={{ slug: repo.slug }}
                    className={`truncate text-xs flex-1 text-left ${
                      isRepoActive ? 'text-blue font-medium' : 'text-foreground hover:text-foreground'
                    }`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onNavigate?.()
                    }}
                  >
                    {repo.name}
                  </Link>
                </button>
              </Collapsible.Trigger>
              {repo.activeEnvCount > 0 && (
                <span className="text-xs text-muted ml-1 flex-shrink-0">
                  {repo.activeEnvCount}
                </span>
              )}
            </div>

            <Collapsible.Content>
              <div className="ml-4 border-l border-border-subtle pl-2 my-0.5">
                {repoEnvs.length === 0 ? (
                  <div className="px-2 py-1 text-xs text-muted flex items-center gap-1">
                    <GitBranch className="w-3 h-3" />
                    <span>No envs</span>
                  </div>
                ) : (
                  repoEnvs.map((env) => {
                    const envPath = `/repos/${repo.slug}/envs/${env.id}`
                    const isEnvActive = currentPath === envPath
                    const envStatus: Status =
                      env.status === 'running'
                        ? 'running'
                        : env.status === 'starting'
                          ? 'starting'
                          : env.status === 'crashed'
                            ? 'crashed'
                            : 'stopped'

                    return (
                      <Link
                        key={env.id}
                        to="/repos/$slug/envs/$envId"
                        params={{ slug: repo.slug, envId: env.id }}
                        onClick={onNavigate}
                        className={`flex items-center gap-2 px-2 py-1 rounded-md text-xs transition-colors ${
                          isEnvActive
                            ? 'bg-blue/10 text-blue'
                            : 'text-muted hover:text-foreground hover:bg-surface'
                        }`}
                      >
                        <StatusDot status={envStatus} className="flex-shrink-0" />
                        <span className="truncate">{env.name}</span>
                      </Link>
                    )
                  })
                )}
              </div>
            </Collapsible.Content>
          </Collapsible.Root>
        )
      })}

      {/* Infra link */}
      <div className="mt-2 pt-2 border-t border-border mx-2">
        <Link
          to="/infra"
          onClick={onNavigate}
          className={`flex items-center gap-2 px-2 py-1 rounded-md text-xs transition-colors ${
            currentPath === '/infra'
              ? 'bg-blue/10 text-blue'
              : 'text-muted hover:text-foreground hover:bg-surface'
          }`}
        >
          <FolderOpen className="w-3 h-3 flex-shrink-0" />
          <span>Infrastructure</span>
        </Link>
      </div>
    </nav>
  )
}
