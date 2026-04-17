import type { ACPAdapter, ACPSessionDetail, DiscoveredSession, SessionEvent } from "spawntree-core";
import {
  ClaudeCodeAdapter,
  CodexACPAdapter,
  ProviderCapabilityError,
  SessionDeleteUnsupportedError,
  UnknownProviderError,
} from "spawntree-core";
import type { DomainEvents } from "../events/domain-events.ts";

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

  constructor(events: DomainEvents) {
    this.events = events;

    // Register built-in adapters. Additional adapters can be added via
    // `registerAdapter()` before the manager is used.
    this.adapters.set("claude-code", new ClaudeCodeAdapter());
    this.adapters.set("codex", new CodexACPAdapter());
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
    return result;
  }

  /**
   * Get session detail (turns + tool calls) from the owning adapter.
   * Searches all adapters if no explicit provider is given.
   */
  async getSessionDetail(sessionId: string): Promise<ACPSessionDetail> {
    const [, adapter] = await this.findSession(sessionId);
    return adapter.getSessionDetail(sessionId);
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
  private subscribeToAdapter(provider: string, adapter: ACPAdapter): void {
    if (this.subscribedProviders.has(provider)) return;
    this.subscribedProviders.add(provider);

    const unsub = adapter.onSessionEvent((event) => {
      // Publish to domain events bus — SSE subscribers will receive it.
      this.events.publishSessionEvent(event, provider);
    });
    this.unsubscribers.set(provider, unsub);
  }
}
