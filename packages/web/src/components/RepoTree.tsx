import * as Collapsible from "@radix-ui/react-collapsible";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight, FolderOpen, FolderTree, GitBranch, MessagesSquare } from "lucide-react";
import { useState } from "react";
import { deriveEnvStatus, useWebRepoTree, useWebRepos } from "../lib/api";
import type { Clone, EnvListItem, Worktree } from "../lib/api";
import { StatusDot } from "./StatusDot";
import type { Status } from "./StatusDot";

function chevronClass(open: boolean) {
  return `w-3 h-3 text-muted transition-transform duration-150 ${open ? "rotate-90" : ""}`;
}

function repoStatus(status: string): Status {
  if (status === "running") return "running";
  if (status === "starting") return "starting";
  if (status === "crashed") return "crashed";
  if (status === "offline") return "offline";
  return "stopped";
}

function envStatus(env: EnvListItem): Status {
  return deriveEnvStatus(env);
}

function EnvNode({
  slug,
  env,
  currentPath,
  onNavigate,
}: {
  slug: string;
  env: EnvListItem;
  currentPath: string;
  onNavigate?: () => void;
}) {
  const envPath = `/repos/${slug}/envs/${env.envId}`;
  const isActive = currentPath === envPath;

  return (
    <Link
      to="/repos/$slug/envs/$envId"
      params={{ slug, envId: env.envId }}
      search={{ repoPath: env.repoPath }}
      onClick={onNavigate}
      className={`flex items-center gap-2 px-2 py-1 rounded-md text-xs transition-colors ${
        isActive ? "bg-blue/10 text-blue" : "text-muted hover:text-foreground hover:bg-surface"
      }`}
      title={env.repoPath}
    >
      <StatusDot status={envStatus(env)} className="flex-shrink-0" />
      <span className="truncate">{env.envId}</span>
    </Link>
  );
}

