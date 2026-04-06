import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight, ExternalLink, Link2, RotateCcw, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { LogViewer } from "../components/LogViewer";
import { ServiceCard } from "../components/ServiceCard";
import { StatusDot } from "../components/StatusDot";
import type { Status } from "../components/StatusDot";
import { deriveEnvStatus, type Service, useDeleteEnv, useEnvDetail, useStopEnv, useWebRepoTree } from "../lib/api";

export const Route = createFileRoute("/repos/$slug/envs/$envId")({
  validateSearch: (search: Record<string, unknown>) => ({
    repoPath: typeof search.repoPath === "string" ? search.repoPath : undefined,
  }),
  component: EnvDetail,
});

function envStatusToDisplay(status: ReturnType<typeof deriveEnvStatus>): Status {
  return status;
}

function previewURLFor(service: Service) {
  if (service.type === "postgres" || service.type === "redis") return null;
  if (!service.url) return null;
  return /^https?:\/\//.test(service.url) ? service.url : null;
}

function serviceStatus(status: Service["status"]): Status {
  return status === "failed" ? "crashed" : status;
}

function EnvDetail() {
  const { slug, envId } = Route.useParams();
  const { repoPath } = Route.useSearch();
  const [activeService, setActiveService] = useState<string | null>(null);

  const { data: env, isLoading, error } = useEnvDetail(slug, envId, repoPath);
  const { data: repo } = useWebRepoTree(slug);
  const stopEnv = useStopEnv();
  const deleteEnv = useDeleteEnv();

  function handleStop() {
    if (!env) return;
    stopEnv.mutate({ repoID: slug, envID: envId, repoPath });
  }

  function handleRestart() {
    if (!env) return;
    // Stop then navigate away (restart = stop + let daemon restart via config)
    stopEnv.mutate({ repoID: slug, envID: envId, repoPath });
  }

  function handleDelete() {
    if (!window.confirm(`Delete env "${env?.envId}"? This cannot be undone.`)) return;
    deleteEnv.mutate({ repoID: slug, envID: envId, repoPath });
  }

  function handleServiceClick(name: string) {
    setActiveService((prev) => (prev === name ? null : name));
  }

  if (isLoading) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="p-6 flex-shrink-0">
          <div className="h-4 w-64 bg-surface rounded animate-pulse mb-4" />
          <div className="h-8 w-48 bg-surface rounded animate-pulse" />
        </div>
        <div className="px-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-28 rounded-lg bg-surface border border-border animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !env) {
    return (
      <div className="p-6">
        <p className="text-red text-sm">{error?.message ?? "Environment not found"}</p>
      </div>
    );
  }

  const status = envStatusToDisplay(deriveEnvStatus(env));
  const isRunning = status === "running" || status === "starting";
  const previewServices = env.services
    .map((service) => ({ service, previewURL: previewURLFor(service) }))
    .filter((item): item is { service: Service; previewURL: string; } => !!item.previewURL);

  async function handleCopy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt("Copy preview URL", url);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Top area: breadcrumb + controls */}
      <div className="flex-shrink-0 px-6 pt-6 pb-4 border-b border-border">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1 text-xs text-muted mb-3">
          <Link to="/" className="hover:text-foreground transition-colors">
            Home
          </Link>
          <ChevronRight className="w-3 h-3" />
          <Link
            to="/repos/$slug"
            params={{ slug }}
            className="hover:text-foreground transition-colors"
          >
            {repo?.name ?? slug}
          </Link>
          <ChevronRight className="w-3 h-3" />
          <span className="text-foreground font-medium">{env.envId}</span>
        </nav>

        {/* Title row */}
        <div className="flex items-center gap-3 flex-wrap">
          <StatusDot status={status} />
          <h1 className="font-display text-xl font-semibold text-foreground">{env.envId}</h1>
          <span className="text-sm text-muted capitalize">{status}</span>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 mt-4">
          {isRunning && (
            <>
              <button
                onClick={handleStop}
                disabled={stopEnv.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-muted hover:text-foreground hover:border-foreground/30 transition-colors disabled:opacity-50 min-h-[36px]"
              >
                <Square className="w-3 h-3" />
                {stopEnv.isPending ? "Stopping…" : "Stop"}
              </button>
              <button
                onClick={handleRestart}
                disabled={stopEnv.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-muted hover:text-foreground hover:border-foreground/30 transition-colors disabled:opacity-50 min-h-[36px]"
              >
                <RotateCcw className="w-3 h-3" />
                Restart
              </button>
            </>
          )}
          <button
            onClick={handleDelete}
            disabled={deleteEnv.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-muted hover:text-red hover:border-red/40 transition-colors disabled:opacity-50 min-h-[36px] ml-auto"
          >
            <Trash2 className="w-3 h-3" />
            {deleteEnv.isPending ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>

      {/* Preview links */}
      {previewServices.length > 0 && (
        <div className="flex-shrink-0 px-6 py-4 border-b border-border">
          <h2 className="text-xs font-medium text-muted uppercase tracking-wider mb-3">
            Preview Links ({previewServices.length})
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {previewServices.map(({ service, previewURL }) => (
              <div key={service.name} className="rounded-lg border border-border bg-surface p-4">
                <div className="flex items-center gap-2 mb-2">
                  <StatusDot status={serviceStatus(service.status)} />
                  <span className="font-semibold text-sm text-foreground">{service.name}</span>
                  <span className="text-[11px] text-muted ml-auto">{service.type}</span>
                </div>
                <p className="text-xs text-muted font-mono truncate mb-3" title={previewURL}>
                  {previewURL}
                </p>
                <div className="flex items-center gap-3 text-xs">
                  <a
                    href={previewURL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-blue hover:underline"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Open
                  </a>
                  <button
                    type="button"
                    onClick={() =>
                      handleCopy(previewURL)}
                    className="inline-flex items-center gap-1 text-blue hover:underline"
                  >
                    <Link2 className="w-3 h-3" />
                    Copy
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Services grid */}
      {env.services.length > 0 && (
        <div className="flex-shrink-0 px-6 py-4">
          <h2 className="text-xs font-medium text-muted uppercase tracking-wider mb-3">
            Services ({env.services.length})
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {env.services.map((svc) => (
              <div
                key={svc.name}
                className={`rounded-lg transition-all ${activeService === svc.name ? "ring-2 ring-blue/50" : ""}`}
              >
                <ServiceCard service={svc} onServiceClick={handleServiceClick} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Log viewer — takes remaining height */}
      <div className="flex-1 min-h-0 border-t border-border relative">
        <div className="flex items-center gap-2 px-6 py-2 border-b border-border bg-surface flex-shrink-0">
          <span className="text-xs font-medium text-muted uppercase tracking-wider">Logs</span>
          {activeService && (
            <>
              <span className="text-xs text-muted">·</span>
              <span className="text-xs text-blue font-mono">{activeService}</span>
              <button
                onClick={() => setActiveService(null)}
                className="text-xs text-muted hover:text-foreground ml-1 transition-colors"
              >
                ✕
              </button>
            </>
          )}
        </div>
        <div className="h-full min-h-0 flex flex-col" style={{ height: "calc(100% - 36px)" }}>
          <LogViewer repoID={slug} envID={envId} repoPath={repoPath} activeService={activeService} />
        </div>
      </div>
    </div>
  );
}
