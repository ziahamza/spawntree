import { createFileRoute, Link } from "@tanstack/react-router";
import { Activity, Plus, Server } from "lucide-react";
import { useState } from "react";
import { AddFolderDialog } from "../components/AddFolderDialog";
import { StatusDot } from "../components/StatusDot";
import type { Status } from "../components/StatusDot";
import { deriveEnvStatus, useEnvs, useWebRepos } from "../lib/api";
import type { EnvListItem, WebRepo } from "../lib/api";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

function formatRelative(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function envStatus(env: EnvListItem): Status {
  return deriveEnvStatus(env);
}

function repoOverallStatus(repo: WebRepo): Status {
  if (repo.overallStatus === "running") return "running";
  if (repo.overallStatus === "crashed") return "crashed";
  if (repo.overallStatus === "offline") return "offline";
  return "stopped";
}

function RightNowSection({ envs }: { envs: EnvListItem[] }) {
  // Find most recently active/crashed env
  const candidates = [...envs].sort((a, b) => {
    const statusA = deriveEnvStatus(a);
    const statusB = deriveEnvStatus(b);
    const priorityA =
      statusA === "running" || statusA === "starting" ? 0 : statusA === "crashed" ? 1 : 2;
    const priorityB =
      statusB === "running" || statusB === "starting" ? 0 : statusB === "crashed" ? 1 : 2;
    if (priorityA !== priorityB) return priorityA - priorityB;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  const env = candidates[0];
  if (!env) return null;

  const status = deriveEnvStatus(env);
  const serviceCount = env.services?.length ?? 0;

  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-3">
        <Activity className="w-4 h-4 text-muted" />
        <h2 className="text-xs font-medium text-muted uppercase tracking-wider">Right now</h2>
      </div>
      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="flex items-center gap-3 mb-3">
          <StatusDot status={envStatus(env)} />
          <span className="font-semibold text-foreground">{env.envId}</span>
          <span className="text-xs text-muted capitalize">{status}</span>
          <span className="text-xs text-muted ml-auto">{formatRelative(env.createdAt)}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted mb-4">
          <Server className="w-3 h-3" />
          <span>
            {serviceCount} service{serviceCount !== 1 ? "s" : ""}
          </span>
          <span className="font-mono ml-2 text-muted/70 truncate">{env.repoPath}</span>
        </div>
        <div className="flex gap-2">
          <Link
            to="/repos/$slug/envs/$envId"
            params={{ slug: env.repoId, envId: env.envId }}
            search={{ repoPath: env.repoPath }}
            className="px-3 py-1.5 text-xs rounded-md border border-border text-muted hover:text-foreground hover:border-foreground/30 transition-colors"
          >
            View
          </Link>
        </div>
      </div>
    </div>
  );
}

function RepoCard({ repo }: { repo: WebRepo }) {
  const status = repoOverallStatus(repo);

  return (
    <Link
      to="/repos/$slug"
      params={{ slug: repo.slug }}
      className="block rounded-lg border border-border bg-surface p-4 hover:border-blue/40 transition-colors"
    >
      <div className="flex items-center gap-2 mb-2">
        <StatusDot status={status} />
        <span className="font-semibold text-sm text-foreground truncate flex-1">{repo.name}</span>
      </div>
      <div className="flex items-center gap-4 text-xs text-muted">
        <span>
          {repo.cloneCount} clone{repo.cloneCount !== 1 ? "s" : ""}
        </span>
        {repo.activeEnvCount > 0 && (
          <span className="text-green">{repo.activeEnvCount} active</span>
        )}
        <span className="ml-auto">{formatRelative(repo.updatedAt)}</span>
      </div>
    </Link>
  );
}

function Dashboard() {
  const [addOpen, setAddOpen] = useState(false);
  const { data: repos, isLoading: reposLoading } = useWebRepos();
  const { data: envs, isLoading: envsLoading } = useEnvs();

  const isLoading = reposLoading || envsLoading;
  const hasRepos = repos && repos.length > 0;

  if (isLoading) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-20 rounded-lg bg-surface border border-border animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  if (!hasRepos) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <div className="w-16 h-16 rounded-full bg-surface border border-border flex items-center justify-center mb-6">
          <Plus className="w-8 h-8 text-muted" />
        </div>
        <h2 className="font-display text-xl font-semibold mb-2 text-foreground">
          Welcome to spawntree
        </h2>
        <p className="text-muted text-sm max-w-sm mb-8">
          Link your first repo to see all your dev environments in one place.
        </p>
        <button
          onClick={() => setAddOpen(true)}
          className="flex items-center gap-2 px-5 py-2.5 text-sm rounded-md bg-blue text-background font-medium hover:bg-blue/90 transition-colors min-h-[44px]"
        >
          <Plus className="w-4 h-4" />
          Add folder
        </button>
        <AddFolderDialog open={addOpen} onOpenChange={setAddOpen} />
      </div>
    );
  }

  const activeEnvs =
    envs?.filter((e) => {
      const s = deriveEnvStatus(e);
      return s === "running" || s === "starting" || s === "crashed";
    }) ?? [];

  return (
    <div className="p-6 max-w-4xl mx-auto w-full">
      {/* Right Now */}
      {activeEnvs.length > 0 && <RightNowSection envs={activeEnvs} />}

      {/* Repos grid */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-medium text-muted uppercase tracking-wider">Repos</h2>
        <button
          onClick={() => setAddOpen(true)}
          className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-border text-muted hover:text-foreground hover:border-foreground/30 transition-colors"
        >
          <Plus className="w-3 h-3" />
          Add
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {repos!.map((repo) => (
          <RepoCard key={repo.slug} repo={repo} />
        ))}
      </div>

      <AddFolderDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
