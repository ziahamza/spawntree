import type { DomainEvent } from "spawntree-core";

const HISTORY_LIMIT = 256;

export class DomainEvents {
  private seq = 0;
  private history: Array<DomainEvent> = [];
  private readonly subscribers = new Set<(event: DomainEvent) => void>();

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

  async *subscribe(since = 0): AsyncIterable<DomainEvent> {
    for (const event of this.history) {
      if (event.seq > since) {
        yield event;
      }
    }

    const queue: Array<DomainEvent> = [];
    let notify: (() => void) | undefined;

    const subscriber = (event: DomainEvent) => {
      queue.push(event);
      notify?.();
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

        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = undefined;
      }
    } finally {
      this.subscribers.delete(subscriber);
    }
  }
}
