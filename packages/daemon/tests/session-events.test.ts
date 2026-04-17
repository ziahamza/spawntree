import { describe, expect, it } from "vitest";
import type { SessionEvent } from "spawntree-core";
import { DomainEvents } from "../src/events/domain-events.ts";

function turnStarted(sessionId: string, turnId: string): SessionEvent {
  return { type: "turn_started", sessionId, turnId };
}

describe("DomainEvents session events", () => {
  it("mirrors session events into the main DomainEvent stream", async () => {
    const events = new DomainEvents();
    const controller = new AbortController();
    const iter = events.subscribe(0, controller.signal)[Symbol.asyncIterator]();

    events.publishSessionEvent(turnStarted("s1", "t1"), "claude-code");

    const first = await iter.next();
    expect(first.value).toMatchObject({
      type: "session_event",
    });

    controller.abort();
  });

  it("replays buffered history only for the requested session", () => {
    const events = new DomainEvents();

    events.publishSessionEvent(turnStarted("s1", "t1"), "claude-code");
    events.publishSessionEvent(turnStarted("s2", "t2"), "claude-code");
    events.publishSessionEvent(turnStarted("s1", "t3"), "claude-code");

    const received: SessionEvent[] = [];
    const unsubscribe = events.subscribeSessionEvent((e) => received.push(e), "s1");

    expect(received.map((e) => e.sessionId)).toEqual(["s1", "s1"]);
    unsubscribe();
  });

  it("delivers only matching live events when a sessionId filter is provided", () => {
    const events = new DomainEvents();
    const received: SessionEvent[] = [];
    const unsubscribe = events.subscribeSessionEvent((e) => received.push(e), "s1");

    events.publishSessionEvent(turnStarted("s2", "t1"), "claude-code"); // filtered out
    events.publishSessionEvent(turnStarted("s1", "t2"), "claude-code"); // delivered
    events.publishSessionEvent(turnStarted("s3", "t3"), "claude-code"); // filtered out

    expect(received.map((e) => e.turnId)).toEqual(["t2"]);
    unsubscribe();
  });

  it("delivers all events to unfiltered subscribers", () => {
    const events = new DomainEvents();
    const received: SessionEvent[] = [];
    const unsubscribe = events.subscribeSessionEvent((e) => received.push(e));

    events.publishSessionEvent(turnStarted("s1", "t1"), "claude-code");
    events.publishSessionEvent(turnStarted("s2", "t2"), "claude-code");

    expect(received).toHaveLength(2);
    unsubscribe();
  });

  it("removes the subscriber on unsubscribe", () => {
    const events = new DomainEvents();
    const received: SessionEvent[] = [];
    const unsubscribe = events.subscribeSessionEvent((e) => received.push(e));

    events.publishSessionEvent(turnStarted("s1", "t1"), "claude-code");
    expect(received).toHaveLength(1);

    unsubscribe();
    events.publishSessionEvent(turnStarted("s1", "t2"), "claude-code");
    expect(received).toHaveLength(1); // no new event
  });
});