function WorktreeNode({
  slug,
  worktree,
  currentPath,
  onNavigate,
}: {
  slug: string;
  worktree: Worktree;
  currentPath: string;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted hover:bg-surface">
        <Collapsible.Trigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 flex-shrink-0"
            onClick={() => setOpen((prev) => !prev)}
          >
            <ChevronRight className={chevronClass(open)} />
            <GitBranch className="w-3 h-3 flex-shrink-0" />
          </button>
        </Collapsible.Trigger>
        <Link to="/repos/$slug" params={{ slug }} onClick={onNavigate} className="min-w-0 flex-1">
          <div className="truncate text-foreground" title={worktree.path}>
            {worktree.path}
          </div>
          <div className="text-[11px] text-muted truncate" title={worktree.branch}>
            {worktree.branch || "detached"}
          </div>
        </Link>
        {worktree.envs.length > 0 && (
          <span className="text-[11px] text-muted flex-shrink-0">{worktree.envs.length}</span>
        )}
      </div>

      <Collapsible.Content>
        <div className="ml-4 border-l border-border-subtle pl-2 my-0.5 space-y-0.5">
          {worktree.envs.length === 0 ? (
            <div className="px-2 py-1 text-[11px] text-muted">No envs</div>
          ) : (
            worktree.envs.map((env) => (
              <EnvNode
                key={`${worktree.path}:${env.envId}:${env.repoPath}`}
                slug={slug}
                env={env}
                currentPath={currentPath}
                onNavigate={onNavigate}
              />
            ))
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function CloneNode({
  slug,
  clone,
  currentPath,
  onNavigate,
}: {
  slug: string;
  clone: Clone;
  currentPath: string;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(true);
  const hasChildren = clone.envs.length > 0 || clone.worktrees.length > 0;

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted hover:bg-surface">
        <Collapsible.Trigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 flex-shrink-0"
            onClick={() => setOpen((prev) => !prev)}
          >
            <ChevronRight className={chevronClass(open)} />
            <FolderTree className="w-3 h-3 flex-shrink-0" />
          </button>
        </Collapsible.Trigger>
        <Link
          to="/repos/$slug"
          params={{ slug }}
          onClick={onNavigate}
          className="min-w-0 flex-1"
          title={clone.path}
        >
          <div className="truncate text-foreground">{clone.path}</div>
        </Link>
        {clone.missing && <span className="text-[11px] text-orange flex-shrink-0">missing</span>}
      </div>

      <Collapsible.Content>
        <div className="ml-4 border-l border-border-subtle pl-2 my-0.5 space-y-0.5">
          {clone.envs.map((env) => (
            <EnvNode
              key={`${clone.path}:${env.envId}:${env.repoPath}`}
              slug={slug}
              env={env}
              currentPath={currentPath}
              onNavigate={onNavigate}
            />
          ))}

          {clone.worktrees.map((worktree) => (
            <WorktreeNode
              key={worktree.path}
              slug={slug}
              worktree={worktree}
              currentPath={currentPath}
              onNavigate={onNavigate}
            />
          ))}

          {!clone.missing && !hasChildren && (
            <div className="px-2 py-1 text-[11px] text-muted">No worktrees or envs</div>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function RepoNode({
  slug,
  name,
  overallStatus,
  activeEnvCount,
  currentPath,
  onNavigate,
  isOpen,
  onToggle,
}: {
  slug: string;
  name: string;
  overallStatus: string;
  activeEnvCount: number;
  currentPath: string;
  onNavigate?: () => void;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const repoPath = `/repos/${slug}`;
  const isRepoActive = currentPath.startsWith(repoPath);
  const { data: repo, isLoading } = useWebRepoTree(slug, isOpen);

  return (
    <Collapsible.Root open={isOpen} onOpenChange={onToggle}>
      <div
        className={`flex items-center gap-1 px-2 py-1 rounded-md mx-1 group ${
          isRepoActive ? "bg-blue/10" : "hover:bg-surface"
        }`}
      >
        <Collapsible.Trigger asChild>
          <button
            type="button"
            className="flex items-center gap-1 flex-1 min-w-0 text-left focus:outline-none"
            onClick={onToggle}
          >
            <ChevronRight className={chevronClass(isOpen)} />
            <StatusDot status={repoStatus(overallStatus)} className="flex-shrink-0" />
            <Link
              to="/repos/$slug"
              params={{ slug }}
              className={`truncate text-xs flex-1 text-left ${
                isRepoActive ? "text-blue font-medium" : "text-foreground hover:text-foreground"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                onNavigate?.();
              }}
            >
              {name}
            </Link>
          </button>
        </Collapsible.Trigger>
        {activeEnvCount > 0 && (
          <span className="text-xs text-muted ml-1 flex-shrink-0">{activeEnvCount}</span>
        )}
      </div>

      <Collapsible.Content>
        <div className="ml-4 border-l border-border-subtle pl-2 my-0.5 space-y-0.5">
          {isLoading && <div className="px-2 py-1 text-[11px] text-muted">Loading paths…</div>}

          {!isLoading && repo?.clones.length === 0 && (
            <div className="px-2 py-1 text-[11px] text-muted">No clones</div>
          )}

          {!isLoading &&
            repo?.clones.map((clone) => (
              <CloneNode
                key={clone.id}
                slug={slug}
                clone={clone}
                currentPath={currentPath}
                onNavigate={onNavigate}
              />
            ))}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

interface RepoTreeProps {
  onNavigate?: () => void;
}

export function RepoTree({ onNavigate }: RepoTreeProps) {
  const { data: repos, isLoading } = useWebRepos();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  const [openRepos, setOpenRepos] = useState<Set<string>>(new Set());

  function toggleRepo(slug: string) {
    setOpenRepos((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  if (isLoading) {
    return (
      <div className="p-3 text-xs text-muted space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-4 bg-surface rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (!repos || repos.length === 0) {
    return (
      <div className="p-3 text-xs text-muted">
        <p className="mb-2">No repos linked yet.</p>
        <p>
          Click <strong>+ Add</strong> to link your first repo.
        </p>
      </div>
    );
  }

  return (
    <nav className="py-1">
      {repos.map((repo) => (
        <RepoNode
          key={repo.slug}
          slug={repo.slug}
          name={repo.name}
          overallStatus={repo.overallStatus}
          activeEnvCount={repo.activeEnvCount}
          currentPath={currentPath}
          onNavigate={onNavigate}
          isOpen={openRepos.has(repo.slug)}
          onToggle={() => toggleRepo(repo.slug)}
        />
      ))}

      <div className="mt-2 pt-2 border-t border-border mx-2 space-y-0.5">
        <Link
          to="/sessions"
          onClick={onNavigate}
          className={`flex items-center gap-2 px-2 py-1 rounded-md text-xs transition-colors ${
            currentPath === "/sessions" || currentPath.startsWith("/sessions/")
              ? "bg-blue/10 text-blue"
              : "text-muted hover:text-foreground hover:bg-surface"
          }`}
        >
          <MessagesSquare className="w-3 h-3 flex-shrink-0" />
          <span>Sessions</span>
        </Link>
        <Link
          to="/infra"
          onClick={onNavigate}
          className={`flex items-center gap-2 px-2 py-1 rounded-md text-xs transition-colors ${
            currentPath === "/infra"
              ? "bg-blue/10 text-blue"
              : "text-muted hover:text-foreground hover:bg-surface"
          }`}
        >
          <FolderOpen className="w-3 h-3 flex-shrink-0" />
          <span>Infrastructure</span>
        </Link>
      </div>
    </nav>
  );
}
