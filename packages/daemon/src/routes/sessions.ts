import { Schema } from "effect";
import { type Context, Hono } from "hono";
import {
  CreateSessionRequest,
  ProviderCapabilityError,
  SendSessionMessageRequest,
  SessionBusyError,
  SessionDeleteUnsupportedError,
  UnknownProviderError,
} from "spawntree-core";
import { BadRequestError } from "../errors.ts";
import type { SessionManager } from "../sessions/session-manager.ts";

/**
 * Session API routes — mount on the main Hono app.
 *
 * Routes:
 *   GET    /api/v1/sessions                      list all sessions
 *   POST   /api/v1/sessions                      create session
 *   GET    /api/v1/sessions/:id                  get session detail
 *   DELETE /api/v1/sessions/:id                  delete / forget session
 *   POST   /api/v1/sessions/:id/messages         send a message (start a turn)
 *   POST   /api/v1/sessions/:id/interrupt        cancel active turn
 *   GET    /api/v1/sessions/:id/events           SSE stream of session events
 */
export function createSessionRoutes(manager: SessionManager) {
  const app = new Hono();

  // List all sessions across all providers.
  app.get("/", async (c) => {
    try {
      const sessions = await manager.listSessions();
      return c.json({
        sessions: sessions.map((s) => ({
          sessionId: s.sourceId,
          provider: s.provider,
          status: s.status,
          title: s.title,
          workingDirectory: s.workingDirectory,
          gitBranch: s.gitBranch,
          gitHeadCommit: s.gitHeadCommit,
          gitRemoteUrl: s.gitRemoteUrl,
          totalTurns: s.totalTurns,
          startedAt: s.startedAt,
          updatedAt: s.updatedAt,
        })),
      });
    } catch (error) {
      return sessionErrorResponse(error);
    }
  });

  // Create a new session.
  app.post("/", async (c) => {
    try {
      // decodeBody must be INSIDE the try so BadRequestError (invalid
      // JSON / schema mismatch) maps to HTTP 400 via sessionErrorResponse
      // instead of propagating uncaught and becoming a generic 500.
      const body = await decodeBody(CreateSessionRequest, c);
      const result = await manager.createSession(body.provider, {
        cwd: body.cwd,
        mcpServers: body.mcpServers as unknown[] | undefined,
      });
      return c.json(
        { sessionId: result.sessionId, provider: body.provider },
        201,
      );
    } catch (error) {
      return sessionErrorResponse(error);
    }
  });

  // Get a session's detail (turns + tool calls).
  app.get("/:id", async (c) => {
    const sessionId = c.req.param("id");
    try {
      const [info, detail] = await Promise.all([
        manager.getSessionInfo(sessionId),
        manager.getSessionDetail(sessionId),
      ]);
      return c.json({
        session: {
          sessionId: info.sourceId,
          provider: info.provider,
          status: info.status,
          title: info.title,
          workingDirectory: info.workingDirectory,
          gitBranch: info.gitBranch,
          gitHeadCommit: info.gitHeadCommit,
          gitRemoteUrl: info.gitRemoteUrl,
          totalTurns: info.totalTurns,
          startedAt: info.startedAt,
          updatedAt: info.updatedAt,
        },
        turns: detail.turns,
        toolCalls: detail.toolCalls,
      });
    } catch (error) {
      return sessionErrorResponse(error);
    }
  });

  // Delete / forget a session.
  app.delete("/:id", async (c) => {
    const sessionId = c.req.param("id");
    try {
      await manager.deleteSession(sessionId);
      return c.json({ ok: true });
    } catch (error) {
      return sessionErrorResponse(error);
    }
  });

  // Send a message — starts a new turn.
  app.post("/:id/messages", async (c) => {
    const sessionId = c.req.param("id");
    try {
      // Same reason as POST /: keep decodeBody inside try so the thrown
      // BadRequestError maps to HTTP 400 instead of becoming 500.
      const body = await decodeBody(SendSessionMessageRequest, c);
      await manager.sendMessage(sessionId, body.content);
      return c.json({ ok: true });
    } catch (error) {
      return sessionErrorResponse(error);
    }
  });

  // Cancel the active turn.
  app.post("/:id/interrupt", async (c) => {
    const sessionId = c.req.param("id");
    try {
      await manager.interrupt(sessionId);
      return c.json({ ok: true });
    } catch (error) {
      return sessionErrorResponse(error);
    }
  });

  // SSE stream of events for a single session.
  app.get("/:id/events", async (c) => {
    const sessionId = c.req.param("id");
    const controller = new AbortController();

    // Clean up when the client disconnects.
    c.req.raw.signal.addEventListener("abort", () => controller.abort(), {
      once: true,
    });

    const eventStream = manager.sessionEvents(sessionId, controller.signal);

    const body = new ReadableStream({
      async start(sink) {
        try {
          for await (const event of eventStream) {
            const data = `data: ${JSON.stringify(event)}\n\n`;
            sink.enqueue(new TextEncoder().encode(data));
          }
          sink.close();
        } catch {
          sink.close();
        }
      },
      cancel() {
        controller.abort();
      },
    });

    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  return app;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function decodeBody<A extends Schema.Top>(schema: A, c: Context) {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new BadRequestError({ code: "INVALID_JSON", message: "Invalid JSON body" });
  }
  try {
    return await (Schema.decodeUnknownPromise(schema as never)(raw) as Promise<Schema.Schema.Type<A>>);
  } catch (error) {
    throw new BadRequestError({
      code: "INVALID_BODY",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function sessionErrorResponse(error: unknown): Response {
  if (isTagged(error, "BadRequestError")) {
    return new Response(
      JSON.stringify({ error: error.message, code: error.code }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (isTagged(error, "NotFoundError")) {
    return new Response(
      JSON.stringify({ error: error.message, code: error.code }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }
  // Concurrent turn in flight — 409 Conflict so clients know to interrupt first.
  if (error instanceof SessionBusyError) {
    return new Response(
      JSON.stringify({
        error: error.message,
        code: error.code,
        details: { sessionId: error.sessionId, activeTurnId: error.activeTurnId },
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
  }
  // Provider doesn't support delete (e.g. Codex) — 501 Not Implemented
  // rather than a misleading 200 that pretends the session was removed.
  if (error instanceof SessionDeleteUnsupportedError) {
    return new Response(
      JSON.stringify({
        error: error.message,
        code: error.code,
        details: { sessionId: error.sessionId, provider: error.provider },
      }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    );
  }
  // Caller used a provider name that isn't registered.
  if (error instanceof UnknownProviderError) {
    return new Response(
      JSON.stringify({
        error: error.message,
        code: error.code,
        details: { provider: error.provider, available: error.available },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  // Provider exists but doesn't support the requested capability (e.g. Codex
  // has no explicit createSession — its agent creates sessions implicitly).
  if (error instanceof ProviderCapabilityError) {
    return new Response(
      JSON.stringify({
        error: error.message,
        code: error.code,
        details: { provider: error.provider, capability: error.capability },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const msg = error instanceof Error && error.message.includes("not found")
    ? 404
    : 500;
  return new Response(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      code: "INTERNAL_ERROR",
    }),
    { status: msg, headers: { "Content-Type": "application/json" } },
  );
}

function isTagged<T extends string>(
  error: unknown,
  tag: T,
): error is { _tag: T; code: string; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error as { _tag?: string })._tag === tag
  );
}
