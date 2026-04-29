import type { StorageConfig } from "spawntree-core";
import type { HostBinding } from "../state/global-state.ts";
import type { StorageManager } from "./manager.ts";

/**
 * Pulls the daemon's storage config from a `spawntree-host` server and
 * applies it via `StorageManager.applyConfig`. Designed for daemons that
 * want their replication setup centrally managed: the host owns the
 * canonical config, every daemon boot reconciles to it, and the daemon
 * stays useful when the host is unreachable (it just keeps running with
 * whatever was last applied).
 *
 * Lifecycle:
 *   - `start()` kicks off the first fetch on a fresh microtask. Caller
 *     does not need to await it — daemon boot proceeds immediately.
 *   - On success: `applyConfig` reconciles, status updates to `synced`,
 *     loop schedules the next refresh after `pollIntervalMs`.
 *   - On `404 NO_CONFIG_SET`: no operator-provisioned config yet. Status
 *     becomes `awaiting_config`, daemon does not touch its existing
 *     `storage.json`. Retries on the same poll interval.
 *   - On any other failure: status becomes `error`, retry uses
 *     exponential backoff (5s → 30s → 2m → 10m cap).
 *   - `stop()` cancels the next scheduled fetch and waits for any in-flight
 *     request to finish.
 */
export type HostSyncStatus =
  | { state: "idle" }
  | { state: "fetching"; since: string }
  | { state: "synced"; lastSyncAt: string; daemonLabel: string | null }
  | { state: "awaiting_config"; lastCheckAt: string; daemonLabel: string | null }
  | { state: "error"; lastErrorAt: string; error: string; nextRetryAt: string };

export interface HostConfigSyncOptions {
  binding: HostBinding;
  manager: StorageManager;
  /** Override the default fetch — for tests, mostly. */
  fetch?: typeof fetch;
  /** Steady-state poll interval after a successful sync. Default 5 minutes. */
  pollIntervalMs?: number;
  /** Backoff sequence on error. Default 5s, 30s, 2m, 10m (last value repeats). */
  backoffSequenceMs?: ReadonlyArray<number>;
  /** Logger. Defaults to stderr-prefix logger. */
  logger?: (
    level: "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
}

const DEFAULT_POLL_MS = 5 * 60 * 1000;
const DEFAULT_BACKOFF_MS: ReadonlyArray<number> = [5_000, 30_000, 2 * 60_000, 10 * 60_000];

export class HostConfigSync {
  private readonly binding: HostBinding;
  private readonly manager: StorageManager;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly backoffSequenceMs: ReadonlyArray<number>;
  private readonly logger: NonNullable<HostConfigSyncOptions["logger"]>;

  private status: HostSyncStatus = { state: "idle" };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private consecutiveErrors = 0;

  constructor(options: HostConfigSyncOptions) {
    this.binding = options.binding;
    this.manager = options.manager;
    this.fetchImpl = options.fetch ?? fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.backoffSequenceMs = options.backoffSequenceMs ?? DEFAULT_BACKOFF_MS;
    this.logger = options.logger
      ?? ((level, msg, fields) => {
        process.stderr.write(
          `[spawntree-daemon] host-sync.${level} ${msg}${fields ? " " + JSON.stringify(fields) : ""}\n`,
        );
      });
  }

  /**
   * Schedule the first fetch on the next microtask and return immediately.
   * Daemon boot is NOT blocked on the host being reachable — that's the
   * whole point of having the persisted local cache as a fallback.
   */
  start(): void {
    if (this.stopped) return;
    // Microtask delay so the daemon's HTTP server is up before we issue
    // any outbound request. Keeps boot logs in the right order.
    queueMicrotask(() => this.tick());
  }

  /**
   * Stop scheduling new fetches and wait for any in-flight request to
   * finish. Idempotent.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }
  }

  /** Snapshot of the current sync state — surfaced via `/api/v1/storage`. */
  getStatus(): HostSyncStatus {
    return this.status;
  }

  /** Force a refresh now. Returns when the fetch completes (success or fail). */
  async refreshNow(): Promise<void> {
    if (this.stopped) return;
    await this.tick();
  }

  // ─── private ───────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      // Coalesce overlapping calls: the running fetch will pick up the
      // latest state by the time it returns.
      return this.inFlight;
    }
    this.status = { state: "fetching", since: nowIso() };
    this.inFlight = this.runOne();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async runOne(): Promise<void> {
    const url = this.endpointUrl();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.binding.key}`,
          Accept: "application/json",
        },
      });
    } catch (err) {
      this.recordError(err instanceof Error ? err.message : String(err));
      return;
    }

    if (response.status === 404) {
      // Operator hasn't pushed a config yet. Keep the daemon's existing
      // local storage.json as-is. We still touch the status so admins
      // can see the daemon is talking to the host — just nothing to do.
      let body: { daemon?: { label?: string } } | null = null;
      try {
        body = (await response.json()) as { daemon?: { label?: string } };
      } catch {
        body = null;
      }
      const label = body?.daemon?.label ?? null;
      this.status = {
        state: "awaiting_config",
        lastCheckAt: nowIso(),
        daemonLabel: label,
      };
      this.consecutiveErrors = 0;
      this.scheduleNext(this.pollIntervalMs);
      this.logger("info", "host has no config provisioned for this daemon yet", {
        url,
        label,
      });
      return;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      this.recordError(`host returned ${response.status}: ${body.slice(0, 200)}`);
      return;
    }

    let payload: { config?: StorageConfig; daemon?: { label?: string } };
    try {
      payload = (await response.json()) as typeof payload;
    } catch (err) {
      this.recordError(`host response was not JSON: ${err instanceof Error ? err.message : err}`);
      return;
    }

    if (!payload.config) {
      this.recordError("host response missing `config` field");
      return;
    }

    try {
      await this.manager.applyConfig(payload.config);
    } catch (err) {
      this.recordError(`applyConfig failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    this.status = {
      state: "synced",
      lastSyncAt: nowIso(),
      daemonLabel: payload.daemon?.label ?? null,
    };
    this.consecutiveErrors = 0;
    this.scheduleNext(this.pollIntervalMs);
    this.logger("info", "host config applied", {
      url,
      label: payload.daemon?.label,
      replicators: payload.config.replicators.length,
      primary: payload.config.primary.id,
    });
  }

  private recordError(message: string): void {
    const delay = this.backoffSequenceMs[
      Math.min(this.consecutiveErrors, this.backoffSequenceMs.length - 1)
    ] ?? this.backoffSequenceMs[this.backoffSequenceMs.length - 1] ?? 60_000;
    const at = nowIso();
    this.status = {
      state: "error",
      lastErrorAt: at,
      error: message,
      nextRetryAt: new Date(Date.now() + delay).toISOString(),
    };
    this.consecutiveErrors++;
    this.scheduleNext(delay);
    this.logger("warn", "host sync failed; will retry", {
      error: message,
      nextRetryMs: delay,
      consecutiveErrors: this.consecutiveErrors,
    });
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    // Don't keep the event loop alive just to retry sync.
    this.timer.unref?.();
  }

  private endpointUrl(): string {
    const base = this.binding.url.replace(/\/+$/, "");
    return `${base}/api/daemons/me/config`;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
