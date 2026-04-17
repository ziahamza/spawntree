import { type Context, Hono } from "hono";
import type { StorageManager } from "../storage/manager.ts";

/**
 * HTTP routes for runtime storage configuration.
 *
 *   GET    /api/v1/storage                      → { primary, replicators[], availableProviders }
 *   PUT    /api/v1/storage/primary              → swap primary provider (body: { id, config })
 *   POST   /api/v1/storage/replicators          → add replicator (body: { rid, id, config })
 *   POST   /api/v1/storage/replicators/:rid/trigger → force an immediate run
 *   DELETE /api/v1/storage/replicators/:rid     → remove replicator
 *
 * All admin responses are JSON. Errors use { error, code } matching the
 * existing daemon error envelope.
 */
export function createStorageRoutes(manager: StorageManager) {
  const app = new Hono();

  app.get("/", async (c) => {
    try {
      return c.json(await manager.status());
    } catch (err) {
      return errorResponse(c, 500, "STORAGE_STATUS_FAILED", err);
    }
  });

  app.put("/primary", async (c) => {
    const body = await parseBody<{ id?: string; config?: unknown }>(c);
    if (!body || typeof body.id !== "string") {
      return c.json({ error: "Missing primary id", code: "INVALID_BODY" }, 400);
    }
    try {
      await manager.setPrimary({ id: body.id, config: body.config ?? {} });
      return c.json(await manager.status());
    } catch (err) {
      return errorResponse(c, 500, "SET_PRIMARY_FAILED", err);
    }
  });

  app.post("/replicators", async (c) => {
    const body = await parseBody<{ rid?: string; id?: string; config?: unknown }>(c);
    if (!body || typeof body.rid !== "string" || typeof body.id !== "string") {
      return c.json({ error: "rid and id are required", code: "INVALID_BODY" }, 400);
    }
    try {
      await manager.addReplicator(body.rid, body.id, body.config ?? {});
      return c.json(await manager.status(), 201);
    } catch (err) {
      return errorResponse(c, 400, "ADD_REPLICATOR_FAILED", err);
    }
  });

  app.post("/replicators/:rid/trigger", async (c) => {
    try {
      const status = await manager.triggerReplicator(c.req.param("rid"));
      return c.json({ status });
    } catch (err) {
      return errorResponse(c, 404, "TRIGGER_FAILED", err);
    }
  });

  app.delete("/replicators/:rid", async (c) => {
    try {
      await manager.removeReplicator(c.req.param("rid"));
      return c.json({ ok: true });
    } catch (err) {
      return errorResponse(c, 500, "REMOVE_REPLICATOR_FAILED", err);
    }
  });

  return app;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function parseBody<T>(c: Context): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

function errorResponse(
  c: Context,
  status: 400 | 404 | 500,
  code: string,
  err: unknown,
) {
  return c.json(
    {
      error: err instanceof Error ? err.message : String(err),
      code,
    },
    status,
  );
}
