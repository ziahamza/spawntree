import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { WebSocket } from "ws";

/**
 * Integration test for the WebSocket endpoint at `/api/v1/sessions/ws`.
 *
 * Boots the compiled daemon as a subprocess (same pattern as
 * dashboard-smoke), opens a real WebSocket connection, exercises
 * subscribe / send_message / error paths with the wire format
 * documented in sessions-ws.ts.
 *
 * This doesn't hit a live ACP agent — we use invalid session ids and
 * assert the error shapes come back the way the contract says they
 * should. When follow-up PRs add t3code protocol translation on top,
 * that layer gets its own tests.
 */

const daemonRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const daemonEntry = resolve(daemonRoot, "dist/server-main.js");

async function pickPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

async function waitForReady(origin: string, maxMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/health`);
      if (res.ok && (await res.text()).trim() === "ok") return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Send a message through the socket, await the next incoming frame,
 * and return it parsed. Throws if the next frame doesn't arrive
 * within 2s — that's a long time for a local loopback, so if we
 * time out it's a bug not a flake.
 */
async function sendAndAwait(ws: WebSocket, outbound: unknown): Promise<unknown> {
  const received: Promise<string> = new Promise((resolve, reject) => {
    const onMessage = (raw: Buffer | ArrayBuffer | string) => {
      ws.removeEventListener("message", onMessage as never);
      resolve(typeof raw === "string" ? raw : raw.toString());
    };
    ws.on("message", onMessage);
    setTimeout(() => {
      ws.removeEventListener("message", onMessage as never);
      reject(new Error("timed out waiting for ws message (2s)"));
    }, 2000);
  });
  ws.send(JSON.stringify(outbound));
  return JSON.parse(await received);
}

describe("sessions WebSocket (requires prior `pnpm build`)", () => {
  if (!existsSync(daemonEntry)) {
    it.skip(`daemon not built (${daemonEntry}) — run \`pnpm build\` first`, () => {});
    return;
  }

  let proc: ChildProcess;
  let wsOrigin: string;
  let stderrLines: string[] = [];

  beforeAll(async () => {
    const port = await pickPort();
    wsOrigin = `ws://127.0.0.1:${port}`;

    proc = spawn("node", [daemonEntry], {
      env: { ...process.env, SPAWNTREE_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    stderrLines = [];
    proc.stderr?.on("data", (d: Buffer) => stderrLines.push(d.toString()));

    const ready = await waitForReady(`http://127.0.0.1:${port}`);
    if (!ready) {
      proc.kill("SIGTERM");
      const tail = stderrLines.join("").split("\n").slice(-40).join("\n");
      throw new Error(`daemon did not come up in 20s.\n--- stderr ---\n${tail}`);
    }
  }, 30_000);

  afterAll(async () => {
    proc?.kill("SIGTERM");
    await once(proc, "exit").catch(() => {});
  });

  it("opens a connection to /api/v1/sessions/ws", async () => {
    const ws = new WebSocket(`${wsOrigin}/api/v1/sessions/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    expect(ws.readyState).toBe(ws.OPEN);
    ws.close();
  });

  it("replies with ack on subscribe", async () => {
    const ws = new WebSocket(`${wsOrigin}/api/v1/sessions/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const ack = (await sendAndAwait(ws, {
      type: "subscribe",
      sessionId: "any-valid-id",
    })) as { type: string; op: string; sessionId: string };

    expect(ack.type).toBe("ack");
    expect(ack.op).toBe("subscribe");
    expect(ack.sessionId).toBe("any-valid-id");

    ws.close();
  });

  it("returns structured error for invalid JSON", async () => {
    const ws = new WebSocket(`${wsOrigin}/api/v1/sessions/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const err = await new Promise<unknown>((resolve, reject) => {
      ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
      setTimeout(() => reject(new Error("timeout")), 2000);
      ws.send("{not-json");
    });

    expect(err).toMatchObject({ type: "error", code: "INVALID_JSON" });
    ws.close();
  });

  it("returns structured error for unknown message type", async () => {
    const ws = new WebSocket(`${wsOrigin}/api/v1/sessions/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const err = (await sendAndAwait(ws, {
      type: "nonsense",
      sessionId: "x",
    })) as { type: string; code: string };

    expect(err.type).toBe("error");
    expect(err.code).toBe("UNKNOWN_TYPE");

    ws.close();
  });

  it("returns error when send_message targets an unknown session", async () => {
    const ws = new WebSocket(`${wsOrigin}/api/v1/sessions/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const response = (await sendAndAwait(ws, {
      type: "send_message",
      sessionId: "definitely-not-a-real-session",
      content: "hi",
    })) as { type: string; code: string; sessionId: string };

    expect(response.type).toBe("error");
    // Any error code is fine — what we care about is that the server
    // rejects cleanly rather than crashing the socket.
    expect(typeof response.code).toBe("string");
    expect(response.sessionId).toBe("definitely-not-a-real-session");

    ws.close();
  });

  it("acks unsubscribe even without a prior subscribe (idempotent)", async () => {
    const ws = new WebSocket(`${wsOrigin}/api/v1/sessions/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const ack = (await sendAndAwait(ws, {
      type: "unsubscribe",
      sessionId: "whatever",
    })) as { type: string; op: string };

    expect(ack.type).toBe("ack");
    expect(ack.op).toBe("unsubscribe");

    ws.close();
  });

  // NOTE: we intentionally don't test "upgrade is rejected on unrelated
  // paths". Our handler silently ignores non-matching paths so other
  // upgrade handlers (e.g. the future t3code adapter on a separate
  // path) can coexist on the same Node HTTP server. The outcome for an
  // unmatched path is "socket stays open until something else handles
  // it or the client times out" — that's framework behavior we don't
  // own. If a reviewer tries a bogus path, they'll see a timeout, which
  // is the correct signal.
});
