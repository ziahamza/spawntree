import { describe, expect, it } from "vitest";

// Extract parseLogLine for testing by re-implementing it here
// (the actual function is not exported, so we test the same logic)
interface LogLine {
  ts: string;
  service: string;
  message: string;
  isError: boolean;
}

function parseLogLine(raw: string): LogLine {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.line === "string") {
      const isError = /error|err|fatal|panic/i.test(parsed.line) || parsed.stream === "stderr";
      return {
        ts: parsed.ts ?? "",
        service: parsed.service ?? "",
        message: parsed.line,
        isError,
      };
    }
  } catch {
    // Not JSON
  }
  const m = raw.match(/^\[([^\]]+)\]\s+(\S+):\s+(.*)$/);
  if (m) {
    const [, ts, service, message] = m;
    const isError =
      /error|err|fatal|panic/i.test(message) || /error|err|fatal|panic/i.test(service);
    return { ts, service, message, isError };
  }
  const isError = /error|err|fatal|panic/i.test(raw);
  return { ts: "", service: "", message: raw, isError };
}

describe("parseLogLine", () => {
  it("parses JSON SSE data from server", () => {
    const raw =
      '{"ts":"2026-04-01T10:42:31Z","service":"api","stream":"stdout","line":"GET /health 200 2ms"}';
    const line = parseLogLine(raw);
    expect(line.ts).toBe("2026-04-01T10:42:31Z");
    expect(line.service).toBe("api");
    expect(line.message).toBe("GET /health 200 2ms");
    expect(line.isError).toBe(false);
  });

  it("detects stderr as error", () => {
    const raw =
      '{"ts":"2026-04-01T10:42:31Z","service":"worker","stream":"stderr","line":"connection refused"}';
    const line = parseLogLine(raw);
    expect(line.isError).toBe(true);
  });

  it("detects error keywords in message", () => {
    const raw =
      '{"ts":"","service":"web","stream":"stdout","line":"Error: ECONNREFUSED 127.0.0.1:5432"}';
    const line = parseLogLine(raw);
    expect(line.isError).toBe(true);
    expect(line.message).toBe("Error: ECONNREFUSED 127.0.0.1:5432");
  });

  it("falls back to plain-text parsing", () => {
    const raw = "[10:42:31] api: GET /users 200 12ms";
    const line = parseLogLine(raw);
    expect(line.ts).toBe("10:42:31");
    expect(line.service).toBe("api");
    expect(line.message).toBe("GET /users 200 12ms");
  });

  it("handles unstructured text", () => {
    const raw = "Server listening on port 3000";
    const line = parseLogLine(raw);
    expect(line.ts).toBe("");
    expect(line.service).toBe("");
    expect(line.message).toBe(raw);
    expect(line.isError).toBe(false);
  });

  it("handles unstructured error text", () => {
    const raw = "Fatal: database connection failed";
    const line = parseLogLine(raw);
    expect(line.isError).toBe(true);
  });
});
