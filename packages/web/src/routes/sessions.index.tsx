import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { MessagesSquare, Plus } from "lucide-react";
import { useState } from "react";
import { type Session, useCreateSession, useSessions } from "../lib/api";

export const Route = createFileRoute("/sessions/")({
  component: SessionsListPage,
});

function SessionsListPage() {
  const { data, isLoading, error } = useSessions();
  const sessions = data?.sessions ?? [];
  const [creating, setCreating] = useState(false);

  if (isLoading) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="font-display text-2xl font-semibold text-foreground">Sessions</h1>
        </div>
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-14 rounded-md bg-surface border border-border animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <h1 className="font-display text-2xl font-semibold text-foreground mb-4">Sessions</h1>
        <p className="text-red-400 text-sm">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-foreground">Sessions</h1>
          <p className="text-xs text-muted mt-1">
            {sessions.length === 0
              ? "Drive AI coding agents via Claude Code and Codex."
              : `${sessions.length} session${sessions.length === 1 ? "" : "s"} across available providers.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border bg-surface text-foreground hover:border-foreground/40 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          New session
        </button>
      </header>

      {creating && <NewSessionDialog onClose={() => setCreating(false)} />}

      {sessions.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface">
              <tr className="text-[11px] uppercase tracking-wider text-muted">
                <th className="text-left px-3 py-2 font-medium">Provider</th>
                <th className="text-left px-3 py-2 font-medium">Title</th>
                <th className="text-left px-3 py-2 font-medium">Working directory</th>
                <th className="text-left px-3 py-2 font-medium">Branch</th>
                <th className="text-right px-3 py-2 font-medium">Turns</th>
                <th className="text-right px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <SessionRow key={s.sessionId} session={s} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SessionRow({ session }: { session: Session }) {
  return (
    <tr className="border-t border-border hover:bg-surface/60 transition-colors">
      <td className="px-3 py-2 whitespace-nowrap">
        <ProviderBadge provider={session.provider} status={session.status} />
      </td>
      <td className="px-3 py-2 max-w-xs truncate">
        <Link
          to="/sessions/$id"
          params={{ id: session.sessionId }}
          className="text-foreground hover:underline"
        >
          {session.title ?? <span className="text-muted italic">untitled</span>}
        </Link>
      </td>
      <td className="px-3 py-2 text-[11px] font-mono text-muted max-w-[18rem] truncate">
        {session.workingDirectory}
      </td>
      <td className="px-3 py-2 text-[11px] font-mono text-muted whitespace-nowrap">
        {session.gitBranch ?? "—"}
      </td>
      <td className="px-3 py-2 text-right text-xs tabular-nums text-muted">{session.totalTurns}</td>
      <td className="px-3 py-2 text-right text-[11px] text-muted whitespace-nowrap">
        {formatRelativeTime(session.updatedAt)}
      </td>
    </tr>
  );
}

function ProviderBadge({ provider, status }: { provider: string; status: Session["status"] }) {
  const dot =
    status === "streaming"
      ? "bg-yellow-400 animate-pulse"
      : status === "error"
        ? "bg-red-400"
        : status === "idle"
          ? "bg-green-400"
          : "bg-muted";
  const label =
    provider === "claude-code" ? "Claude Code" : provider === "codex" ? "Codex" : provider;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]">
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} title={status} />
      <span className="font-medium text-foreground">{label}</span>
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-md border border-border bg-surface/40 p-12 text-center">
      <MessagesSquare className="w-8 h-8 text-muted mx-auto mb-3" />
      <h2 className="text-sm font-medium text-foreground mb-1">No sessions yet</h2>
      <p className="text-xs text-muted max-w-sm mx-auto mb-4">
        A session is a live conversation with an AI coding agent — Claude Code or Codex — running in
        a working directory.
      </p>
      <pre className="text-[11px] text-muted max-w-md mx-auto text-left bg-background/60 rounded-md p-3 font-mono whitespace-pre-wrap">
        {"# start a Claude Code session\n"}
        {"curl -X POST /api/v1/sessions \\\n"}
        {"  -H 'content-type: application/json' \\\n"}
        {`  -d '{"provider":"claude-code","cwd":"/path/to/repo"}'`}
      </pre>
    </div>
  );
}

function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const create = useCreateSession();
  const [provider, setProvider] = useState<"claude-code" | "codex">("claude-code");
  const [cwd, setCwd] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const onCreate = async () => {
    setErr(null);
    if (!cwd.trim()) {
      setErr("Working directory is required.");
      return;
    }
    try {
      const result = await create.mutateAsync({ provider, cwd: cwd.trim() });
      onClose();
      void navigate({ to: "/sessions/$id", params: { id: result.sessionId } });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setErr(message);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-md border border-border bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-lg font-semibold text-foreground mb-4">New session</h2>

        <div className="space-y-4">
          <div>
            <label className="text-[11px] uppercase tracking-wider text-muted block mb-2">
              Provider
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(["claude-code", "codex"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProvider(p)}
                  disabled={p === "codex"}
                  className={`px-3 py-2 rounded-md border text-xs transition-colors ${
                    provider === p
                      ? "border-foreground/40 bg-background/40 text-foreground"
                      : "border-border text-muted hover:text-foreground hover:border-foreground/20"
                  } ${p === "codex" ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  {p === "claude-code" ? "Claude Code" : "Codex"}
                  {p === "codex" && (
                    <div className="text-[10px] text-muted mt-0.5">sessions created by CLI</div>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-wider text-muted block mb-2">
              Working directory
            </label>
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/Users/you/repos/myproject"
              autoFocus
              className="w-full px-3 py-2 text-sm font-mono rounded-md border border-border bg-background text-foreground placeholder:text-muted focus:outline-none focus:border-foreground/40"
            />
          </div>

          {err && <div className="text-xs text-red-400">{err}</div>}

          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-md border border-border text-muted hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onCreate}
              disabled={create.isPending}
              className="px-3 py-1.5 text-xs rounded-md border border-foreground/40 bg-foreground/10 text-foreground hover:bg-foreground/20 transition-colors disabled:opacity-50"
            >
              {create.isPending ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const delta = Math.max(0, now - then);
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}
