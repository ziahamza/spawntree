import { ExternalLink, Link2 } from "lucide-react";
import type { Service } from "../lib/api";
import { StatusDot } from "./StatusDot";

interface ServiceCardProps {
  service: Service;
  onServiceClick?: (name: string) => void;
}

const TYPE_LABELS: Record<Service["type"], string> = {
  process: "process",
  postgres: "postgres",
  redis: "redis",
  container: "container",
  external: "external",
};

const TYPE_COLORS: Record<Service["type"], string> = {
  process: "text-blue border-blue/30 bg-blue/10",
  postgres: "text-orange border-orange/30 bg-orange/10",
  redis: "text-red border-red/30 bg-red/10",
  container: "text-muted border-border bg-surface",
  external: "text-muted border-border bg-surface",
};

function previewURLFor(service: Service) {
  if (service.type === "postgres" || service.type === "redis") return null;
  if (!service.url) return null;
  return /^https?:\/\//.test(service.url) ? service.url : null;
}

function statusForDisplay(status: Service["status"]) {
  return status === "failed" ? "crashed" : status;
}

export function ServiceCard({ service, onServiceClick }: ServiceCardProps) {
  const previewURL = previewURLFor(service);

  async function handleCopy(url: string, e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt("Copy preview URL", url);
    }
  }

  return (
    <button
      type="button"
      onClick={() => onServiceClick?.(service.name)}
      className="w-full text-left rounded-lg border border-border bg-surface p-4 hover:border-blue/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue/50 cursor-pointer"
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <StatusDot status={statusForDisplay(service.status)} />
        <span className="font-semibold text-sm text-foreground flex-1 truncate">
          {service.name}
        </span>
        <span
          className={`text-xs px-2 py-0.5 rounded border font-mono ${TYPE_COLORS[service.type]}`}
        >
          {TYPE_LABELS[service.type]}
        </span>
      </div>

      {/* Details */}
      <div className="space-y-1 text-xs text-muted">
        <div className="truncate font-mono" title={service.url ?? "No service URL"}>
          {service.url ?? "No service URL"}
        </div>

        <div className="flex items-center gap-4 flex-wrap">
          {service.port != null && (
            <span>
              :{service.port}
            </span>
          )}
          {previewURL
            ? (
              <div className="flex items-center gap-2">
                <a
                  href={previewURL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="w-3 h-3" />
                  Open
                </a>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-blue hover:underline"
                  onClick={(e) => handleCopy(previewURL, e)}
                >
                  <Link2 className="w-3 h-3" />
                  Copy
                </button>
              </div>
            )
            : <span className="text-muted/70">No HTTP preview</span>}
        </div>
      </div>
    </button>
  );
}
