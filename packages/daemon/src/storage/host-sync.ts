import type { Client as LibSqlClient } from "@libsql/client";
import type { StorageConfig } from "spawntree-core";
import { schema as catalogSchema } from "spawntree-core";
import { and, eq, gte, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import type { HostBinding } from "../state/global-state.ts";
import type { StorageManager } from "./manager.ts";

/**
 * Pulls the daemon's storage config from a `spawntree-host` server and
 * applies it via `StorageManager.applyConfig`. Designed for daemons that
 * want their upstream sync setup centrally managed: the host owns the
 * canonical sync config, every daemon boot reconciles to it, and the daemon
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
 *   - On `409 FINGERPRINT_MISMATCH`: this dh_ key is already bound to a
 *     different physical machine. Status becomes a TERMINAL `error` —
 *     the loop exits and refuses to retry. The daemon must be restarted
 *     (typically after the operator either mints a fresh key on this
 *     box or has an admin reset the machine fingerprint).
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
  | { state: "error"; lastErrorAt: string; error: string; nextRetryAt: string; terminal?: boolean };

export interface HostConfigSyncOptions {
  binding: HostBinding;
  manager: StorageManager;
  /** Override the default fetch — for tests, mostly. */
  fetch?: typeof fetch;
  /** Steady-state poll interval after a successful sync. Default 5 minutes. */
  pollIntervalMs?: number;
  /**
   * Presence-pulse interval — how often the daemon POSTs
   * `/daemons/me/heartbeat` to refresh `lastSeenAt`, independent of the
   * config poll. Default 30s, well inside Studio's 2-minute "online" window.
   */
  presenceIntervalMs?: number;
  /**
   * How often the daemon pushes its session list to the host.
   * Default 10s — matches the legacy machine-package sync cadence.
   */
  sessionsSyncIntervalMs?: number;
  /** Backoff sequence on error. Default 5s, 30s, 2m, 10m (last value repeats). */
  backoffSequenceMs?: ReadonlyArray<number>;
  /** Logger. Defaults to stderr-prefix logger. */
  logger?: (
    level: "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
  /**
   * Override the per-machine fingerprint. Test-only — production reads the
   * stable OS machine id via `node-machine-id` and hashes it with SHA-256.
   *
   * Must be a 32-character hex string (the hashed form). When set, no OS
   * lookup happens. Set via `SPAWNTREE_FINGERPRINT_OVERRIDE` env from the
   * CLI entry; tests construct `HostConfigSync` with it directly.
   */
  fingerprintOverride?: string;
  /**
   * Called when the host returns **410 Gone** — meaning the daemon's key
   * has been revoked (typically because the machine was soft-deleted on the
   * host). The callback should clear the persisted host binding so the next
   * daemon startup prompts the operator to re-register instead of looping
   * on rejections.
   *
   * In production `server-main.ts` wires this to `clearHostBinding()`. In
   * tests, pass a spy to assert it is called exactly once on a 410 and
   * never called on other error codes.
   */
  onGone?: () => void;
}

const DEFAULT_POLL_MS = 5 * 60 * 1000;
const DEFAULT_PRESENCE_MS = 30 * 1000;
const DEFAULT_SESSIONS_SYNC_MS = 10 * 1000;
const DEFAULT_BACKOFF_MS: ReadonlyArray<number> = [5_000, 30_000, 2 * 60_000, 10 * 60_000];

/**
 * Statuses the host treats as "live" — mirrors the host reconcile set
 * (packages/host/src/routes/spawntree.ts) and Studio's conflict query. A live
 * session must ALWAYS be in the sync snapshot: the host marks any live
 * ai_sessions row ABSENT from a snapshot as completed, so omitting one would
 * false-terminate it. The daemon's own catalog uses `active`; the rest are
 * accepted for parity with the host-side status vocabulary.
 */
const LIVE_SESSION_STATUSES = ["active", "streaming", "idle", "waiting"];

/**
 * On the first session sync after a daemon (re)start the in-memory watermark
 * is unknown, so terminal sessions changed within this window are backfilled.
 * Anything older the host already has terminal (or its reconcile nets it out),
 * so this bounds the post-restart payload instead of resending the daemon's
 * entire historical catalog.
 */
const SESSIONS_SYNC_RESTART_BACKFILL_MS = 5 * 60 * 1000;

export class HostConfigSync {
  private readonly binding: HostBinding;
  private readonly manager: StorageManager;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly presenceIntervalMs: number;
  private readonly sessionsSyncIntervalMs: number;
  private readonly backoffSequenceMs: ReadonlyArray<number>;
  private readonly logger: NonNullable<HostConfigSyncOptions["logger"]>;
  private readonly fingerprintOverride: string | undefined;
  private readonly onGone: (() => void) | undefined;

  private status: HostSyncStatus = { state: "idle" };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceInFlight: Promise<void> | null = null;
  private sessionsSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionsSyncInFlight: Promise<void> | null = null;
  private stopped = false;
  private terminal = false;
  private consecutiveErrors = 0;
  private cachedFingerprint: string | null = null;
  // Incremental watermark for session sync: the timestamp of the last
  // CONFIRMED (2xx) sync. Each pulse sends live sessions plus anything changed
  // since this point, so steady-state cost tracks current activity, not the
  // daemon's entire history. `undefined` until the first sync seeds it.
  private sessionsSyncWatermark: string | undefined;

  constructor(options: HostConfigSyncOptions) {
    this.binding = options.binding;
    this.manager = options.manager;
    this.fetchImpl = options.fetch ?? fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.presenceIntervalMs = options.presenceIntervalMs ?? DEFAULT_PRESENCE_MS;
    this.sessionsSyncIntervalMs = options.sessionsSyncIntervalMs ?? DEFAULT_SESSIONS_SYNC_MS;
    this.backoffSequenceMs = options.backoffSequenceMs ?? DEFAULT_BACKOFF_MS;
    this.logger =
      options.logger ??
      ((level, msg, fields) => {
        process.stderr.write(
          `[spawntree-daemon] host-sync.${level} ${msg}${fields ? " " + JSON.stringify(fields) : ""}\n`,
        );
      });
    this.fingerprintOverride = options.fingerprintOverride;
    this.onGone = options.onGone;
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
    queueMicrotask(() => {
      void this.tick();
      void this.pulsePresence();
      void this.syncSessions();
    });
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
    if (this.presenceTimer) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
    if (this.sessionsSyncTimer) {
      clearTimeout(this.sessionsSyncTimer);
      this.sessionsSyncTimer = null;
    }
    if (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }
    if (this.presenceInFlight) {
      await this.presenceInFlight.catch(() => undefined);
    }
    if (this.sessionsSyncInFlight) {
      await this.sessionsSyncInFlight.catch(() => undefined);
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

  /** Force a session sync now. Returns when the POST completes (success or fail). */
  async syncSessionsNow(): Promise<void> {
    if (this.stopped) return;
    await this.syncSessions();
  }

  // ─── private ───────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.stopped || this.terminal) return;
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

  private async resolveFingerprint(): Promise<string> {
    if (this.cachedFingerprint) return this.cachedFingerprint;
    if (this.fingerprintOverride) {
      this.cachedFingerprint = this.fingerprintOverride;
      return this.cachedFingerprint;
    }
    // Lazy import: keeps tests that supply `fingerprintOverride` from
    // requiring `node-machine-id` to be installed. The package is a CJS
    // module so dynamic `import()` puts named exports on `.default` —
    // accept both forms so it works regardless of how Node's interop
    // resolves it on a given runtime version.
    const machineIdMod = (await import("node-machine-id")) as
      | { machineId?: (original?: boolean) => Promise<string> }
      | { default: { machineId: (original?: boolean) => Promise<string> } };
    const machineIdFn =
      "machineId" in machineIdMod && typeof machineIdMod.machineId === "function"
        ? machineIdMod.machineId
        : "default" in machineIdMod
          ? machineIdMod.default.machineId
          : null;
    if (!machineIdFn) {
      throw new Error("node-machine-id module missing `machineId` export");
    }
    const raw = await machineIdFn(true);
    this.cachedFingerprint = await sha256Hex32(raw);
    return this.cachedFingerprint;
  }

  private async runOne(): Promise<void> {
    const url = this.endpointUrl();
    let fingerprint: string;
    try {
      fingerprint = await this.resolveFingerprint();
    } catch (err) {
      this.recordError(
        `failed to read machine fingerprint: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.binding.key}`,
          Accept: "application/json",
          "X-Spawntree-Fingerprint": fingerprint,
        },
      });
    } catch (err) {
      this.recordError(err instanceof Error ? err.message : String(err));
      return;
    }

    // The 30s presence pulse may have gone terminal (409/410) while this
    // config fetch was in flight — don't let a stale success overwrite the
    // terminal error status.
    if (this.terminal) return;

    if (response.status === 409) {
      // Hard-fail: this dh_ key is bound to a different machine. Do NOT
      // retry — the daemon process must exit (or be restarted with a
      // fresh credential) so an attacker can't slowly probe the host
      // with a stolen key from a new box.
      let detail = "";
      try {
        const body = (await response.json()) as { error?: string; code?: string };
        detail = body.error ?? body.code ?? "FINGERPRINT_MISMATCH";
      } catch {
        detail = "FINGERPRINT_MISMATCH";
      }
      this.markTerminal(
        `This daemon key is already bound to a different machine. Mint a fresh key on app.gitenv.dev for this box, or have an admin reset the machine fingerprint. (host: ${detail})`,
      );
      this.logger("error", "fingerprint mismatch — host config sync halted", { url });
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

    if (response.status === 410) {
      // The daemon's key has been revoked — the machine was removed on the
      // host. This is terminal: stop polling and clear the stored binding so
      // the operator is prompted to re-register on the next daemon start
      // instead of looping on 410s indefinitely.
      let detail = "";
      try {
        const body = (await response.json()) as { error?: string; code?: string };
        detail = body.error ?? body.code ?? "KEY_REVOKED";
      } catch {
        detail = "KEY_REVOKED";
      }
      this.markTerminal(
        `This daemon key has been revoked (machine removed on host). Delete ~/.spawntree/host.json and re-register to continue. (host: ${detail})`,
      );
      this.logger("error", "daemon key revoked — host config sync halted; clearing binding", {
        url,
      });
      // Clear the persisted binding so the next startup doesn't re-try with
      // a revoked key. The caller (server-main) wires this to clearHostBinding().
      this.onGone?.();
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
    this.logger("info", "host sync config applied", {
      url,
      label: payload.daemon?.label,
      syncMethod: payload.config.syncMethod,
    });
  }

  /**
   * Enter the final error state: surface `message` via `getStatus()`, set the
   * terminal flag, and cancel any pending config-poll retry. Used by both the
   * config poll and the presence pulse — whichever sees the 409/410 first —
   * so /api/v1/storage never keeps reporting a stale pre-failure state.
   */
  private markTerminal(message: string): void {
    this.terminal = true;
    this.status = {
      state: "error",
      lastErrorAt: nowIso(),
      error: message,
      nextRetryAt: nowIso(),
      terminal: true,
    };
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private recordError(message: string): void {
    const delay =
      this.backoffSequenceMs[Math.min(this.consecutiveErrors, this.backoffSequenceMs.length - 1)] ??
      this.backoffSequenceMs[this.backoffSequenceMs.length - 1] ??
      60_000;
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
    if (this.stopped || this.terminal) return;
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

  private presenceUrl(): string {
    const base = this.binding.url.replace(/\/+$/, "");
    return `${base}/api/daemons/me/heartbeat`;
  }

  /**
   * Presence pulse — a lightweight POST to `/daemons/me/heartbeat` on a fast,
   * fixed cadence (default 30s), independent of the config poll. Keeps the
   * machine inside Studio's 2-minute "online" window without coupling
   * presence to the slow config fetch. Coalesces overlapping calls.
   */
  private async pulsePresence(): Promise<void> {
    if (this.stopped || this.terminal) return;
    if (this.presenceInFlight) return this.presenceInFlight;
    this.presenceInFlight = this.runPresenceOnce();
    try {
      await this.presenceInFlight;
    } finally {
      this.presenceInFlight = null;
    }
  }

  private async runPresenceOnce(): Promise<void> {
    let fingerprint: string;
    try {
      fingerprint = await this.resolveFingerprint();
    } catch {
      // Can't read the fingerprint yet — retry on the steady cadence.
      this.schedulePresence(this.presenceIntervalMs);
      return;
    }

    try {
      const response = await this.fetchImpl(this.presenceUrl(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.binding.key}`,
          "X-Spawntree-Fingerprint": fingerprint,
        },
      });
      if (response.status === 409) {
        // FINGERPRINT_MISMATCH — same terminal semantics as the config poll:
        // the key is bound to a different machine. Stop pulsing.
        this.markTerminal(
          `This daemon key is already bound to a different machine. Mint a fresh key on app.gitenv.dev for this box, or have an admin reset the machine fingerprint. (host: FINGERPRINT_MISMATCH)`,
        );
        this.logger("error", "presence pulse rejected (fingerprint mismatch); stopping", {
          status: response.status,
        });
        return;
      }
      if (response.status === 410) {
        // KEY_REVOKED — same terminal semantics as the config poll: the key
        // was revoked because the machine was removed. Clear the binding.
        // The 30s pulse usually sees the 410 before the 5-minute config poll
        // does, and `terminal` suppresses future polls — so the error status
        // must be set HERE or /api/v1/storage keeps reporting the stale
        // pre-revocation state forever.
        this.markTerminal(
          `This daemon key has been revoked (machine removed on host). Delete ~/.spawntree/host.json and re-register to continue. (host: KEY_REVOKED)`,
        );
        this.logger(
          "error",
          "presence pulse rejected (key revoked — machine removed); clearing binding and stopping",
          { status: response.status },
        );
        this.onGone?.();
        return;
      }
      // 204 success, or any transient non-terminal status: keep pulsing.
    } catch {
      // Network blip — do NOT back off like the config poll. Stay on the fast
      // cadence so presence recovers inside the 2-minute window.
    }
    this.schedulePresence(this.presenceIntervalMs);
  }

  private schedulePresence(delayMs: number): void {
    if (this.stopped || this.terminal) return;
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      void this.pulsePresence();
    }, delayMs);
    // Don't keep the event loop alive just to pulse presence.
    this.presenceTimer.unref?.();
  }

  /**
   * Session state sync — POST the daemon's current session list to the host
   * every `sessionsSyncIntervalMs` (default 10s) so the host's ai_sessions
   * table (and therefore Studio's org-wide session list via PowerSync) stays
   * current. Coalesces overlapping calls. Skips silently when sqlite storage
   * isn't started yet (the catalog DB isn't available). Non-terminal
   * errors are swallowed — a missed sync is harmless compared to crashing.
   *
   * Stays on the steady cadence regardless of transient errors (unlike the
   * config poll which backs off). Session data is cheap to re-send and the
   * host is idempotent on upserts.
   */
  private async syncSessions(): Promise<void> {
    if (this.stopped || this.terminal) return;
    if (this.sessionsSyncInFlight) return this.sessionsSyncInFlight;
    this.sessionsSyncInFlight = this.runSessionsSyncOnce();
    try {
      await this.sessionsSyncInFlight;
    } finally {
      this.sessionsSyncInFlight = null;
    }
  }

  private async runSessionsSyncOnce(): Promise<void> {
    // Only push when we have an active sqlite catalog DB.
    let client: LibSqlClient;
    try {
      client = this.manager.client;
    } catch {
      // Storage not started yet — skip this cycle.
      this.scheduleSessionsSync(this.sessionsSyncIntervalMs);
      return;
    }

    // Bound the snapshot so the 10s pulse doesn't grow with the daemon's
    // entire history. Always include live sessions (the host reconcile
    // terminates any live row absent from a snapshot, so they must never be
    // omitted), plus anything changed since the last confirmed sync — which
    // catches completions and short-lived sessions for the org session list.
    // `nextWatermark` is captured before the read and only committed on a 2xx
    // below, so a failed or skipped pulse never drops a change.
    if (this.sessionsSyncWatermark === undefined) {
      this.sessionsSyncWatermark = new Date(
        Date.now() - SESSIONS_SYNC_RESTART_BACKFILL_MS,
      ).toISOString();
    }
    const cutoff = this.sessionsSyncWatermark;
    const nextWatermark = nowIso();

    let sessions: Array<typeof catalogSchema.sessions.$inferSelect>;
    let filesBySession = new Map<string, string[]>();
    try {
      const db = drizzle(client, { schema: catalogSchema });
      sessions = await db
        .select()
        .from(catalogSchema.sessions)
        .where(
          or(
            inArray(catalogSchema.sessions.status, LIVE_SESSION_STATUSES),
            gte(catalogSchema.sessions.updatedAt, cutoff),
          ),
        );
      filesBySession = await collectEditedFiles(db, sessions);
    } catch {
      // Catalog table not bootstrapped yet — skip this cycle.
      this.scheduleSessionsSync(this.sessionsSyncIntervalMs);
      return;
    }

    // An empty snapshot is still synced: the host needs to learn when the
    // last local session was deleted, otherwise its mirror keeps stale rows
    // forever. (The catalog being unreadable is handled above and skips.)

    let fingerprint: string;
    try {
      fingerprint = await this.resolveFingerprint();
    } catch {
      this.scheduleSessionsSync(this.sessionsSyncIntervalMs);
      return;
    }

    const payload = sessions.map((s) => ({
      sourceId: s.sessionId,
      provider: s.provider,
      status: s.status,
      title: s.title ?? null,
      gitBranch: s.gitBranch ?? null,
      worktreePath: s.workingDirectory,
      headSha: s.gitHeadCommit ?? null,
      // The host resolves the remote to its repo record so repo-scoped
      // consumers (session lists, conflict detection) can find the session.
      gitRemoteUrl: s.gitRemoteUrl ?? null,
      totalTurns: s.totalTurns,
      startedAt: s.startedAt ?? null,
      workingFiles: filesBySession.get(s.sessionId) ?? [],
    }));

    try {
      const url = this.sessionsSyncUrl();
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.binding.key}`,
          "Content-Type": "application/json",
          "X-Spawntree-Fingerprint": fingerprint,
        },
        body: JSON.stringify({ sessions: payload }),
      });
      if (response.status === 409) {
        // FINGERPRINT_MISMATCH — terminal, same semantics as the config poll
        // and presence pulse. Go through markTerminal (not a bare `terminal`
        // flag) so /api/v1/storage surfaces the hard failure even when the
        // 10s session sync is the first call to see the 409 — otherwise
        // `terminal` suppresses the config/presence retries that would have
        // recorded the error status.
        this.markTerminal(
          `This daemon key is already bound to a different machine. Mint a fresh key on app.gitenv.dev for this box, or have an admin reset the machine fingerprint. (host: FINGERPRINT_MISMATCH)`,
        );
        this.logger("error", "sessions sync rejected (fingerprint mismatch); stopping", {
          status: response.status,
        });
        return;
      }
      if (response.ok) {
        // Commit the watermark only on a confirmed sync. A failed POST leaves
        // it untouched so the same window is re-sent next pulse, and skipped
        // cycles never advance it — no change is ever dropped.
        this.sessionsSyncWatermark = nextWatermark;
      }
      // Any non-2xx is a transient error — stay on the steady cadence.
    } catch {
      // Network blip — stay on cadence, no backoff.
    }
    this.scheduleSessionsSync(this.sessionsSyncIntervalMs);
  }

  private sessionsSyncUrl(): string {
    const base = this.binding.url.replace(/\/+$/, "");
    // Use the same canonical prefix as the config/heartbeat endpoints.
    // Hosts that expose a shorter alias at /api/daemons/me/sessions/sync
    // can override this via subclassing, but the canonical path is always
    // available and is the safe default.
    return `${base}/api/daemons/me/sessions/sync`;
  }

  private scheduleSessionsSync(delayMs: number): void {
    if (this.stopped || this.terminal) return;
    if (this.sessionsSyncTimer) clearTimeout(this.sessionsSyncTimer);
    this.sessionsSyncTimer = setTimeout(() => {
      this.sessionsSyncTimer = null;
      void this.syncSessions();
    }, delayMs);
    // Don't keep the event loop alive just to sync sessions.
    this.sessionsSyncTimer.unref?.();
  }
}

/**
 * Collect the set of files each session has edited, derived from
 * `session_tool_calls` rows with `toolKind = "file_edit"`. The hosting
 * service uses this to detect concurrent sessions editing the same files.
 *
 * Adapters store the tool input under different keys (`path` for Codex
 * file changes, `file_path` / `filePath` for ACP raw inputs), so the
 * extractor tolerates all of them and skips rows it can't interpret.
 *
 * Paths are normalized to be relative to the session's working directory:
 * some adapters report repo-relative paths and others absolute ones, and
 * cross-session comparison only works when both sessions describe the same
 * file with the same string.
 */
async function collectEditedFiles(
  db: ReturnType<typeof drizzle<typeof catalogSchema>>,
  sessions: Array<typeof catalogSchema.sessions.$inferSelect>,
): Promise<Map<string, string[]>> {
  // Working files only feed the host's concurrent-edit conflict detection,
  // which only considers live sessions — the host zeroes `workingFiles` the
  // moment a session goes terminal. Scanning tool calls for completed/errored
  // sessions would make this 10s pulse scale with the daemon's entire
  // history instead of what's currently running.
  // Live set must match the host's reconcile statuses and Studio's conflict
  // query (LIVE_SESSION_STATUSES) — omitting `active` here would send active
  // sessions with empty workingFiles, so a concurrent edit from an `active`
  // session never reaches the conflict banner.
  const liveSessionIds = sessions
    .filter((s) => LIVE_SESSION_STATUSES.includes(s.status))
    .map((s) => s.sessionId);
  if (liveSessionIds.length === 0) return new Map();

  // Only edits that actually ran to completion count: awaiting-approval,
  // rejected, and errored tool calls never touched the worktree, and two
  // sessions that merely *requested* the same edit are not a real conflict.
  const rows = await db
    .select({
      sessionId: catalogSchema.sessionToolCalls.sessionId,
      arguments: catalogSchema.sessionToolCalls.arguments,
    })
    .from(catalogSchema.sessionToolCalls)
    .where(
      and(
        inArray(catalogSchema.sessionToolCalls.sessionId, liveSessionIds),
        eq(catalogSchema.sessionToolCalls.toolKind, "file_edit"),
        eq(catalogSchema.sessionToolCalls.status, "completed"),
      ),
    );

  const workingDirBySession = new Map(sessions.map((s) => [s.sessionId, s.workingDirectory]));

  const filesBySession = new Map<string, Set<string>>();
  for (const row of rows) {
    const file = extractEditedFilePath(row.arguments);
    if (!file) continue;
    const normalized = normalizeEditedFilePath(file, workingDirBySession.get(row.sessionId));
    let files = filesBySession.get(row.sessionId);
    if (!files) {
      files = new Set();
      filesBySession.set(row.sessionId, files);
    }
    files.add(normalized);
  }

  const result = new Map<string, string[]>();
  for (const [sessionId, files] of filesBySession) {
    result.set(sessionId, [...files].sort());
  }
  return result;
}

/**
 * Make an edited-file path comparable across sessions: absolute paths under
 * the session's working directory become relative to it; everything else is
 * passed through unchanged (already-relative paths, or absolute paths
 * outside the working tree, which are still meaningful as-is).
 *
 * Separators are normalized to `/` first so Windows daemons (`C:\repo` +
 * `C:\repo\src\file.ts`) strip the same way POSIX ones do — and so the
 * resulting relative paths compare equal across platforms.
 */
function normalizeEditedFilePath(file: string, workingDirectory: string | undefined): string {
  const normalizedFile = file.replaceAll("\\", "/");
  if (!workingDirectory) return normalizedFile;
  const normalizedDir = workingDirectory.replaceAll("\\", "/");
  const dir = normalizedDir.endsWith("/") ? normalizedDir : `${normalizedDir}/`;
  return normalizedFile.startsWith(dir) ? normalizedFile.slice(dir.length) : normalizedFile;
}

function extractEditedFilePath(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "abs_path", "absPath"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Hash an arbitrary string with SHA-256 and return the first 32 hex chars.
 * That truncation is deliberate: it's still 128 bits of entropy (collision
 * resistant for our population of devices) and keeps the wire header
 * compact. The raw OS machine id never leaves the box.
 */
async function sha256Hex32(value: string): Promise<string> {
  // globalThis.crypto.subtle is available in Node 16+ and all modern
  // runtimes the daemon supports. Avoids pulling in node:crypto for a
  // workspace that should stay browser-buildable.
  const encoded = new TextEncoder().encode(value);
  const buf = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex.slice(0, 32);
}
