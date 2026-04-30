import type {
  ACPAdapter,
  ACPRequestPermissionRequest,
  ACPRequestPermissionResponse,
  ACPSessionDetail,
  CatalogDb,
  DiscoveredSession,
  SessionEvent,
  SessionInfo,
  SessionToolCallData,
  ToolCallApprovalOption,
} from "spawntree-core";
import {
  ClaudeCodeAdapter,
  CodexACPAdapter,
  ProviderCapabilityError,
  schema as catalogSchema,
  SessionDeleteUnsupportedError,
  UnknownProviderError,
} from "spawntree-core";
import { drizzle } from "drizzle-orm/libsql";
import type { DomainEvents } from "../events/domain-events.ts";
import { applyCatalogSchema } from "../catalog/queries.ts";
import type { StorageManager } from "../storage/manager.ts";
import {
  abortPendingApprovalsOnRestart,
  deletePersistedSession,
  getPersistedSession,
  hydrateTurnContent,
  listPersistedSessions,
  persistSessionEvent,
  upsertSession,
} from "./persistence.ts";

/** Pending approval entry held while a tool call awaits user response. */
interface PendingApproval {
  resolver: (response: ACPRequestPermissionResponse) => void;
  options: ToolCallApprovalOption[];
  sessionId: string;
}

/**
 * Manages the lifecycle of ACP adapters and routes session operations to
 * the correct provider. Publishes normalized SessionEvents into the daemon's
 * DomainEvents bus so the SSE stream carries real-time agent updates.
 *
 * One adapter instance per provider — they are started lazily on first use
 * and shut down when the daemon shuts down.
 */
export class SessionManager {
  private readonly adapters = new Map<string, ACPAdapter>();
  private readonly events: DomainEvents;
  /**
   * Per-provider event unsubscribe functions. Map keyed by provider name
   * so `registerAdapter` can find the old subscription when replacing an
   * adapter and tear it down cleanly. An `Array<() => void>` wouldn't
   * let us identify which unsubscriber belonged to which provider.
   */
  private readonly unsubscribers = new Map<string, () => void>();
  /**
   * sessionId → provider name cache. Populated on createSession and
   * opportunistically during discoverSessions so we avoid iterating every
   * adapter (which would spawn every adapter's subprocess) on each call.
   */
  private readonly sessionIndex = new Map<string, string>();
  private readonly subscribedProviders = new Set<string>();

  /**
   * When present, session events are mirrored into the catalog DB so
   * sessions survive daemon restart, ride along with the s3-snapshot
   * replicator, and are queryable by external Drizzle clients.
   *
   * Null when the manager is built without a StorageManager (older test
   * code paths) — in that case sessions are in-memory only.
   */
  private readonly catalog: CatalogDb | null;
  private readonly storage: StorageManager | null;
  /**
   * Per-session promise chain so adapter events land in the catalog in
   * the order they were emitted. Without this, `turn_completed` may
   * race the `turn_started` INSERT and run its UPDATE against 0 rows.
   */
  private readonly persistQueues = new Map<string, Promise<unknown>>();
  /**
   * Tool calls awaiting human approval — keyed by `toolCallId`. The value
   * is the Promise resolver fed back to the ACP `request_permission` RPC
   * once the user clicks Allow/Deny in the Studio. If the daemon shuts
   * down with entries here, the agent is left waiting forever, so we
   * also clear the corresponding rows on startup (see `start()`).
   */
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  constructor(events: DomainEvents, options: { storage?: StorageManager } = {}) {
    this.events = events;
    this.storage = options.storage ?? null;
    this.catalog = options.storage
      ? drizzle(options.storage.client, { schema: catalogSchema })
      : null;

    // Register built-in adapters. Additional adapters can be added via
    // `registerAdapter()` before the manager is used.
    this.adapters.set(
      "claude-code",
      new ClaudeCodeAdapter({
        permissionHandler: (params) => this.handlePermissionRequest(params),
      }),
    );
    this.adapters.set("codex", new CodexACPAdapter());
  }

