import type { DomainEvent, SessionEvent } from "spawntree-core";

const HISTORY_LIMIT = 256;
// Per-session event queues are not history-limited — they're ephemeral.
const SESSION_EVENT_HISTORY = 64;

export class DomainEvents {
  private seq = 0;
  private history: Array<DomainEvent> = [];
  private readonly subscribers = new Set<(event: DomainEvent) => void>();

  // Session events — separate channel so consumers can subscribe without
  // parsing the opaque DomainEvent.detail string.
  private readonly sessionEventHistory: Array<{ event: SessionEvent; provider: string }> = [];
  private readonly sessionEventSubscribers = new Set<(event: SessionEvent) => void>();

  publish(event: Omit<DomainEvent, "seq" | "timestamp">) {
    const nextEvent: DomainEvent = {
      ...event,
      seq: ++this.seq,
      timestamp: new Date().toISOString(),
    };

    this.history.push(nextEvent);
    if (this.history.length > HISTORY_LIMIT) {
      this.history.shift();
    }

    for (const subscriber of this.subscribers) {
      subscriber(nextEvent);
    }

    return nextEvent;
  }

  async *subscribe(since = 0, signal?: AbortSignal): AsyncIterable<DomainEvent> {
    for (const event of this.history) {
      if (event.seq > since) {
        yield event;
      }
    }

    const queue: Array<DomainEvent> = [];
    let wakeSubscriber: (() => void) | undefined;

    const subscriber = (event: DomainEvent) => {
      queue.push(event);
      wakeSubscriber?.();
    };

    this.subscribers.add(subscriber);

    try {
      while (true) {
        while (queue.length > 0) {
          const event = queue.shift();
          if (event) {
            yield event;
          }
        }

        if (signal?.aborted) {
          break;
        }

        await new Promise<void>((resolve) => {
          const complete = () => {
            signal?.removeEventListener("abort", complete);
            wakeSubscriber = undefined;
            resolve();
          };

          wakeSubscriber = complete;
          signal?.addEventListener("abort", complete, { once: true });
        });
      }
    } finally {
      wakeSubscriber = undefined;
      this.subscribers.delete(subscriber);
    }
  }

  /**
   * Publish a normalized SessionEvent from an ACP adapter.
   * Also forwards it to the main DomainEvents stream so clients watching
   * `/api/v1/events` see session activity alongside infra events.
   */
  publishSessionEvent(event: SessionEvent, provider: string): void {
    this.sessionEventHistory.push({ event, provider });
    if (this.sessionEventHistory.length > SESSION_EVENT_HISTORY) {
      this.sessionEventHistory.shift();
    }
    for (const sub of this.sessionEventSubscribers) {
      sub(event);
    }
    // Mirror to the main domain-events bus so existing `/api/v1/events`
    // consumers see session events without subscribing separately.
    this.publish({
      type: "session_event",
      detail: JSON.stringify(event),
    });
  }

  /**
   * Subscribe to raw SessionEvents.
   *
   * When `sessionId` is provided, only events for that session are
   * delivered — both in the history replay and in live events. This
   * matters for the per-session SSE endpoint: a new subscriber shouldn't
   * be flooded with up to 64 events from every other session before it
   * starts seeing its own live updates.
   *
   * When `sessionId` is omitted, all events are delivered (used by the
   * mirrored `/api/v1/events` stream).
   *
   * Returns an unsubscribe function.
   */
  subscribeSessionEvent(handler: (event: SessionEvent) => void, sessionId?: string): () => void {
    const matches = sessionId ? (event: SessionEvent) => event.sessionId === sessionId : () => true;

    // Replay recent history so new subscribers don't miss buffered events.
    for (const { event } of this.sessionEventHistory) {
      if (matches(event)) handler(event);
    }

    const filtered = (event: SessionEvent) => {
      if (matches(event)) handler(event);
    };
    this.sessionEventSubscribers.add(filtered);
    return () => {
      this.sessionEventSubscribers.delete(filtered);
    };
  }
}
