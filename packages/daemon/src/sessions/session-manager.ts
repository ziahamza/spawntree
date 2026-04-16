import type {
  ACPAdapter,
  ACPSessionDetail,
  DiscoveredSession,
  SessionEvent,
} from "spawntree-core";
import { ClaudeCodeAdapter, CodexACPAdapter } from "spawntree-core";
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
  private readonly unsubscribers: Array<() => void> = [];

  constructor(events: DomainEvents) {
    this.events = events;

    // Register built-in adapters. Additional adapters can be added via
    // `registerAdapter()` before the manager is used.
    this.adapters.set("claude-code", new ClaudeCodeAdapter());
    this.adapters.set("codex", new CodexACPAdapter());
  }

  /**
   * Register a custom adapter (or override a built-in one).
   * Must be called before the adapter is first used.
   */
  registerAdapter(provider: string, adapter: ACPAdapter): void {
    this.adapters.set(provider, adapter);
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
   * Each adapter is queried; unavailable adapters return an empty list.
   */
  async listSessions(): Promise<Array<DiscoveredSession & { provider: string }>> {
    const all: Array<DiscoveredSession & { provider: string }> = [];
    for (const [provider, adapter] of this.adapters) {
      try {
        const sessions = await adapter.discoverSessions();
        for (const s of sessions) {
          all.push({ ...s, provider });
        }
      } catch {
        // Provider not running or unavailable — skip silently.
      }
    }
    return all;
  }

  /**
   * Create a new session with the given provider.
   * Starts the adapter if it hasn't been started yet.
   */
  async createSession(provider: string, params: { cwd: string; mcpServers?: unknown[] }): Promise<{ sessionId: string }> {
    const adapter = this.requireAdapter(provider);
    if (!adapter.createSession) {
      throw new Error(`Provider "${provider}" does not support explicit session creation`);
    }
    const result = await adapter.createSession(params);
    this.subscribeToAdapter(provider, adapter);
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
   * Shut down a session by removing it from the adapter's memory.
   * For adapters that persist sessions (Codex), this is a no-op on the
   * agent side — the session remains in Codex's thread list.
   */
  async deleteSession(sessionId: string): Promise<void> {
    // For Claude Code: sessions are in-memory; shutting down the whole adapter
    // would kill all sessions. Instead we just let the session die naturally.
    // For Codex: sessions persist in the codex app-server; we can't delete them.
    // Nothing to do on the daemon side — the session stays discoverable.
    // In a future iteration, track session→adapter mapping for finer control.
    void sessionId;
  }

  /**
   * Subscribe to per-session events from a specific session.
   * Returns an async generator that yields events until the signal fires.
   */
  async *sessionEvents(sessionId: string, signal?: AbortSignal): AsyncIterable<SessionEvent> {
    const queue: SessionEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;

    const push = (event: SessionEvent) => {
      if (event.sessionId !== sessionId) return;
      queue.push(event);
      wake?.();
    };

    // Subscribe at the domain-events level by filtering the raw adapter events.
    // We register a temporary handler on the domain events bus.
    const cleanup = this.events.subscribeSessionEvent(push);
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
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers.length = 0;
    for (const adapter of this.adapters.values()) {
      await adapter.shutdown().catch(() => {});
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private requireAdapter(provider: string): ACPAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`Unknown provider: "${provider}". Available: ${[...this.adapters.keys()].join(", ")}`);
    }
    return adapter;
  }

  /**
   * Find which adapter owns a given sessionId by querying all adapters.
   * Returns [providerName, adapter].
   */
  private async findSession(sessionId: string): Promise<[string, ACPAdapter]> {
    for (const [provider, adapter] of this.adapters) {
      try {
        const sessions = await adapter.discoverSessions();
        if (sessions.some((s) => s.sourceId === sessionId)) {
          return [provider, adapter];
        }
      } catch {
        // Adapter not running — skip.
      }
    }
    throw new Error(`Session not found: ${sessionId}`);
  }

  /**
   * Subscribe to a provider's event stream exactly once and forward events
   * to the DomainEvents bus. Idempotent — subsequent calls for the same
   * provider are no-ops.
   */
  private subscribeToAdapter(provider: string, adapter: ACPAdapter): void {
    // Use a simple presence check: if the adapter is in the map and we've
    // already added a handler, its unsubscriber will be in `this.unsubscribers`.
    // We tag it by prefixing. Simpler approach: track per-provider subscription.
    if ((adapter as AdapterWithSubscribed)._spawntreeSubscribed) return;
    (adapter as AdapterWithSubscribed)._spawntreeSubscribed = true;

    const unsub = adapter.onSessionEvent((event) => {
      // Publish to domain events bus — SSE subscribers will receive it.
      this.events.publishSessionEvent(event, provider);
    });
    this.unsubscribers.push(unsub);
  }
}

// Internal marker to track per-adapter subscription state without a separate Map.
interface AdapterWithSubscribed extends ACPAdapter {
  _spawntreeSubscribed?: boolean;
}
