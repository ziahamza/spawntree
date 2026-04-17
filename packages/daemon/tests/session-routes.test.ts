import { describe, expect, it } from "vitest";
import type { ACPAdapter, DiscoveredSession, SessionDetail } from "spawntree-core";
import { DomainEvents } from "../src/events/domain-events.ts";
import { createSessionRoutes } from "../src/routes/sessions.ts";
import { SessionManager } from "../src/sessions/session-manager.ts";

/**
 * Regression coverage for Devin review (pass 2) findings:
 *   #1, #2 — `decodeBody` was called outside the try/catch in POST / and
 *            POST /:id/messages, so a malformed body fell through to
 *            Hono's default 500 handler instead of mapping to 400 via
 *            `sessionErrorResponse`. These tests hit the routes with
 *            invalid JSON and assert the status code is 400.
 */

function makeAdapter(): ACPAdapter {
  return {
    name: "fake",
    async isAvailable() {
      return true;
    },
    async discoverSessions(): Promise<DiscoveredSession[]> {
      return [];
    },
    async createSession() {
      return { sessionId: "new-session" };
    },
    async getSessionDetail(): Promise<SessionDetail> {
      return { turns: [], toolCalls: [] };
    },
    async sendMessage() {
      // no-op
    },
    async interruptSession() {
      // no-op
    },
    async resumeSession() {
      // no-op
    },
    onSessionEvent() {
      return () => {};
    },
    async shutdown() {
      // no-op
    },
  };
}

function makeApp() {
  const events = new DomainEvents();
  const manager = new SessionManager(events);
  manager.registerAdapter("fake", makeAdapter());
  return createSessionRoutes(manager);
}

describe("POST /api/v1/sessions — body validation", () => {
  it("returns 400 for invalid JSON body", async () => {
    const app = makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("INVALID_JSON");
  });

  it("returns 400 for schema-invalid body (missing provider)", async () => {
    const app = makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp" }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("INVALID_BODY");
  });

  it("returns 201 for valid body", async () => {
    const app = makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "fake", cwd: "/tmp" }),
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /api/v1/sessions/:id/messages — body validation", () => {
  it("returns 400 for invalid JSON body", async () => {
    const app = makeApp();
    const res = await app.request("/any-id/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("INVALID_JSON");
  });

  it("returns 400 for schema-invalid body (missing content)", async () => {
    const app = makeApp();
    const res = await app.request("/any-id/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notContent: "hi" }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("INVALID_BODY");
  });
});
