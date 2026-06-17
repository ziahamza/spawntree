import { Hono } from "hono";
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
 * HTTP routes for the daemon catalog storage status.
 *
 * Storage itself is no longer pluggable at runtime. The daemon always uses the
 * local SQLite catalog opened through Turso Sync's local engine; host config
 * only changes the background sync method.
 */
export interface StorageRoutesOptions {
  hostSync?: HostConfigSync | null;
}

export function createStorageRoutes(manager: StorageManager, options: StorageRoutesOptions = {}) {
  const app = new Hono();
  const policy: CorsPolicy = {
    ...corsPolicyFromEnv("SPAWNTREE_STORAGE_TRUST_REMOTE"),
    trustRemote: process.env.SPAWNTREE_STORAGE_TRUST_REMOTE === "1",
  };
  const ALLOWED_METHODS = "GET,POST,OPTIONS";

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

  app.get("/", async (c) => {
    try {
      return c.json({
        ...(await manager.status()),
        hostSync: options.hostSync?.getStatus() ?? null,
      });
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : String(err),
          code: "STORAGE_STATUS_FAILED",
        },
        500,
      );
    }
  });

  app.post("/sync", async (c) => {
    try {
      await manager.syncNow();
      return c.json({
        ...(await manager.status()),
        hostSync: options.hostSync?.getStatus() ?? null,
      });
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : String(err),
          code: "STORAGE_SYNC_FAILED",
        },
        500,
      );
    }
  });

  return app;
}
