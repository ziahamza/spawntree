import { describe, expect, it } from "vitest";
import { DomainEvents } from "../src/events/domain-events.ts";

describe("DomainEvents", () => {
  it("removes subscribers when an idle subscription is aborted", async () => {
    const events = new DomainEvents();
    const abortController = new AbortController();
    const iterator = events.subscribe(0, abortController.signal)[Symbol.asyncIterator]();

    const nextEvent = iterator.next();
    expect((events as { subscribers: Set<unknown> }).subscribers.size).toBe(1);

    abortController.abort();

    await expect(nextEvent).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect((events as { subscribers: Set<unknown> }).subscribers.size).toBe(0);
  });
});
