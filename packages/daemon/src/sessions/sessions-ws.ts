import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { SessionEvent } from "spawntree-core";
import { SessionBusyError, SessionDeleteUnsupportedError } from "spawntree-core";
import type { SessionManager } from "./session-manager.ts";

/**
 * WebSocket endpoint for streaming session events bi-directionally.
 *
 * This is the transport foundation for the t3code adapter (see
 * `docs/t3code-adapter.md`). It uses spawntree's OWN wire shape
 * (`SessionEventPayload` — same types exposed over the existing SSE
 * endpoint) because we want to land the transport before committing
 * to t3code's Effect-RPC envelope. A translation layer in
 * `packages/daemon/src/t3code/` will map this to t3code's protocol
 * in a follow-up.
 *
 * Mounted at `/api/v1/sessions/ws`. Hono handles HTTP routing, but
 * Hono doesn't do WebSocket upgrades natively with our Node adapter,
 * so we attach our own `ws` server to the underlying Node HTTP server
 * and match on pathname.
 *
 * ## Wire format (JSON frames, one per message)
 *
 * Client → server:
 *   { type: "subscribe",      sessionId: "..." }
 *   { type: "unsubscribe",    sessionId: "..." }
 *   { type: "send_message",   sessionId: "...", content: "..." }
 *   { type: "interrupt",      sessionId: "..." }
 *
 * Server → client:
 *   { type: "session_event",  event: SessionEventPayload }
 *   { type: "ack",            op: "subscribe" | ..., sessionId: "..." }
 *   { type: "error",          code: "...", message: "...", sessionId?: "..." }
 *
 * Each client connection can subscribe to multiple sessions. The
 * filtered event bus (DomainEvents.subscribeSessionEvent) lets us hand
 * out scoped streams without leaking unrelated session activity.
 */

const WS_PATH = "/api/v1/sessions/ws";

type ClientMessage =
  | { type: "subscribe"; sessionId: string }
  | { type: "unsubscribe"; sessionId: string }
  | { type: "send_message"; sessionId: string; content: string }
  | { type: "interrupt"; sessionId: string };

interface ClientState {
  /** Per-subscription unsubscribe handles so we can tear them down on disconnect or unsubscribe. */
  subscriptions: Map<string, () => void>;
}

/**
 * Attach the session WebSocket endpoint to an existing Node HTTP server.
 * Returns a teardown function.
 */
export function attachSessionWebSocket(
  httpServer: HttpServer,
  manager: SessionManager,
): () => void {
  // `noServer: true` — we handle the upgrade ourselves so other WS endpoints
  // (e.g. the future t3code adapter) can coexist on the same HTTP server.
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (
    req: IncomingMessage,
    socket: Parameters<NonNullable<Parameters<HttpServer["on"]>[1]>>[1],
    head: Buffer,
  ) => {
    // Only handle our path. Other paths fall through to whatever else has
    // attached an upgrade listener.
    if (!req.url || !req.url.startsWith(WS_PATH)) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  };

  httpServer.on("upgrade", onUpgrade);

  wss.on("connection", (ws: WebSocket) => {
    const state: ClientState = { subscriptions: new Map() };

    ws.on("message", (raw) => {
      void handleClientMessage(ws, state, manager, raw.toString());
    });

    ws.on("close", () => {
      for (const unsub of state.subscriptions.values()) {
        try {
          unsub();
        } catch {
          // best-effort
        }
      }
      state.subscriptions.clear();
    });

    ws.on("error", () => {
      // Close handler cleans up. Don't explicitly close here; ws will do it.
    });
  });

  return () => {
    httpServer.removeListener("upgrade", onUpgrade);
    wss.close();
  };
}

async function handleClientMessage(
  ws: WebSocket,
  state: ClientState,
  manager: SessionManager,
  raw: string,
): Promise<void> {
  let msg: ClientMessage;
  try {
    const parsed = JSON.parse(raw) as ClientMessage;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      sendError(ws, "INVALID_MESSAGE", "message must be a JSON object with a `type` field");
      return;
    }
    msg = parsed;
  } catch {
    sendError(ws, "INVALID_JSON", "message is not valid JSON");
    return;
  }

  switch (msg.type) {
    case "subscribe":
      handleSubscribe(ws, state, manager, msg.sessionId);
      return;
    case "unsubscribe":
      handleUnsubscribe(ws, state, msg.sessionId);
      return;
    case "send_message":
      await handleSendMessage(ws, manager, msg.sessionId, msg.content);
      return;
    case "interrupt":
      await handleInterrupt(ws, manager, msg.sessionId);
      return;
    default: {
      const unknown = msg as { type?: string };
      sendError(ws, "UNKNOWN_TYPE", `unknown message type: ${unknown.type ?? "(missing)"}`);
    }
  }
}

