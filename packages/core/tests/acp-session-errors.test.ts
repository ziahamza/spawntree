import { describe, expect, it } from "vitest";
import { SessionBusyError, SessionDeleteUnsupportedError } from "../src/acp/adapter.ts";

describe("SessionBusyError", () => {
  it("carries sessionId and activeTurnId on the instance", () => {
    const err = new SessionBusyError("sess-1", "turn-7");
    expect(err.sessionId).toBe("sess-1");
    expect(err.activeTurnId).toBe("turn-7");
    expect(err.code).toBe("SESSION_BUSY");
    expect(err.name).toBe("SessionBusyError");
    expect(err.message).toMatch(/sess-1/);
    expect(err.message).toMatch(/turn-7/);
    // instanceof checks must continue working across the re-export boundary
    // so the daemon route can translate to HTTP 409 reliably.
    expect(err).toBeInstanceOf(SessionBusyError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("SessionDeleteUnsupportedError", () => {
  it("carries sessionId and provider and is instanceof Error", () => {
    const err = new SessionDeleteUnsupportedError("sess-2", "codex");
    expect(err.sessionId).toBe("sess-2");
    expect(err.provider).toBe("codex");
    expect(err.code).toBe("DELETE_NOT_SUPPORTED");
    expect(err).toBeInstanceOf(SessionDeleteUnsupportedError);
    expect(err).toBeInstanceOf(Error);
  });
});
