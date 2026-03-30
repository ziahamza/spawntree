import { Hono } from "hono";
import { stream } from "hono/streaming";
import type {
  CreateEnvRequest,
  CreateEnvResponse,
  GetEnvResponse,
  ListEnvsResponse,
  DeleteEnvResponse,
  DownEnvResponse,
  DaemonInfo,
  GetInfraStatusResponse,
  StopInfraRequest,
  StopInfraResponse,
  ListDbTemplatesResponse,
  DumpDbRequest,
  DumpDbResponse,
  RestoreDbRequest,
  RestoreDbResponse,
  ApiError,
} from "spawntree-core";
import type { EnvManager } from "./managers/env-manager.js";
import { NotFoundError } from "./managers/env-manager.js";
import type { LogStreamer } from "./managers/log-streamer.js";
import type { PortRegistry } from "./managers/port-registry.js";

const DAEMON_VERSION = "0.1.0";
const startTime = Date.now();

function apiError(error: string, code: string, status: number, details?: unknown) {
  const body: ApiError = { error, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

function notFound(msg: string) {
  return apiError(msg, "NOT_FOUND", 404);
}

function badRequest(msg: string, details?: unknown) {
  return apiError(msg, "BAD_REQUEST", 400, details);
}

function internalError(msg: string, details?: unknown) {
  return apiError(msg, "INTERNAL_ERROR", 500, details);
}

export function createApp(
  envManager: EnvManager,
  logStreamer: LogStreamer,
  portRegistry: PortRegistry,
): Hono {
  const app = new Hono();

  // Root health check (no prefix)
  app.get("/", (c) => c.json({ status: "ok" }));

  // -------------------------------------------------------------------------
  // GET /api/v1/daemon  — daemon info
  // -------------------------------------------------------------------------
  app.get("/api/v1/daemon", (c) => {
    const info: DaemonInfo = {
      version: DAEMON_VERSION,
      pid: process.pid,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      repos: 0,
      activeEnvs: envManager.listEnvs().length,
    };
    return c.json(info);
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/envs  — create env (repoId derived from repoPath in body)
  // -------------------------------------------------------------------------
  app.post("/api/v1/envs", async (c) => {
    let body: CreateEnvRequest;
    try {
      body = await c.req.json<CreateEnvRequest>();
    } catch {
      return badRequest("Invalid JSON body");
    }

    if (!body.repoPath) {
      return badRequest("repoPath is required");
    }

    try {
      const env = await envManager.createEnv(body);
      const resp: CreateEnvResponse = { env };
      return c.json(resp, 201);
    } catch (err) {
      if (err instanceof NotFoundError) return notFound(err.message);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[spawntree-daemon] createEnv error: ${msg}`);
      return internalError(msg);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/envs  — list all envs
  // -------------------------------------------------------------------------
  app.get("/api/v1/envs", (c) => {
    try {
      const envs = envManager.listEnvs();
      const resp: ListEnvsResponse = { envs };
      return c.json(resp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return internalError(msg);
    }
  });

  // -------------------------------------------------------------------------
  // GET /repos/:repoId/envs  — list envs for repo
  // -------------------------------------------------------------------------
  app.get("/api/v1/repos/:repoId/envs", (c) => {
    const { repoId } = c.req.param();
    try {
      const envs = envManager.listEnvs(repoId);
      const resp: ListEnvsResponse = { envs };
      return c.json(resp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return internalError(msg);
    }
  });

  // -------------------------------------------------------------------------
  // GET /repos/:repoId/envs/:envId  — get env info
  // -------------------------------------------------------------------------
  app.get("/api/v1/repos/:repoId/envs/:envId", (c) => {
    const { repoId, envId } = c.req.param();
    try {
      const env = envManager.getEnv(repoId, envId);
      const resp: GetEnvResponse = { env };
      return c.json(resp);
    } catch (err) {
      if (err instanceof NotFoundError) return notFound(err.message);
      const msg = err instanceof Error ? err.message : String(err);
      return internalError(msg);
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /repos/:repoId/envs/:envId  — full teardown
  // -------------------------------------------------------------------------
  app.delete("/api/v1/repos/:repoId/envs/:envId", async (c) => {
    const { repoId, envId } = c.req.param();
    try {
      await envManager.deleteEnv(repoId, envId);
      const resp: DeleteEnvResponse = { ok: true };
      return c.json(resp);
    } catch (err) {
      if (err instanceof NotFoundError) return notFound(err.message);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[spawntree-daemon] deleteEnv error: ${msg}`);
      return internalError(msg);
    }
  });

  // -------------------------------------------------------------------------
  // POST /repos/:repoId/envs/:envId/down  — stop (keep state)
  // -------------------------------------------------------------------------
  app.post("/api/v1/repos/:repoId/envs/:envId/down", async (c) => {
    const { repoId, envId } = c.req.param();
    try {
      await envManager.downEnv(repoId, envId);
      const resp: DownEnvResponse = { ok: true };
      return c.json(resp);
    } catch (err) {
      if (err instanceof NotFoundError) return notFound(err.message);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[spawntree-daemon] downEnv error: ${msg}`);
      return internalError(msg);
    }
  });

  // -------------------------------------------------------------------------
  // GET /repos/:repoId/envs/:envId/logs  — SSE stream
  // -------------------------------------------------------------------------
  app.get("/api/v1/repos/:repoId/envs/:envId/logs", async (c) => {
    const { repoId, envId } = c.req.param();
    const serviceName = c.req.query("service");
    const follow = c.req.query("follow") !== "false";
    const linesParam = c.req.query("lines");
    const lines = linesParam ? parseInt(linesParam, 10) : 50;

    // Verify env exists
    try {
      envManager.getEnv(repoId, envId);
    } catch (err) {
      if (err instanceof NotFoundError) return notFound(err.message);
      const msg = err instanceof Error ? err.message : String(err);
      return internalError(msg);
    }

    const readable = logStreamer.subscribe(repoId, envId, {
      service: serviceName,
      follow,
      lines,
    });

    return stream(c, async (s) => {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      const reader = readable.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await s.write(value as Uint8Array);
        }
      } catch {
        // client disconnected
      } finally {
        reader.releaseLock();
      }
    });
  });

  // -------------------------------------------------------------------------
  // GET /infra  — infra status (stub)
  // -------------------------------------------------------------------------
  app.get("/api/v1/infra", (c) => {
    const resp: GetInfraStatusResponse = {
      postgres: [],
      redis: null,
    };
    return c.json(resp);
  });

  // -------------------------------------------------------------------------
  // POST /infra/stop  — stop infra (stub)
  // -------------------------------------------------------------------------
  app.post("/api/v1/infra/stop", async (c) => {
    let body: StopInfraRequest;
    try {
      body = await c.req.json<StopInfraRequest>();
    } catch {
      return badRequest("Invalid JSON body");
    }
    // Infra management not yet implemented for v0.1.0
    console.log(`[spawntree-daemon] infra/stop requested: target=${body.target}`);
    const resp: StopInfraResponse = { ok: true };
    return c.json(resp);
  });

  // -------------------------------------------------------------------------
  // GET /db/templates  — list DB templates (stub)
  // -------------------------------------------------------------------------
  app.get("/api/v1/db/templates", (c) => {
    const resp: ListDbTemplatesResponse = { templates: [] };
    return c.json(resp);
  });

  // -------------------------------------------------------------------------
  // POST /db/dump  — dump DB (stub)
  // -------------------------------------------------------------------------
  app.post("/api/v1/db/dump", async (c) => {
    let body: DumpDbRequest;
    try {
      body = await c.req.json<DumpDbRequest>();
    } catch {
      return badRequest("Invalid JSON body");
    }
    return internalError(`DB dump not yet implemented (requested: ${body.templateName})`);
  });

  // -------------------------------------------------------------------------
  // POST /db/restore  — restore DB (stub)
  // -------------------------------------------------------------------------
  app.post("/api/v1/db/restore", async (c) => {
    let body: RestoreDbRequest;
    try {
      body = await c.req.json<RestoreDbRequest>();
    } catch {
      return badRequest("Invalid JSON body");
    }
    return internalError(`DB restore not yet implemented (requested: ${body.templateName})`);
  });

  return app;
}