  /**
   * Bootstrap the catalog schema for the session tables. Called once at
   * daemon boot from `server-main.ts` after the StorageManager has opened
   * its primary. Safe to skip (and is in tests) if the manager was built
   * without a StorageManager — `applyCatalogSchema` is idempotent so
   * double-bootstrap from the DaemonService layer is a no-op.
   */
  async start(): Promise<void> {
    if (this.storage) {
      await applyCatalogSchema(this.storage.client);
      // Anything left in `awaiting_approval` is orphaned — the agent that
      // was waiting on the resolver died with the previous daemon process.
      // Mark them as error so the UI doesn't show a forever-pending row.
      if (this.catalog) {
        await abortPendingApprovalsOnRestart(this.catalog).catch((err) => {
          process.stderr.write(
            `[spawntree-daemon] failed to clear pending approvals on startup: ${String(err)}\n`,
          );
        });
      }
    }
  }

  /**
   * ACP permission handler — invoked by the Claude Code adapter when the
   * agent requests permission to run a tool. Persists the tool call as
   * `awaiting_approval`, broadcasts the event over SSE so the Studio can
   * render Allow/Deny buttons, and pends a Promise. The Promise resolves
   * when `respondToToolCall()` is called (typically from the HTTP route
   * `POST /sessions/:id/tool-calls/:toolCallId/respond`).
   *
   * If the same toolCallId already has a pending entry, the previous
   * resolver is cancelled (resolved with `{ outcome: "cancelled" }`) so
   * the older Promise unblocks instead of leaking.
   */
  private handlePermissionRequest(
    params: ACPRequestPermissionRequest,
  ): Promise<ACPRequestPermissionResponse> {
    const toolCallId = params.toolCall.toolCallId;
    const sessionId = params.sessionId;
    process.stderr.write(
      `[spawntree-daemon] permission requested: session=${sessionId} toolCall=${toolCallId} title=${params.toolCall.title ?? "?"} kind=${params.toolCall.kind ?? "?"} options=${params.options.map((o) => o.kind).join(",")}\n`,
    );
    const options: ToolCallApprovalOption[] = params.options.map(
      (o: ACPRequestPermissionRequest["options"][number]) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind as ToolCallApprovalOption["kind"],
      }),
    );
    const toolCall = approvalToolCallFromRequest(params, options);

    // Publish synthetic SessionEvent so the same SSE pipeline + persistence
    // queue handle it (status row in DB ends up "awaiting_approval"). We
    // don't go through the adapter's own onSessionEvent emit because the
    // adapter itself doesn't track this transition — the daemon owns it.
    const event: SessionEvent = {
      type: "tool_call_awaiting_approval",
      sessionId,
      toolCall,
    };
    this.events.publishSessionEvent(event, "claude-code");
    if (this.catalog) {
      void this.enqueuePersist(sessionId, () =>
        persistSessionEvent(this.catalog!, event).catch((err) => {
          process.stderr.write(
            `[spawntree-daemon] persist awaiting_approval failed: ${String(err)}\n`,
          );
        }),
      );
    }

    return new Promise<ACPRequestPermissionResponse>((resolve) => {
      const previous = this.pendingApprovals.get(toolCallId);
      if (previous) {
        // Stale resolver from an earlier (re-tried?) request — cancel it
        // so its Promise unblocks instead of leaking.
        previous.resolver({ outcome: { outcome: "cancelled" } });
      }
      this.pendingApprovals.set(toolCallId, { resolver: resolve, options, sessionId });
    });
  }

  /**
   * Resolve a pending approval prompt with the user's choice. Throws if
   * the toolCallId has no pending entry — the request either already
   * resolved (race), the daemon restarted, or the agent never asked.
   */
  async respondToToolCall(
    sessionId: string,
    toolCallId: string,
    response: ACPRequestPermissionResponse,
  ): Promise<void> {
    const pending = this.pendingApprovals.get(toolCallId);
    if (!pending) {
      throw new Error(`No pending approval for tool call ${toolCallId}`);
    }
    if (pending.sessionId !== sessionId) {
      throw new Error(`Tool call ${toolCallId} does not belong to session ${sessionId}`);
    }
    this.pendingApprovals.delete(toolCallId);
    pending.resolver(response);
  }

  /**
   * Patch any tool calls in a SessionDetail with their pending-approval
   * state. The adapter's in-memory tracking does not know that a
   * permission request is in flight — the daemon owns that — so without
   * this overlay a fresh `GET /sessions/:id` would show the tool as
   * `in_progress` instead of `awaiting_approval`.
   */
  private patchPendingApprovals(detail: ACPSessionDetail): ACPSessionDetail {
    if (this.pendingApprovals.size === 0) return detail;
    return {
      ...detail,
      toolCalls: detail.toolCalls.map((tc) => {
        const pending = this.pendingApprovals.get(tc.id);
        if (!pending) return tc;
        return {
          ...tc,
          status: "awaiting_approval" as const,
          approvalOptions: pending.options,
        };
      }),
    };
  }

  /**
   * Register a custom adapter (or override a built-in one).
   *
   * Replacing an already-registered adapter is safe: we unsubscribe the
   * old instance's event handler, shut down its subprocess (best-effort,
   * in the background so callers don't block on a slow teardown), and
   * drop any sessionIndex entries that pointed at it. The new adapter
   * starts with a clean slate.
   *
   * Returns synchronously; if the old adapter's shutdown fails, the
   * error is swallowed — there's no caller waiting for it.
   */
  registerAdapter(provider: string, adapter: ACPAdapter): void {
    const previous = this.adapters.get(provider);
    if (previous && previous !== adapter) {
      // Unsubscribe the old instance's event handler so it can be GC'd.
      const unsub = this.unsubscribers.get(provider);
      if (unsub) {
        try {
          unsub();
        } catch {
          // best-effort
        }
        this.unsubscribers.delete(provider);
      }
      this.subscribedProviders.delete(provider);
      // Drop sessionIndex entries that belonged to the replaced adapter
      // — otherwise cached routing would still send operations to the
      // dead handle.
      for (const [sessionId, providerName] of this.sessionIndex) {
        if (providerName === provider) this.sessionIndex.delete(sessionId);
      }
      // Shut down the old subprocess in the background so we don't leak it.
      void previous.shutdown().catch(() => {});
    } else {
      // Brand-new provider name — still clear any stale subscription state
      // (defensive: registerAdapter called before any adapter was wired up).
      this.subscribedProviders.delete(provider);
    }
    this.adapters.set(provider, adapter);
  }

  /**
   * Returns the list of provider names currently registered. Useful for
   * introspection / admin surfaces. Does not start any subprocesses.
   */
  registeredProviders(): string[] {
    return [...this.adapters.keys()];
  }

  /**
   * Returns which providers have their binary available on this machine.
   */
  async availableProviders(): Promise<string[]> {
    const results: string[] = [];
    for (const [name, adapter] of this.adapters) {
      if (await adapter.isAvailable()) {
        results.push(name);
      }
    }
    return results;
  }

  /**
   * List all known sessions across all providers.
   * Only adapters whose binary is available are queried; others return an
   * empty list. Also populates the `sessionIndex` so subsequent operations
   * can route without re-querying every adapter, and subscribes to each
   * adapter we successfully queried so live events flow into the domain
   * events bus — a dashboard that opens the session list should start
   * receiving updates immediately.
   */
  async listSessions(): Promise<Array<DiscoveredSession & { provider: string }>> {
    const all: Array<DiscoveredSession & { provider: string }> = [];
    for (const [provider, adapter] of this.adapters) {
      // Skip adapters whose binary is missing — otherwise discoverSessions
      // would spawn a subprocess that immediately fails, just to return 0
      // sessions. That's wasteful and noisy.
      try {
        if (!(await adapter.isAvailable())) continue;
      } catch {
        continue;
      }

      try {
        const sessions = await adapter.discoverSessions();
        for (const s of sessions) {
          all.push({ ...s, provider });
          this.sessionIndex.set(s.sourceId, provider);
        }
        // Idempotent — only wires up the handler once per provider.
        this.subscribeToAdapter(provider, adapter);
      } catch {
        // Provider unreachable (subprocess crashed, etc.) — skip silently.
      }
    }
    return all;
  }

  /**
   * Create a new session with the given provider.
   * Starts the adapter if it hasn't been started yet.
   *
   * Order matters: we subscribe to the adapter's event stream BEFORE
   * calling `createSession`. The adapter may emit session events during
   * the startup handshake (status transitions, initialization echoes,
   * etc.); subscribing afterwards would drop those early events because
   * the adapter's internal handler set was empty at emission time.
   * `subscribeToAdapter` is idempotent per-provider, so calling it
   * here is a safe no-op when a previous call already wired things up.
   */
  async createSession(
    provider: string,
    params: { cwd: string; mcpServers?: unknown[] },
  ): Promise<{ sessionId: string }> {
    const adapter = this.requireAdapter(provider);
    if (!adapter.createSession) {
      throw new ProviderCapabilityError(provider, "createSession");
    }
    this.subscribeToAdapter(provider, adapter);
    const result = await adapter.createSession(params);
    // Index so subsequent operations route directly without iterating
    // every adapter's discoverSessions() (which would spawn subprocesses).
    this.sessionIndex.set(result.sessionId, provider);

    // Mirror the session row into the catalog so list/get can come from
    // Drizzle without bouncing through the adapter subprocess, and so the
    // s3-snapshot replicator captures session metadata.
    if (this.catalog) {
      await upsertSession(this.catalog, {
        sessionId: result.sessionId,
        provider,
        status: "idle",
        workingDirectory: params.cwd,
      }).catch((err) => {
        // Non-fatal: in-memory routing still works; surface on next write.
        process.stderr.write(
          `[spawntree-daemon] session persist failed on create: ${String(err)}\n`,
        );
      });
    }
    return result;
  }

  /**
   * Get session detail (turns + tool calls) from the owning adapter.
   * Searches all adapters if no explicit provider is given.
   */
  async getSessionDetail(sessionId: string): Promise<ACPSessionDetail> {
    const [, adapter] = await this.findSession(sessionId);
    const detail = await adapter.getSessionDetail(sessionId);
    return this.patchPendingApprovals(detail);
  }

  /**
   * Get the summary info for a session.
   */
  async getSessionInfo(sessionId: string): Promise<DiscoveredSession & { provider: string }> {
    const [provider, adapter] = await this.findSession(sessionId);
    const sessions = await adapter.discoverSessions();
    const found = sessions.find((s) => s.sourceId === sessionId);
    if (!found) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return { ...found, provider };
  }

  /** Send a message to a session. */
  async sendMessage(sessionId: string, content: string): Promise<void> {
    const [provider, adapter] = await this.findSession(sessionId);
    // Ensure we're subscribed to events from this adapter.
    this.subscribeToAdapter(provider, adapter);
    await adapter.sendMessage(sessionId, content);
  }

  /** Cancel the active turn in a session. */
  async interrupt(sessionId: string): Promise<void> {
    const [, adapter] = await this.findSession(sessionId);
    await adapter.interruptSession(sessionId);
  }

  /** Resume a dormant session. */
  async resume(sessionId: string): Promise<void> {
    const [, adapter] = await this.findSession(sessionId);
    await adapter.resumeSession(sessionId);
  }

  /**
   * Delete a session by dispatching to the owning adapter. Adapters that
   * do not support deletion (e.g. Codex, whose app-server has no delete
   * RPC) throw `SessionDeleteUnsupportedError` which the HTTP layer maps
   * to 501 Not Implemented.
   *
   * After a successful delete we drop the session from the index so
   * subsequent lookups don't route to a stale provider.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const [provider, adapter] = await this.findSession(sessionId);
    if (!adapter.deleteSession) {
      throw new SessionDeleteUnsupportedError(sessionId, provider);
    }
    await adapter.deleteSession(sessionId);
    this.sessionIndex.delete(sessionId);
    if (this.catalog) {
      await deletePersistedSession(this.catalog, sessionId).catch(() => undefined);
    }
  }

  /**
   * List sessions from the catalog DB. Fast path that doesn't spawn any
   * adapter subprocesses. External Drizzle clients querying the same
   * tables see identical data.
   *
   * Returns an empty array when no StorageManager is wired up (tests,
   * legacy paths). Callers that need live discovery hit `listSessions()`.
   */
  async listPersistedSessions(): Promise<Array<SessionInfo>> {
    if (!this.catalog) return [];
    return listPersistedSessions(this.catalog);
  }

  /** Same shape as `listPersistedSessions` but for a single session. */
  async getPersistedSession(sessionId: string): Promise<SessionInfo | undefined> {
    if (!this.catalog) return undefined;
    return getPersistedSession(this.catalog, sessionId);
  }

  /**
   * Subscribe to per-session events from a specific session.
   * Returns an async generator that yields events until the signal fires.
   *
   * The sessionId filter is applied at the DomainEvents layer (including
   * during history replay) so a fresh subscriber doesn't receive a flood
   * of events from other sessions before it gets its own live stream.
   */
  async *sessionEvents(sessionId: string, signal?: AbortSignal): AsyncIterable<SessionEvent> {
    const queue: SessionEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;

    const push = (event: SessionEvent) => {
      queue.push(event);
      wake?.();
    };

    // Push-down the sessionId filter so history replay is also scoped.
    const cleanup = this.events.subscribeSessionEvent(push, sessionId);
    signal?.addEventListener("abort", () => {
      done = true;
      wake?.();
    });

    try {
      while (!done) {
        while (queue.length > 0) {
          const event = queue.shift()!;
          yield event;
        }
        if (done) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } finally {
      cleanup();
    }
  }

  /** Shut down all adapters. Called when the daemon process exits. */
  async shutdown(): Promise<void> {
    for (const unsub of this.unsubscribers.values()) {
      try {
        unsub();
      } catch {
        // best-effort
      }
    }
    this.unsubscribers.clear();
    this.subscribedProviders.clear();
    for (const adapter of this.adapters.values()) {
      await adapter.shutdown().catch(() => {});
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private requireAdapter(provider: string): ACPAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new UnknownProviderError(provider, [...this.adapters.keys()]);
    }
    return adapter;
  }

  /**
   * Find which adapter owns a given sessionId.
   *
   * Fast path: consult the `sessionIndex` cache populated by
   * `createSession` and `listSessions`. This avoids iterating every
   * adapter on each call — crucially, it avoids triggering
   * `discoverSessions` on adapters whose implementations spawn a
   * subprocess (e.g. CodexACPAdapter), so a Claude Code session
   * operation does not boot a Codex subprocess it never needed.
   *
   * Slow path: if the cache misses, fall back to iterating available
   * adapters and populate the cache with everything we discover on the
   * way. Unavailable adapters (binary not installed) are skipped so we
   * don't spawn them speculatively.
   */
  private async findSession(sessionId: string): Promise<[string, ACPAdapter]> {
    const cached = this.sessionIndex.get(sessionId);
    if (cached) {
      const adapter = this.adapters.get(cached);
      if (adapter) {
        return [cached, adapter];
      }
      // Provider was removed — stale cache entry, fall through to rediscover.
      this.sessionIndex.delete(sessionId);
    }

    for (const [provider, adapter] of this.adapters) {
      try {
        if (!(await adapter.isAvailable())) continue;
      } catch {
        continue;
      }
      try {
        const sessions = await adapter.discoverSessions();
        let hit: [string, ACPAdapter] | null = null;
        for (const s of sessions) {
          this.sessionIndex.set(s.sourceId, provider);
          if (s.sourceId === sessionId) {
            hit = [provider, adapter];
          }
        }
        if (hit) return hit;
      } catch {
        // Adapter unreachable — skip.
      }
    }
    throw new Error(`Session not found: ${sessionId}`);
  }

  /**
   * Subscribe to a provider's event stream exactly once and forward events
   * to the DomainEvents bus. Idempotent — subsequent calls for the same
   * provider are no-ops. Storing the unsubscribe function keyed by
   * provider name lets `registerAdapter` tear it down cleanly when the
   * adapter is replaced.
   */
  /**
   * Chain a persistence write after any previous write for the same
   * session so adapter events land in order (turn_started → turn_completed
   * must run its UPDATE after the INSERT has landed, not concurrent with it).
   *
   * Returns a promise the caller can await (tests use `flushPersist()`
   * which awaits all active queues). If the catalog isn't wired up, this
   * is a no-op — callers get back a resolved promise.
   */
  private enqueuePersist(sessionId: string, op: () => Promise<void>): Promise<void> {
    if (!this.catalog) return Promise.resolve();
    const prev = this.persistQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(op);
    // Swallow rejections in the stored reference so one failure doesn't
    // permanently break the chain. `op` itself already logs errors.
    this.persistQueues.set(
      sessionId,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Wait for all queued persistence writes to drain. Tests call this
   * after emitting events to make their assertions deterministic. The
   * shutdown path also awaits it to avoid truncating in-flight writes.
   */
  async flushPersist(): Promise<void> {
    const queues = [...this.persistQueues.values()];
    await Promise.all(queues.map((q) => q.catch(() => undefined)));
  }

  private subscribeToAdapter(provider: string, adapter: ACPAdapter): void {
    if (this.subscribedProviders.has(provider)) return;
    this.subscribedProviders.add(provider);

    const unsub = adapter.onSessionEvent((event) => {
      // Publish to domain events bus — SSE subscribers will receive it.
      this.events.publishSessionEvent(event, provider);

      // Mirror into the catalog so sessions survive restart + are visible
      // to external Drizzle clients. Chain per-session so events land in
      // emission order; errors are logged but don't break the chain so
      // one bad write can't wedge the queue.
      void this.enqueuePersist(event.sessionId, () =>
        persistSessionEvent(this.catalog!, event).catch((err) => {
          process.stderr.write(
            `[spawntree-daemon] session persist failed on ${event.type}: ${String(err)}\n`,
          );
        }),
      );

      // On turn_completed, backfill the turn's final content (+ stop reason,
      // duration, modelId) by asking the adapter once. We deliberately skip
      // persisting `message_delta` frames to avoid write amplification;
      // hydration on completion is the catch-up mechanism so external
      // Drizzle readers see fully-assembled turn content without having
      // to call the adapter subprocess themselves.
      if (event.type === "turn_completed") {
        void this.enqueuePersist(event.sessionId, async () => {
          await this.hydrateTurnAfterCompletion(adapter, event.sessionId, event.turnId);
        });
      }
    });
    this.unsubscribers.set(provider, unsub);
  }

  /**
   * Fetch session detail from the adapter and backfill the matching turn
   * row's content + metadata. Best-effort: any failure (adapter subprocess
   * crashed, session vanished, network blip) is logged and swallowed so
   * one bad hydration doesn't wedge the persistence queue.
   *
   * Small by design: exactly one `getSessionDetail` call per completed
   * turn. If the adapter responds cheaply from its own cache, this is a
   * constant-time backfill.
   */
  private async hydrateTurnAfterCompletion(
    adapter: ACPAdapter,
    sessionId: string,
    turnId: string,
  ): Promise<void> {
    if (!this.catalog) return;
    try {
      const detail = await adapter.getSessionDetail(sessionId);
      const turn = detail.turns.find((t) => t.id === turnId);
      if (turn) {
        await hydrateTurnContent(this.catalog, turn);
      }
    } catch (err) {
      process.stderr.write(
        `[spawntree-daemon] turn hydration failed for ${sessionId}/${turnId}: ${String(err)}\n`,
      );
    }
  }
}

/**
 * Build a `SessionToolCallData` row from an ACP `request_permission` request.
 * The adapter has already emitted a `tool_call_started` event for the same
 * id — this transitional row carries the same identity but with status
 * `awaiting_approval` and the agent's offered options attached.
 */
// Return type intentionally inferred: TypeScript infers a literal shape with
// a mutable `approvalOptions` array, which is assignable to both the
// adapter-side `SessionToolCallData` (mutable) and the Effect-derived schema
// type (readonly). Annotating the return as `SessionToolCallData` would
// pin to one or the other and break the SessionEvent assignment downstream.
function approvalToolCallFromRequest(
  params: ACPRequestPermissionRequest,
  options: ToolCallApprovalOption[],
) {
  const tc = params.toolCall;
  return {
    id: tc.toolCallId,
    turnId: null,
    toolName: tc.title ?? "tool",
    toolKind: mapAcpToolKind(tc.kind),
    status: "awaiting_approval" as const,
    arguments: tc.rawInput ?? null,
    result: null,
    durationMs: null,
    createdAt: new Date().toISOString(),
    approvalOptions: options,
  };
}

function mapAcpToolKind(kind: string | undefined | null): SessionToolCallData["toolKind"] {
  switch (kind) {
    case "execute":
      return "terminal";
    case "edit":
    case "move":
    case "delete":
      return "file_edit";
    default:
      return "other";
  }
}
