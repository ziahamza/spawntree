import { createFileRoute } from "@tanstack/react-router";
import { Cloud, Database, HardDrive, Server } from "lucide-react";
import { StatusDot } from "../components/StatusDot";
import type { Status } from "../components/StatusDot";
import { useInfra, useStorage, type StorageStatus } from "../lib/api";

export const Route = createFileRoute("/infra")({
  component: InfraPage,
});

/**
 * Render an ISO timestamp as a short relative duration: "12s ago",
 * "4m ago", "2h ago", "3d ago". Falls back to a localized date string
 * for >7d. The full ISO is preserved as a `title` so a hover reveals
 * the precise time. Returns "—" for missing input.
 *
 * QA caught raw ISO strings dumped into card rows where they wrapped
 * across lines and made the layout look broken. This puts a bound on
 * how much horizontal real estate any timestamp can ever consume.
 */
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function relativeFuture(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, Math.floor((then - Date.now()) / 1000));
  if (seconds < 5) return "any moment";
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `in ${hours}h`;
}

function InfraCard({
  title,
  icon,
  status,
  statusLabel,
  details,
}: {
  title: string;
  icon: React.ReactNode;
  status: Status;
  /** Override the auto-capitalized status pill label (e.g. show "Synced" instead of "Running"). */
  statusLabel?: string;
  details: { label: string; value: string | number | undefined; title?: string }[];
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="flex items-center gap-3 mb-4">
        <div className="text-muted">{icon}</div>
        <h2 className="font-display font-semibold text-foreground">{title}</h2>
        <div className="ml-auto flex items-center gap-2">
          <StatusDot status={status} />
          <span className="text-sm text-muted capitalize">{statusLabel ?? status}</span>
        </div>
      </div>

      <dl className="space-y-2">
        {details
          .filter((d) => d.value != null && d.value !== "")
          .map((d) => (
            // `items-start` (was `items-center`) so the label doesn't get
            // wedged inside a wrapped multi-line value — QA hit this with
            // long error strings; the "Host" label literally rendered
            // between two lines of the value text. `min-w-0` lets the
            // value column shrink so `break-words` can do its job.
            <div key={d.label} className="flex items-start justify-between gap-3 text-xs">
              <dt className="text-muted shrink-0">{d.label}</dt>
              <dd
                className="font-mono text-foreground text-right break-words min-w-0"
                title={d.title}
              >
                {d.value}
              </dd>
            </div>
          ))}
      </dl>
    </div>
  );
}

interface HostSyncSummary {
  /** Pill color/dot. */
  status: Status;
  /** Display label override on the pill (capitalized). */
  pillLabel: string;
  /** Short headline — keep < ~40 chars where possible. */
  headline: string;
  /** Optional short tail — already trimmed. */
  detail?: string;
  /** When the state was last updated, in human-relative form. */
  whenLine?: string;
  /** Full ISO for hover/tooltip. */
  whenIso?: string;
}

/**
 * Map `HostSyncState` to the display shape the cards consume. Two key
 * decisions baked in here, both surfaced by the QA pass:
 *
 *   - Each variant returns SHORT strings (headline, detail). Long upstream
 *     error JSON gets summarized to its status code + first phrase. The
 *     full message is preserved on the card via the `title` attribute.
 *
 *   - Status pill mapping is deliberate, not the reflexive "running /
 *     stopped / crashed":
 *       synced            → running   ("Synced")
 *       fetching          → starting  ("Fetching")
 *       awaiting_config   → stopped   ("Idle")    — daemon is fine, just
 *                                                   no operator config yet
 *       error             → crashed   ("Error")
 *       idle              → starting  ("Init")    — never seen by users
 *                                                   in practice
 */
function summarizeHostSync(hostSync: StorageStatus["hostSync"]): HostSyncSummary {
  if (hostSync === null) {
    return {
      status: "stopped",
      pillLabel: "Standalone",
      headline: "Standalone — no host binding",
    };
  }
  if (hostSync.state === "idle") {
    return {
      status: "starting",
      pillLabel: "Init",
      headline: "Initializing host sync",
    };
  }
  if (hostSync.state === "fetching") {
    return {
      status: "starting",
      pillLabel: "Fetching",
      headline: "Fetching config from host",
      whenLine: relativeTime(hostSync.since),
      whenIso: hostSync.since,
    };
  }
  if (hostSync.state === "synced") {
    return {
      status: "running",
      pillLabel: "Synced",
      headline: hostSync.daemonLabel ? `as '${hostSync.daemonLabel}'` : "from host",
      whenLine: relativeTime(hostSync.lastSyncAt),
      whenIso: hostSync.lastSyncAt,
    };
  }
  if (hostSync.state === "awaiting_config") {
    return {
      status: "stopped",
      pillLabel: "Idle",
      headline: hostSync.daemonLabel ? `as '${hostSync.daemonLabel}'` : "host reachable",
      detail: "no config from operator yet",
      whenLine: relativeTime(hostSync.lastCheckAt),
      whenIso: hostSync.lastCheckAt,
    };
  }
  // error — trim noisy upstream JSON to a short summary; full text is
  // available on hover via the `title` attribute on the rendered cell.
  return {
    status: "crashed",
    pillLabel: "Error",
    headline: trimErrorForDisplay(hostSync.error),
    detail: `retry ${relativeFuture(hostSync.nextRetryAt)}`,
    whenLine: relativeTime(hostSync.lastErrorAt),
    whenIso: hostSync.lastErrorAt,
  };
}