function handleSubscribe(
  ws: WebSocket,
  state: ClientState,
  manager: SessionManager,
  sessionId: string,
): void {
  if (!sessionId) {
    sendError(ws, "INVALID_SUBSCRIBE", "sessionId is required");
    return;
  }
  // Idempotent: if already subscribed, acknowledge and return.
  if (state.subscriptions.has(sessionId)) {
    sendAck(ws, "subscribe", sessionId);
    return;
  }
  // Hook the filtered bus. The controller fires on unsubscribe.
  const controller = new AbortController();
  const iterator = manager.sessionEvents(sessionId, controller.signal);
  const unsub = () => controller.abort();
  state.subscriptions.set(sessionId, unsub);

  // Drive the async iterable in a fire-and-forget loop. If the socket
  // closes or the subscription is torn down, the AbortController fires
  // which makes the iterator terminate.
  //
  // The `finally` block MUST check map identity before deleting. A
  // rapid `unsubscribe(X)` → `subscribe(X)` sequence on the same tick
  // runs both sync handlers before the old generator's microtask
  // reaches `finally`. By then `state.subscriptions` holds the NEW
  // subscription's unsub, and an unconditional `delete(sessionId)`
  // would orphan it — no way to abort, no way to clean up the
  // DomainEvents handler. Check that our own `unsub` is still the
  // one in the map before removing.
  void (async () => {
    try {
      for await (const event of iterator) {
        if (ws.readyState !== ws.OPEN) break;
        sendEvent(ws, event);
      }
    } catch {
      // Silent — usually means the subscription was aborted normally.
    } finally {
      if (state.subscriptions.get(sessionId) === unsub) {
        state.subscriptions.delete(sessionId);
      }
    }
  })();

  sendAck(ws, "subscribe", sessionId);
}

function handleUnsubscribe(ws: WebSocket, state: ClientState, sessionId: string): void {
  const unsub = state.subscriptions.get(sessionId);
  if (unsub) {
    unsub();
    state.subscriptions.delete(sessionId);
  }
  sendAck(ws, "unsubscribe", sessionId);
}

async function handleSendMessage(
  ws: WebSocket,
  manager: SessionManager,
  sessionId: string,
  content: string,
): Promise<void> {
  if (!sessionId) {
    sendError(ws, "INVALID_SEND", "sessionId is required", sessionId);
    return;
  }
  if (typeof content !== "string" || content.length === 0) {
    sendError(ws, "INVALID_SEND", "content is required", sessionId);
    return;
  }
  try {
    await manager.sendMessage(sessionId, content);
    sendAck(ws, "send_message", sessionId);
  } catch (err) {
    if (err instanceof SessionBusyError) {
      sendError(ws, err.code, err.message, sessionId);
      return;
    }
    if (err instanceof SessionDeleteUnsupportedError) {
      // Shouldn't happen for send, but surface the code consistently.
      sendError(ws, err.code, err.message, sessionId);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    sendError(ws, "SEND_FAILED", message, sessionId);
  }
}

async function handleInterrupt(
  ws: WebSocket,
  manager: SessionManager,
  sessionId: string,
): Promise<void> {
  if (!sessionId) {
    sendError(ws, "INVALID_INTERRUPT", "sessionId is required", sessionId);
    return;
  }
  try {
    await manager.interrupt(sessionId);
    sendAck(ws, "interrupt", sessionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(ws, "INTERRUPT_FAILED", message, sessionId);
  }
}

function sendAck(ws: WebSocket, op: string, sessionId: string): void {
  safeSend(ws, { type: "ack", op, sessionId });
}

function sendEvent(ws: WebSocket, event: SessionEvent): void {
  safeSend(ws, { type: "session_event", event });
}

function sendError(ws: WebSocket, code: string, message: string, sessionId?: string): void {
  const payload: Record<string, unknown> = { type: "error", code, message };
  if (sessionId) payload.sessionId = sessionId;
  safeSend(ws, payload);
}

function safeSend(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // If send fails, the close handler will clean up.
  }
}
