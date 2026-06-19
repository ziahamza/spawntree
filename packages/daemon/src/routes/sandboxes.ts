import { Schema } from "effect";
import { type Context, Hono } from "hono";
import { CreateSandboxRequest, type SandboxSpec } from "spawntree-core";
import { BadRequestError } from "../errors.ts";
import {
  buildCorsHeaders,
  corsHeaderEntries,
  corsPolicyFromEnv,
  isAllowedBrowserOrigin,
} from "../lib/cors.ts";
import type { SandboxManager } from "../sandbox/manager.ts";

/**
 * Sandbox API routes — mount on the main Hono app at /api/v1/sandboxes.
 *
 * Routes:
 *   GET    /api/v1/sandboxes               list sandboxes (from catalog)
 *   POST   /api/v1/sandboxes               create + start a sandbox
 *   GET    /api/v1/sandboxes/providers     provider availability
 *   GET    /api/v1/sandboxes/:id           get one (catalog + live status)
 *   POST   /api/v1/sandboxes/:id/stop      stop
 *   POST   /api/v1/sandboxes/:id/restart   restart
 *   DELETE /api/v1/sandboxes/:id           stop + remove + drop catalog row
 *   GET    /api/v1/sandboxes/:id/logs      SSE stream of container logs
 */
export function createSandboxRoutes(manager: SandboxManager) {
  const app = new Hono();
  const policy = corsPolicyFromEnv("SPAWNTREE_SANDBOXES_TRUST_REMOTE");

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const pnaRequested = c.req.header("access-control-request-private-network") === "true";

    if (c.req.method === "OPTIONS") {
      if (!origin || !isAllowedBrowserOrigin(origin, policy)) {
        return c.text("Not Found", 404);
      }
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(origin, { pnaRequested }),
      });
    }

    await next();

    if (origin && isAllowedBrowserOrigin(origin, policy)) {
      for (const [name, value] of corsHeaderEntries(origin, { pnaRequested })) {
        c.header(name, value);
      }
    }
  });

  // Provider availability — registered before /:id so "providers" isn't read as an id.
  app.get("/providers", async (c) => {
    try {
      return c.json({ providers: await manager.availableProviders() });
    } catch (error) {
      return sandboxErrorResponse(error);
    }
  });

  app.get("/", async (c) => {
    try {
      return c.json({ sandboxes: await manager.listSandboxes() });
    } catch (error) {
      return sandboxErrorResponse(error);
    }
  });

  app.post("/", async (c) => {
    try {
      const body = await decodeBody(CreateSandboxRequest, c);
      const providerId = manager.resolveProviderId(body.provider);
      if (!providerId) {
        throw new BadRequestError({
          code: "NO_SANDBOX_PROVIDER",
          message: "No sandbox provider is enabled on this daemon.",
        });
      }
      const spec: SandboxSpec = {
        workspace: body.workspace,
        ...(body.image ? { image: body.image } : {}),
        ...(body.env ? { env: { ...body.env } } : {}),
        ...(body.resources ? { resources: body.resources } : {}),
        ...(body.labels ? { labels: { ...body.labels } } : {}),
        ...(body.ephemeral !== undefined ? { ephemeral: body.ephemeral } : {}),
        ...(body.repoId ? { repoId: body.repoId } : {}),
      };
      const sandbox = await manager.createSandbox(providerId, spec);
      return c.json(sandbox, 201);
    } catch (error) {
      return sandboxErrorResponse(error);
    }
  });

  app.get("/:id", async (c) => {
    try {
      const sandbox = await manager.getSandbox(c.req.param("id"));
      if (!sandbox) return notFound(c.req.param("id"));
      return c.json(sandbox);
    } catch (error) {
      return sandboxErrorResponse(error);
    }
  });

  app.post("/:id/stop", async (c) => {
    try {
      await manager.stopSandbox(c.req.param("id"));
      return c.json({ success: true });
    } catch (error) {
      return sandboxErrorResponse(error);
    }
  });

  app.post("/:id/restart", async (c) => {
    try {
      await manager.restartSandbox(c.req.param("id"));
      return c.json({ success: true });
    } catch (error) {
      return sandboxErrorResponse(error);
    }
  });

  app.delete("/:id", async (c) => {
    try {
      await manager.removeSandbox(c.req.param("id"));
      return c.json({ success: true });
    } catch (error) {
      return sandboxErrorResponse(error);
    }
  });

  // SSE stream of a sandbox's container logs.
  app.get("/:id/logs", async (c) => {
    const id = c.req.param("id");
    const controller = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => controller.abort(), { once: true });

    const body = new ReadableStream({
      start(sink) {
        const unsubscribe = manager.sandboxLogs(id, (stream, line) => {
          try {
            sink.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ stream, line })}\n\n`));
          } catch {
            // sink closed — stop pushing
          }
        });
        controller.signal.addEventListener(
          "abort",
          () => {
            unsubscribe();
            try {
              sink.close();
            } catch {
              // already closed
            }
          },
          { once: true },
        );
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

function notFound(id: string): Response {
  return new Response(JSON.stringify({ error: `sandbox not found: ${id}`, code: "NOT_FOUND" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

async function decodeBody<A extends Schema.Top>(schema: A, c: Context) {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new BadRequestError({ code: "INVALID_JSON", message: "Invalid JSON body" });
  }
  try {
    return await (Schema.decodeUnknownPromise(schema as never)(raw) as Promise<
      Schema.Schema.Type<A>
    >);
  } catch (error) {
    throw new BadRequestError({
      code: "INVALID_BODY",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function sandboxErrorResponse(error: unknown): Response {
  if (isTagged(error, "BadRequestError")) {
    return new Response(JSON.stringify({ error: error.message, code: error.code }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const status = /not (found|running)/i.test(message) ? 404 : 500;
  return new Response(JSON.stringify({ error: message, code: "INTERNAL_ERROR" }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isTagged<T extends string>(
  error: unknown,
  tag: T,
): error is { _tag: T; code: string; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error as { _tag: unknown })._tag === tag
  );
}