/**
 * Compact a host-sync error string to something that fits on one card row.
 * Strategy:
 *   - "host returned 401: {...}" → "host returned 401"
 *   - "fetch failed" / network → keep as-is (already short)
 *   - Anything else → first 60 chars + ellipsis
 * The full message is rendered into the cell's `title` so hover reveals it.
 */
function trimErrorForDisplay(raw: string): string {
  const colonIdx = raw.indexOf(":");
  if (colonIdx > 0 && colonIdx < 30) {
    return raw.slice(0, colonIdx);
  }
  if (raw.length <= 60) return raw;
  return raw.slice(0, 57) + "…";
}

function StorageCard({ storage }: { storage: StorageStatus | undefined }) {
  if (!storage) {
    return (
      <InfraCard
        title="Storage"
        icon={<HardDrive className="w-5 h-5" />}
        status="stopped"
        details={[{ label: "Status", value: "Unavailable" }]}
      />
    );
  }
  const sync = summarizeHostSync(storage.hostSync);
  // The Storage card stays high-level: primary + replicator count + a
  // ONE-line host status. The detailed host-sync state lives in the
  // dedicated Host binding card (only rendered when actually bound),
  // so we don't show two timestamp rows on the same card.
  const hostLine = storage.hostSync === null
    ? sync.headline // "Standalone — no host binding"
    : `${sync.pillLabel}${sync.headline ? ` ${sync.headline}` : ""}`;
  return (
    <InfraCard
      title="Storage"
      icon={<HardDrive className="w-5 h-5" />}
      status={storage.migrating ? "starting" : "running"}
      details={[
        { label: "Primary", value: storage.primary.id },
        { label: "Replicators", value: storage.replicators.length || "none" },
        { label: "Migrating", value: storage.migrating ? "yes" : undefined },
        { label: "Host", value: hostLine, title: sync.whenIso },
      ]}
    />
  );
}

/**
 * Compact, second card dedicated to the host binding so the connection
 * pill is visible at a glance even if the storage card is collapsed
 * mentally. Only renders when a `--host` binding is in effect.
 */
function HostBindingCard({ storage }: { storage: StorageStatus | undefined }) {
  if (!storage || storage.hostSync === null) return null;
  const sync = summarizeHostSync(storage.hostSync);
  // The full `error` text lands in the row's `title` attribute so an
  // operator hovering on the trimmed display sees the original message.
  const fullError = storage.hostSync.state === "error" ? storage.hostSync.error : undefined;
  return (
    <InfraCard
      title="Host binding"
      icon={<Cloud className="w-5 h-5" />}
      status={sync.status}
      statusLabel={sync.pillLabel}
      details={[
        { label: "State", value: storage.hostSync.state },
        { label: "Status", value: sync.headline, title: fullError },
        { label: "Detail", value: sync.detail, title: fullError },
        { label: "When", value: sync.whenLine, title: sync.whenIso },
      ]}
    />
  );
}

function InfraPage() {
  const { data: infra, isLoading, error } = useInfra();
  const { data: storage } = useStorage();

  if (isLoading) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="h-6 w-40 bg-surface rounded animate-pulse mb-6" />
        <div className="grid gap-4 sm:grid-cols-2">
          {[1, 2].map((i) => <div key={i} className="h-40 rounded-lg bg-surface border border-border animate-pulse" />)}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <p className="text-red text-sm">{error.message}</p>
      </div>
    );
  }

  // The API returns {postgres: [...instances], redis: {...} | null}
  const pgInstances = Array.isArray(infra?.postgres) ? infra.postgres : [];
  const redis = infra?.redis;

  return (
    <div className="p-6 max-w-2xl mx-auto w-full">
      <h1 className="font-display text-2xl font-semibold text-foreground mb-6">Infrastructure</h1>

      <div className="grid gap-4 sm:grid-cols-2">
        {pgInstances.length > 0
          ? (
            pgInstances.map((pg, i: number) => (
              <InfraCard
                key={i}
                title={`PostgreSQL ${pg.version || ""}`}
                icon={<Database className="w-5 h-5" />}
                status={pg.status === "running" ? "running" : "stopped"}
                details={[
                  { label: "Version", value: pg.version },
                  { label: "Port", value: pg.port },
                  { label: "Container", value: pg.containerId?.slice(0, 12) },
                  { label: "Databases", value: pg.databases.join(", ") },
                ]}
              />
            ))
          )
          : (
            <InfraCard
              title="PostgreSQL"
              icon={<Database className="w-5 h-5" />}
              status="stopped"
              details={[
                { label: "Status", value: "Not running" },
              ]}
            />
          )}

        <InfraCard
          title="Redis"
          icon={<Server className="w-5 h-5" />}
          status={redis?.status === "running" ? "running" : "stopped"}
          details={redis
            ? [
              { label: "Port", value: redis.port },
              { label: "Container", value: redis.containerId?.slice(0, 12) },
            ]
            : [
              { label: "Status", value: "Not running" },
            ]}
        />

        <StorageCard storage={storage} />
        <HostBindingCard storage={storage} />
      </div>
    </div>
  );
}
