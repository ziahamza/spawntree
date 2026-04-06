import * as Collapsible from "@radix-ui/react-collapsible";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  AlertTriangle,
  Archive,
  ChevronRight,
  Clock3,
  FolderOpen,
  FolderTree,
  GitBranch,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { deriveEnvStatus, useArchiveWorktree, useWebRepoDetail, useWebRepos } from "../lib/api";
import type { Clone, EnvListItem, GitPathInfo, Worktree } from "../lib/api";
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

function formatRelative(dateStr?: string) {
  if (!dateStr) return "";
  const ts = Date.parse(dateStr);
  if (!Number.isFinite(ts)) return "";
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function pathTextClass(git?: GitPathInfo) {
  return git?.isMergedIntoBase && !git.hasUncommittedChanges
    ? "line-through opacity-60"
    : "";
}

function PathMeta({
  git,
}: {
  git?: GitPathInfo;
}) {
  if (!git) return null;

  return (
    <div className="flex items-center gap-2 text-[11px] text-muted min-w-0 flex-wrap">
      <span className={pathTextClass(git)} title={git.branch || "detached"}>
        {git.branch || "detached"}
      </span>
      <span className="flex items-center gap-1" title={git.activityAt}>
        <Clock3 className="w-3 h-3" />
        {formatRelative(git.activityAt)}
      </span>
      <span className="font-mono">
        <span className="text-green">+{git.insertions}</span>
        <span className="text-muted">/</span>
        <span className="text-red">-{git.deletions}</span>
      </span>
      {git.hasUncommittedChanges && (
        <span className="flex items-center gap-1 text-yellow" title="Uncommitted changes">
          <AlertTriangle className="w-3 h-3" />
        </span>
      )}
      {git.isBaseOutOfDate && (
        <span
          className="flex items-center gap-1 text-blue"
          title={`${git.baseRefName || "main"} has moved ahead`}
        >
          <RefreshCw className="w-3 h-3" />
        </span>
      )}
    </div>
  );
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
        isActive
          ? "bg-blue/10 text-blue"
          : "text-muted hover:text-foreground hover:bg-surface"
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
  const archiveWorktree = useArchiveWorktree();

  function handleArchive() {
    if (!worktree.git?.canArchive) return;
    if (!window.confirm(`Archive worktree at ${worktree.path}?`)) return;
    archiveWorktree.mutate({ repoSlug: slug, path: worktree.path });
  }

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
        <Link
          to="/repos/$slug"
          params={{ slug }}
          onClick={onNavigate}
          className="min-w-0 flex-1"
        >
          <div className={`truncate text-foreground ${pathTextClass(worktree.git)}`} title={worktree.path}>
            {worktree.path}
          </div>
          <PathMeta git={worktree.git} />
        </Link>
        {worktree.git?.canArchive && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              handleArchive();
            }}
            disabled={archiveWorktree.isPending}
            className="p-1 rounded text-muted hover:text-foreground hover:bg-background disabled:opacity-50"
            title="Archive this merged worktree"
          >
            <Archive className="w-3 h-3" />
          </button>
        )}
        {worktree.envs.length > 0 && (
          <span className="text-[11px] text-muted flex-shrink-0">{worktree.envs.length}</span>
        )}
      </div>

      <Collapsible.Content>
        <div className="ml-4 border-l border-border-subtle pl-2 my-0.5 space-y-0.5">
          {worktree.envs.length === 0 ? <div className="px-2 py-1 text-[11px] text-muted">No envs</div> : (
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
          <div className={`truncate text-foreground ${pathTextClass(clone.git)}`}>{clone.path}</div>
          <PathMeta git={clone.git} />
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
  const { data: repo, isLoading } = useWebRepoDetail(slug, isOpen);

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
        {activeEnvCount > 0 && <span className="text-xs text-muted ml-1 flex-shrink-0">{activeEnvCount}</span>}
      </div>

      <Collapsible.Content>
        <div className="ml-4 border-l border-border-subtle pl-2 my-0.5 space-y-0.5">
          {isLoading && <div className="px-2 py-1 text-[11px] text-muted">Loading paths…</div>}

          {!isLoading && repo?.clones.length === 0 && <div className="px-2 py-1 text-[11px] text-muted">No clones</div>}

          {!isLoading
            && repo?.clones.map((clone) => (
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
        {[1, 2, 3].map((i) => <div key={i} className="h-4 bg-surface rounded animate-pulse" />)}
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

      <div className="mt-2 pt-2 border-t border-border mx-2">
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
