import { createFileRoute } from "@tanstack/react-router";
import {
  AlertTriangle,
  GitBranch,
  HardDrive,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  type CleanupActionResult,
  type CleanupRepoSummary,
  type CleanupWorktree,
  useCleanIgnoredWorktreeArtifacts,
  useRemoveCleanupWorktrees,
  useWorktreeCleanup,
} from "../lib/api";

export const Route = createFileRoute("/cleanup")({
  component: CleanupPage,
});

type ActionKind = "remove" | "clean";

function CleanupPage() {
  const { data, isLoading, error, refetch, isFetching } = useWorktreeCleanup();
  const removeWorktrees = useRemoveCleanupWorktrees();
  const cleanIgnored = useCleanIgnoredWorktreeArtifacts();
  const [lastAction, setLastAction] = useState<CleanupActionResult | null>(null);

  const items = data?.items ?? [];
  const mergedClean = useMemo(
    () => items.filter((item) => item.category === "merged-clean"),
    [items],
  );
  const mergedDirty = useMemo(
    () => items.filter((item) => item.category === "merged-dirty"),
    [items],
  );
  const unmerged = useMemo(() => items.filter((item) => item.category === "unmerged"), [items]);
  const protectedItems = useMemo(
    () => items.filter((item) => item.category === "protected"),
    [items],
  );

  async function runAction(kind: ActionKind, paths: ReadonlyArray<string>) {
    if (paths.length === 0) {
      return;
    }
    const result =
      kind === "remove"
        ? await removeWorktrees.mutateAsync(paths)
        : await cleanIgnored.mutateAsync(paths);
    setLastAction(result);
  }

  const busy = removeWorktrees.isPending || cleanIgnored.isPending;

  if (isLoading) {
    return (
      <div className="p-6 max-w-6xl mx-auto w-full">
        <div className="h-8 w-44 bg-surface rounded animate-pulse mb-6" />
        <div className="grid gap-3 sm:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 rounded-lg border border-border bg-surface animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 max-w-4xl mx-auto w-full">
        <h1 className="font-display text-2xl font-semibold text-foreground mb-4">Save space</h1>
        <p className="text-red text-sm">{error.message}</p>
      </div>
    );
  }

  const cleanableUnmerged = unmerged.filter((item) => item.canCleanIgnored);
  const cleanableMergedDirty = mergedDirty.filter((item) => item.canCleanIgnored);

  return (
    <div className="p-6 max-w-6xl mx-auto w-full">
      <header className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-foreground">Save space</h1>
          <p className="text-xs text-muted mt-1">
            {data ? `${data.totals.worktreeCount} worktree candidates` : "No report yet"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching || busy}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border bg-surface text-foreground hover:border-foreground/40 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </header>

      {data && (
        <>
          <SummaryStrip
            removableBytes={data.totals.removableBytes}
            ignoredBytes={data.totals.ignoredBytes}
            mergedCleanCount={data.totals.mergedCleanCount}
            unmergedCount={data.totals.unmergedCount}
          />

          <div className="flex flex-wrap gap-2 my-5">
            <ActionButton
              icon={<Trash2 className="w-3.5 h-3.5" />}
              label={`Remove merged (${mergedClean.length})`}
              disabled={busy || mergedClean.length === 0}
              onClick={() =>
                void runAction(
                  "remove",
                  mergedClean.map((item) => item.path),
                )
              }
            />
            <ActionButton
              icon={<RefreshCw className="w-3.5 h-3.5" />}
              label={`Clean unmerged (${cleanableUnmerged.length})`}
              disabled={busy || cleanableUnmerged.length === 0}
              onClick={() =>
                void runAction(
                  "clean",
                  cleanableUnmerged.map((item) => item.path),
                )
              }
            />
            <ActionButton
              icon={<RefreshCw className="w-3.5 h-3.5" />}
              label={`Clean dirty merged (${cleanableMergedDirty.length})`}
              disabled={busy || cleanableMergedDirty.length === 0}
              onClick={() =>
                void runAction(
                  "clean",
                  cleanableMergedDirty.map((item) => item.path),
                )
              }
            />
            {busy && (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted px-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Working
              </span>
            )}
          </div>

          {lastAction && <ActionResult result={lastAction} />}

          <RepoActionTable repos={data.repos} items={items} busy={busy} onRunAction={runAction} />

          <div className="mt-6 space-y-6">
            <WorktreeSection
              title="Merged clean"
              icon={<Trash2 className="w-4 h-4" />}
              items={mergedClean}
              primaryBytes="full"
              empty="No clean merged worktrees."
              busy={busy}
              onRunAction={runAction}
            />
            <WorktreeSection
              title="Unmerged"
              icon={<AlertTriangle className="w-4 h-4" />}
              items={unmerged}
              primaryBytes="ignored"
              empty="No unmerged worktrees."
              busy={busy}
              onRunAction={runAction}
            />
            <WorktreeSection
              title="Merged dirty"
              icon={<GitBranch className="w-4 h-4" />}
              items={mergedDirty}
              primaryBytes="ignored"
              empty="No dirty merged worktrees."
              busy={busy}
              onRunAction={runAction}
            />
            {protectedItems.length > 0 && (
              <WorktreeSection
                title="Protected"
                icon={<ShieldAlert className="w-4 h-4" />}
                items={protectedItems}
                primaryBytes="ignored"
                empty="No protected worktrees."
                busy={busy}
                onRunAction={runAction}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SummaryStrip({
  removableBytes,
  ignoredBytes,
  mergedCleanCount,
  unmergedCount,
}: {
  removableBytes: number;
  ignoredBytes: number;
  mergedCleanCount: number;
  unmergedCount: number;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <SummaryCell
        icon={<Trash2 className="w-4 h-4" />}
        label="Merged removal"
        value={formatBytes(removableBytes)}
        detail={`${mergedCleanCount} worktree${mergedCleanCount === 1 ? "" : "s"}`}
      />
      <SummaryCell
        icon={<HardDrive className="w-4 h-4" />}
        label="Ignored artifacts"
        value={formatBytes(ignoredBytes)}
        detail="cleanable build output and dependencies"
      />
      <SummaryCell
        icon={<GitBranch className="w-4 h-4" />}
        label="Unmerged"
        value={String(unmergedCount)}
        detail="needs branch-level decision"
      />
    </div>
  );
}

function SummaryCell({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-muted mb-2">
        {icon}
        <span className="text-[11px] uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-2xl font-display font-semibold text-foreground">{value}</div>
      <div className="text-xs text-muted mt-1">{detail}</div>
    </div>
  );
}

function RepoActionTable({
  repos,
  items,
  busy,
  onRunAction,
}: {
  repos: ReadonlyArray<CleanupRepoSummary>;
  items: ReadonlyArray<CleanupWorktree>;
  busy: boolean;
  onRunAction: (kind: ActionKind, paths: ReadonlyArray<string>) => Promise<void>;
}) {
  if (repos.length === 0) {
    return null;
  }

  return (
    <section className="mt-6">
      <h2 className="text-xs font-medium text-muted uppercase tracking-wider mb-3">
        Repository actions
      </h2>
      <div className="rounded-md border border-border overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-surface">
            <tr className="text-[11px] uppercase tracking-wider text-muted">
              <th className="text-left px-3 py-2 font-medium">Repo</th>
              <th className="text-right px-3 py-2 font-medium">Remove</th>
              <th className="text-right px-3 py-2 font-medium">Ignored</th>
              <th className="text-right px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {repos.map((repo) => {
              const repoItems = items.filter((item) => item.repoId === repo.repoId);
              const removable = repoItems.filter((item) => item.canRemove);
              const unmerged = repoItems.filter(
                (item) => item.category === "unmerged" && item.canCleanIgnored,
              );
              const dirty = repoItems.filter(
                (item) => item.category === "merged-dirty" && item.canCleanIgnored,
              );
              return (
                <tr key={repo.repoId} className="border-t border-border hover:bg-surface/60">
                  <td className="px-3 py-2">
                    <div className="font-medium text-foreground">{repo.repoName}</div>
                    <div className="text-[11px] text-muted">{repo.worktreeCount} worktrees</div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {formatBytes(repo.removableBytes)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {formatBytes(repo.ignoredBytes)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1.5">
                      <MiniAction
                        title="Remove merged clean worktrees"
                        disabled={busy || removable.length === 0}
                        onClick={() =>
                          void onRunAction(
                            "remove",
                            removable.map((item) => item.path),
                          )
                        }
                        icon={<Trash2 className="w-3.5 h-3.5" />}
                      />
                      <MiniAction
                        title="Clean ignored artifacts in unmerged worktrees"
                        disabled={busy || unmerged.length === 0}
                        onClick={() =>
                          void onRunAction(
                            "clean",
                            unmerged.map((item) => item.path),
                          )
                        }
                        icon={<AlertTriangle className="w-3.5 h-3.5" />}
                      />
                      <MiniAction
                        title="Clean ignored artifacts in dirty merged worktrees"
                        disabled={busy || dirty.length === 0}
                        onClick={() =>
                          void onRunAction(
                            "clean",
                            dirty.map((item) => item.path),
                          )
                        }
                        icon={<RefreshCw className="w-3.5 h-3.5" />}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WorktreeSection({
  title,
  icon,
  items,
  primaryBytes,
  empty,
  busy,
  onRunAction,
}: {
  title: string;
  icon: React.ReactNode;
  items: ReadonlyArray<CleanupWorktree>;
  primaryBytes: "full" | "ignored";
  empty: string;
  busy: boolean;
  onRunAction: (kind: ActionKind, paths: ReadonlyArray<string>) => Promise<void>;
}) {
  const sorted = [...items].sort((left, right) => {
    const rightBytes = primaryBytes === "full" ? right.fullSizeBytes : right.ignoredSizeBytes;
    const leftBytes = primaryBytes === "full" ? left.fullSizeBytes : left.ignoredSizeBytes;
    return rightBytes - leftBytes;
  });

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-muted">{icon}</span>
        <h2 className="text-xs font-medium text-muted uppercase tracking-wider">{title}</h2>
        <span className="text-xs text-muted">{items.length}</span>
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-md border border-border bg-surface/40 p-4 text-sm text-muted">
          {empty}
        </div>
      ) : (
        <div className="rounded-md border border-border overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-surface">
              <tr className="text-[11px] uppercase tracking-wider text-muted">
                <th className="text-left px-3 py-2 font-medium">Worktree</th>
                <th className="text-left px-3 py-2 font-medium">Branch</th>
                <th className="text-right px-3 py-2 font-medium">Full</th>
                <th className="text-right px-3 py-2 font-medium">Ignored</th>
                <th className="text-right px-3 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((item) => (
                <WorktreeRow key={item.path} item={item} busy={busy} onRunAction={onRunAction} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function WorktreeRow({
  item,
  busy,
  onRunAction,
}: {
  item: CleanupWorktree;
  busy: boolean;
  onRunAction: (kind: ActionKind, paths: ReadonlyArray<string>) => Promise<void>;
}) {
  const action =
    item.canRemove || item.canCleanIgnored ? (
      item.canRemove ? (
        <MiniAction
          title="Remove worktree"
          disabled={busy}
          onClick={() => void onRunAction("remove", [item.path])}
          icon={<Trash2 className="w-3.5 h-3.5" />}
        />
      ) : (
        <MiniAction
          title="Clean ignored artifacts"
          disabled={busy}
          onClick={() => void onRunAction("clean", [item.path])}
          icon={<RefreshCw className="w-3.5 h-3.5" />}
        />
      )
    ) : (
      <span className="text-[11px] text-muted" title={item.blockedReasons.join(", ")}>
        blocked
      </span>
    );

  return (
    <tr className="border-t border-border hover:bg-surface/60">
      <td className="px-3 py-2 min-w-0">
        <div className="flex items-center gap-2">
          <SourceBadge source={item.source} />
          <span className="font-medium text-foreground truncate max-w-[18rem]" title={item.path}>
            {shortPath(item.path)}
          </span>
        </div>
        <div className="text-[11px] text-muted truncate max-w-[28rem]" title={item.path}>
          {item.repoName} - {item.path}
        </div>
        {item.locked && (
          <div className="text-[11px] text-orange mt-0.5" title={item.lockedReason}>
            locked{item.lockedReason ? `: ${item.lockedReason}` : ""}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        <div
          className="font-mono text-xs text-foreground max-w-[14rem] truncate"
          title={item.branch}
        >
          {item.branch || "detached"}
        </div>
        <div className="text-[11px] text-muted">
          {item.insertions + item.deletions > 0
            ? `+${item.insertions} -${item.deletions}`
            : item.baseRefName || "base unknown"}
        </div>
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs whitespace-nowrap">
        {formatBytes(item.fullSizeBytes)}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs whitespace-nowrap">
        {formatBytes(item.ignoredSizeBytes)}
      </td>
      <td className="px-3 py-2 text-right">{action}</td>
    </tr>
  );
}

function ActionButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border bg-surface text-foreground hover:border-foreground/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {icon}
      {label}
    </button>
  );
}

function MiniAction({
  title,
  disabled,
  onClick,
  icon,
}: {
  title: string;
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-border bg-surface text-muted hover:text-foreground hover:border-foreground/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      {icon}
    </button>
  );
}

function ActionResult({ result }: { result: CleanupActionResult }) {
  const failed = result.results.filter((item) => !item.ok);
  return (
    <div
      className={`rounded-md border p-3 mb-5 text-sm ${
        result.ok ? "border-green/30 bg-green/5" : "border-orange/40 bg-warning-bg/60"
      }`}
    >
      <div className="font-medium text-foreground">
        Freed {formatBytes(result.freedBytes)}
        {failed.length > 0 ? ` - ${failed.length} failed` : ""}
      </div>
      {failed.length > 0 && (
        <div className="text-xs text-muted mt-1 space-y-0.5">
          {failed.slice(0, 3).map((item) => (
            <div key={item.path} className="truncate" title={`${item.path}: ${item.message}`}>
              {shortPath(item.path)}: {item.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SourceBadge({ source }: { source: CleanupWorktree["source"] }) {
  return (
    <span className="text-[10px] uppercase tracking-wider rounded border border-border px-1.5 py-0.5 text-muted bg-background/50">
      {source}
    </span>
  );
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `.../${parts.slice(-3).join("/")}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}
