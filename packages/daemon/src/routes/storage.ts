import { type Context, Hono } from "hono";
import {
  buildCorsHeaders,
  corsHeaderEntries,
  corsPolicyFromEnv,
  isAllowedBrowserOrigin,
  type CorsPolicy,
} from "../lib/cors.ts";
import type { HostConfigSync } from "../storage/host-sync.ts";
import type { StorageManager } from "../storage/manager.ts";

/**
 * HTTP routes for runtime storage configuration.
 *
 *   GET    /api/v1/storage                               → { primary, replicators[], availableProviders, migrating }
 *   PUT    /api/v1/storage/primary                       → swap primary provider (body: { id, config })
 *   POST   /api/v1/storage/primary/probe                 → test-connect a primary config without committing
 *   POST   /api/v1/storage/replicators                   → add replicator (body: { rid, id, config })
 *   POST   /api/v1/storage/replicators/probe             → test-connect a replicator config without committing
 *   POST   /api/v1/storage/replicators/:rid/trigger      → force an immediate run
 *   DELETE /api/v1/storage/replicators/:rid              → remove replicator
 *
 * Admin mutations are gated behind a localhost-origin check — anything that
 * isn't 127.0.0.1/::1 is rejected with 403 unless `SPAWNTREE_STORAGE_TRUST_REMOTE=1`
 * is set. That keeps drive-by CSRF attempts from flipping someone's
 * production primary to an attacker-controlled Turso URL.
 *
 * All admin responses are JSON. Errors use { error, code } matching the
 * existing daemon error envelope.
 */
export interface StorageRoutesOptions {
  /**
   * If false, admin mutations that arrive from a non-loopback origin are
   * rejected. Defaults to checking `SPAWNTREE_STORAGE_TRUST_REMOTE` env var.
   */
  trustRemoteOrigin?: boolean;
  /**
   * The host-config-sync loop, if the daemon was booted with a `--host`
   * binding. When present, `GET /api/v1/storage` includes its current
   * status (state machine + last-error/next-retry) so the dashboard can
   * surface "I'm bound to host X · synced 5m ago" without a separate
   * endpoint. Null in standalone mode.
   */
  hostSync?: HostConfigSync | null;
}

export function createStorageRoutes(
  manager: StorageManager,
  options: StorageRoutesOptions = {},
) {
  const app = new Hono();
  const policy: CorsPolicy = {
    ...corsPolicyFromEnv("SPAWNTREE_STORAGE_TRUST_REMOTE"),
    trustRemote: options.trustRemoteOrigin
      ?? process.env.SPAWNTREE_STORAGE_TRUST_REMOTE === "1",
  };
  // Storage routes accept GET (read) plus PUT/POST/DELETE (admin writes).
  // The catalog default ("GET,POST,DELETE,OPTIONS") doesn't include PUT,
  // which matters because `PUT /primary` is the primary swap endpoint.
  const ALLOWED_METHODS = "GET,POST,PUT,DELETE,OPTIONS";

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const pnaRequested = c.req.header("access-control-request-private-network") === "true";

    if (c.req.method === "OPTIONS") {
      if (!origin || !isAllowedBrowserOrigin(origin, policy)) {
        return c.text("Not Found", 404);
      }
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(origin, { pnaRequested, methods: ALLOWED_METHODS }),
      });
    }

    await next();

    if (origin && isAllowedBrowserOrigin(origin, policy)) {
      for (const [name, value] of corsHeaderEntries(origin, {
        pnaRequested,
        methods: ALLOWED_METHODS,
      })) {
        c.header(name, value);
      }
    }
  });

  /**
   * Loopback gate for the admin write surface. `GET /` is deliberately
   * NOT wrapped — it's a read-only status snapshot, safe to expose to any
   * CORS-allow-listed browser origin (including public Studio at
   * gitenv.dev). The CORS middleware above is the origin filter; this
   * gate is the additional IP filter for write methods.
   */
  const requireLocalOrigin = async (c: Context, next: () => Promise<void>) => {
    if (policy.trustRemote) return next();
    if (isLoopbackRequest(c)) return next();
    return c.json(
      {
        error: "storage admin endpoints are restricted to loopback clients",
        code: "STORAGE_REMOTE_DENIED",
      },
      403,
    );
  };

  app.get("/", async (c) => {
    try {
      const status = await manager.status();
      // Surface host binding state alongside the storage snapshot so a
      // single fetch tells the dashboard everything it needs to draw
      // the "Storage" card. `hostSync: null` is a deliberate signal —
      // the daemon is in standalone mode (no `--host` binding).
      return c.json({
        ...status,
        hostSync: options.hostSync?.getStatus() ?? null,
      });
    } catch (err) {
      return errorResponse(c, 500, "STORAGE_STATUS_FAILED", err);
    }
  });

  app.put("/primary", requireLocalOrigin, async (c) => {
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

  app.post("/primary/probe", requireLocalOrigin, async (c) => {
    const body = await parseBody<{ id?: string; config?: unknown }>(c);
    if (!body || typeof body.id !== "string") {
      return c.json({ error: "Missing primary id", code: "INVALID_BODY" }, 400);
    }
    const result = await manager.probePrimary({ id: body.id, config: body.config ?? {} });
    return c.json(result, result.ok ? 200 : 400);
  });

  app.post("/replicators", requireLocalOrigin, async (c) => {
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

  app.post("/replicators/probe", requireLocalOrigin, async (c) => {
    const body = await parseBody<{ id?: string; config?: unknown }>(c);
    if (!body || typeof body.id !== "string") {
      return c.json({ error: "Missing replicator id", code: "INVALID_BODY" }, 400);
    }
    const result = await manager.probeReplicator({ id: body.id, config: body.config ?? {} });
    return c.json(result, result.ok ? 200 : 400);
  });

  app.post("/replicators/:rid/trigger", requireLocalOrigin, async (c) => {
    const rid = c.req.param("rid");
    if (!rid) return c.json({ error: "rid is required", code: "INVALID_PARAM" }, 400);
    try {
      const status = await manager.triggerReplicator(rid);
      return c.json({ status });
    } catch (err) {
      return errorResponse(c, 404, "TRIGGER_FAILED", err);
    }
  });

  app.delete("/replicators/:rid", requireLocalOrigin, async (c) => {
    const rid = c.req.param("rid");
    if (!rid) return c.json({ error: "rid is required", code: "INVALID_PARAM" }, 400);
    try {
      await manager.removeReplicator(rid);
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

/**
 * Best-effort check that the request originated from a loopback client.
 * We rely on Hono's `c.env.incoming` (from `@hono/node-server`) for the raw
 * Node request so we can inspect `remoteAddress`. If the upstream sits behind
 * a reverse proxy (uncommon for spawntree's single-user daemon), the user can
 * opt in with `SPAWNTREE_STORAGE_TRUST_REMOTE=1`.
 */
function isLoopbackRequest(c: Context): boolean {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } };
  const addr = env?.incoming?.socket?.remoteAddress ?? "";
  return (
    addr === "127.0.0.1"
    || addr === "::1"
    || addr === "::ffff:127.0.0.1"
    || addr.startsWith("127.")
  );
}
