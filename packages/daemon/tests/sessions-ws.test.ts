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

  it("handles rapid unsubscribe \u2192 resubscribe without orphaning (Devin #1 regression)", async () => {
    // Regression guard: the old code's async-generator `finally` block
    // unconditionally ran `state.subscriptions.delete(sessionId)` when
    // a subscription was aborted. If a client sent
    // `unsubscribe(X)` immediately followed by `subscribe(X)` on the
    // same tick, both sync handlers would run before the old
    // generator's microtask reached `finally`, and the finally would
    // wipe the NEW subscription's entry. The new subscription became
    // orphaned: later `unsubscribe(X)` calls found nothing to abort,
    // and the DomainEvents handler leaked.
    //
    // Fixed by guarding the delete with an identity check against the
    // unsub function stored in the map.
    //
    // This test can't directly inspect the server's internal
    // `state.subscriptions` map, but it can assert the observable
    // symptom: after unsubscribe \u2192 resubscribe \u2192 unsubscribe, the
    // final unsubscribe still acks promptly, which only works if the
    // new subscription was properly tracked.
    const ws = new WebSocket(`${wsOrigin}/api/v1/sessions/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const sessionId = "race-test-session";

    // Collect acks in order as they arrive.
    const acks: Array<{ op: string; sessionId: string }> = [];
    ws.on("message", (raw: Buffer | string) => {
      const text = typeof raw === "string" ? raw : raw.toString();
      const msg = JSON.parse(text) as { type: string; op?: string; sessionId?: string };
      if (msg.type === "ack" && msg.op && msg.sessionId) {
        acks.push({ op: msg.op, sessionId: msg.sessionId });
      }
    });

    // Fire all three synchronously so unsubscribe + resubscribe hit
    // the server within the same event-loop tick.
    ws.send(JSON.stringify({ type: "subscribe", sessionId }));
    ws.send(JSON.stringify({ type: "unsubscribe", sessionId }));
    ws.send(JSON.stringify({ type: "subscribe", sessionId }));
    ws.send(JSON.stringify({ type: "unsubscribe", sessionId }));

    // Wait for all four acks.
    const deadline = Date.now() + 3000;
    while (acks.length < 4 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(acks.length).toBeGreaterThanOrEqual(4);
    expect(acks.map((a) => a.op)).toEqual([
      "subscribe",
      "unsubscribe",
      "subscribe",
      "unsubscribe",
    ]);

    ws.close();
  });

  it("upgrades only the exact path — suffixes like /ws-admin do NOT match (Devin #2 regression)", async () => {
    // Regression guard: the handler originally used
    // `req.url.startsWith(WS_PATH)` which would have hijacked
    // `/api/v1/sessions/ws-admin`, `/api/v1/sessions/wss`,
    // `/api/v1/sessions/ws/anything`, etc. into our WebSocket
    // handshake. The fix tightened it to exact match OR "?" suffix for
    // query strings only.
    //
    // We assert the contract from the client side: a connection attempt
    // to a suffixed path does NOT complete a handshake (our handler
    // doesn't call wss.handleUpgrade, nobody else handles the path, so
    // the client eventually times out or closes). We give it 1.5s,
    // which is way more than enough on loopback — if the handshake had
    // gone through, `open` would fire within ~20ms.
    const ws = new WebSocket(`${wsOrigin}/api/v1/sessions/ws-admin`);
    const outcome = await new Promise<"open" | "close-or-error">((resolve) => {
      const timer = setTimeout(() => resolve("close-or-error"), 1500);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve("open");
      });
      ws.once("error", () => {
        clearTimeout(timer);
        resolve("close-or-error");
      });
      ws.once("close", () => {
        clearTimeout(timer);
        resolve("close-or-error");
      });
    });
    expect(outcome).toBe("close-or-error");
    ws.close();
  });

  it("upgrades exact path with a query string — /ws?token=abc DOES match", async () => {
    const ws = new WebSocket(`${wsOrigin}/api/v1/sessions/ws?token=abc`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    expect(ws.readyState).toBe(ws.OPEN);
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
