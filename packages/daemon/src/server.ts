import { Effect, ManagedRuntime, Schema } from "effect";
import { type Context, Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AddFolderRequest,
  ArchiveWorktreeRequest,
  ConfigPreviewRequest,
  ConfigPreviewStopRequest,
  ConfigSaveRequest,
  ConfigSuggestRequest,
  ConfigTestRequest,
  CreateEnvRequest,
  DumpDbRequest,
  RegisterRepoRequest,
  RelinkCloneRequest,
  RestoreDbRequest,
  StopInfraRequest,
} from "spawntree-core";
import { BadRequestError } from "./errors.ts";
import { createCatalogRoutes } from "./routes/catalog.ts";
import { createSessionRoutes } from "./routes/sessions.ts";
import { createStorageRoutes } from "./routes/storage.ts";
import { DaemonService } from "./services/daemon-service.ts";
import type { SessionManager } from "./sessions/session-manager.ts";
import type { HostConfigSync } from "./storage/host-sync.ts";
import type { StorageManager } from "./storage/manager.ts";

/**
 * Where the SPA bundle lives at runtime. Two layouts supported:
 *
 *   1. **Published** (user ran `npm i -g spawntree`): the web bundle is
 *      copied into `packages/daemon/dist/web/` by the root `pnpm build`
 *      so `files: ["dist"]` ships everything together. This is the
 *      default — always checked first.
 *
 *   2. **Monorepo dev** (running `node packages/daemon/dist/...`): the
 *      web bundle lives at `packages/web/dist/`. We fall back to this
 *      when the self-contained location is missing.
 *
 * The fallback order is deterministic, not a scan — easy to reason
 * about and fast to check (one `existsSync` call at module load).
 */
const BUNDLED_WEB_DIR = resolve(fileURLToPath(new URL("./web", import.meta.url)));
const DEV_WEB_DIR = resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const webDistDir = existsSync(resolve(BUNDLED_WEB_DIR, "index.html"))
  ? BUNDLED_WEB_DIR
  : DEV_WEB_DIR;
const webIndexPath = resolve(webDistDir, "index.html");

export function createApp(
  runtime: ManagedRuntime.ManagedRuntime<DaemonService, never>,
  options: {
    storage?: StorageManager;
    sessionManager?: SessionManager;
    /**
     * The active host-config-sync loop, if `--host` was passed at boot.
     * Plumbed through so `GET /api/v1/storage` can include its state
     * (synced / awaiting_config / error / next-retry-at) and the
     * dashboard can paint a "host-bound" pill without a separate
     * endpoint.
     */
    hostSync?: HostConfigSync | null;
  } = {},
) {
  const app = new Hono();

  // CORS is applied per route group:
  //   - /api/v1/catalog and /api/v1/sessions use the shared module at
  //     `lib/cors.ts` with PNA support and the gitenv.dev allow-list.
  //   - The remaining routes (/api/v1/storage, /api/v1/envs, /api/v1/repos
  //     etc.) are admin surfaces only ever called by the daemon's own
  //     dashboard SPA bundled at the same origin, so they don't need CORS.
  // A global loopback-only `hono/cors` middleware here would shadow the
  // per-route CORS and silently break cross-origin reads from public
  // Studio (https://gitenv.dev), which is the whole point of the CORS+PNA
  // surface in `lib/cors.ts`.

  app.use(async (context, next) => {
    const startedAt = Date.now();
    process.stderr.write(`[spawntree-daemon] -> ${context.req.method} ${context.req.path}\n`);
    await next();
    process.stderr.write(
      `[spawntree-daemon] <- ${context.req.method} ${context.req.path} ${context.res.status} ${Date.now() - startedAt}ms\n`,
    );
  });

  app.get("/health", (context) => context.text("ok"));

  // Storage provider management + catalog query routes.
  if (options.storage) {
    app.route(
      "/api/v1/storage",
      createStorageRoutes(options.storage, { hostSync: options.hostSync ?? null }),
    );
    app.route("/api/v1/catalog", createCatalogRoutes(options.storage));
  }

  // Session manager routes (ACP agent sessions).
  if (options.sessionManager) {
    app.route("/api/v1/sessions", createSessionRoutes(options.sessionManager));
  }

  app.get("/api/v1/daemon", (context) => runJson(runtime, context, DaemonService.use((service) => service.daemonInfo)));

  app.get("/api/v1/envs", (context) => runJson(runtime, context, DaemonService.use((service) => service.listEnvs())));

  app.post("/api/v1/envs", async (context) => {
    const body = await decodeBody(CreateEnvRequest, context);
    return runJson(runtime, context, DaemonService.use((service) => service.createEnv(body)), 201);
  });

  app.get("/api/v1/repos/:repoId/envs", (context) =>
    runJson(
      runtime,
      context,
      DaemonService.use((service) => service.listEnvs(context.req.param("repoId"))),
    ));

  app.get("/api/v1/repos/:repoId/envs/:envId", (context) =>
    runJson(
      runtime,
      context,
      DaemonService.use((service) =>
        service.getEnv(context.req.param("repoId"), context.req.param("envId"), context.req.query("repoPath"))
      ),
    ));

  app.post("/api/v1/repos/:repoId/envs/:envId/down", (context) =>
    runJson(
      runtime,
      context,
      DaemonService.use((service) =>
        service.downEnv(context.req.param("repoId"), context.req.param("envId"), context.req.query("repoPath"))
      ),
    ));

  app.delete("/api/v1/repos/:repoId/envs/:envId", (context) =>
    runJson(
      runtime,
      context,
      DaemonService.use((service) =>
        service.deleteEnv(context.req.param("repoId"), context.req.param("envId"), context.req.query("repoPath"))
      ),
    ));

  app.get("/api/v1/repos/:repoId/envs/:envId/logs", async (context) => {
    try {
      const stream = await runtime.runPromise(
        DaemonService.use((service) =>
          service.logs(context.req.param("repoId"), context.req.param("envId"), context.req.query("repoPath"), {
            service: context.req.query("service"),
            follow: context.req.query("follow") !== "false",
            lines: context.req.query("lines") ? Number.parseInt(context.req.query("lines") ?? "50", 10) : 50,
          })
        ),
      );
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  });

  app.get("/api/v1/events", async (context) => {
    try {
      const since = context.req.query("since");
      const stream = await runtime.runPromise(
        DaemonService.use((service) => service.events(since ? Number.parseInt(since, 10) : undefined)),
      );
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  });

  app.get("/api/v1/infra", (context) => runJson(runtime, context, DaemonService.use((service) => service.infraStatus)));

  app.post("/api/v1/infra/stop", async (context) => {
    const body = await decodeBody(StopInfraRequest, context);
    return runJson(runtime, context, DaemonService.use((service) => service.stopInfra(body)));
  });

  app.post("/api/v1/registry/repos", async (context) => {
    const body = await decodeBody(RegisterRepoRequest, context);
    return runJson(runtime, context, DaemonService.use((service) => service.registerRepo(body)), 201);
  });

  app.post("/api/v1/db/dump", async (context) => {
    const body = await decodeBody(DumpDbRequest, context);
    return runJson(runtime, context, DaemonService.use((service) => service.dumpDb(body)));
  });

  app.post("/api/v1/db/restore", async (context) => {
    const body = await decodeBody(RestoreDbRequest, context);
    return runJson(runtime, context, DaemonService.use((service) => service.restoreDb(body)));
  });

  app.get(
    "/api/v1/web/repos",
    (context) => runJson(runtime, context, DaemonService.use((service) => service.listWebRepos)),
  );

  app.get("/api/v1/web/repos/:repoSlug/tree", (context) =>
    runJson(
      runtime,
      context,
      DaemonService.use((service) => service.getWebRepoTree(context.req.param("repoSlug"))),
    ));

  app.get("/api/v1/web/repos/:repoSlug", (context) =>
    runJson(
      runtime,
      context,
      DaemonService.use((service) => service.getWebRepo(context.req.param("repoSlug"))),
    ));

  app.post("/api/v1/web/repos/probe", async (context) => {
    const body = await decodeBody(Schema.Struct({ path: Schema.String }), context);
    return runJson(runtime, context, DaemonService.use((service) => service.probeAddPath(body.path)));
  });

  app.post("/api/v1/web/repos/add", async (context) => {
    const body = await decodeBody(AddFolderRequest, context);
    return runJson(runtime, context, DaemonService.use((service) => service.addFolder(body)), 201);
  });

  app.patch("/api/v1/web/repos/:repoSlug/clones/:cloneId", async (context) => {
    const body = await decodeBody(RelinkCloneRequest, context);
    return runJson(
      runtime,
      context,
      DaemonService.use((service) =>
        service.relinkClone(context.req.param("repoSlug"), context.req.param("cloneId"), body)
      ),
    );
  });

  app.delete("/api/v1/web/repos/:repoSlug/clones/:cloneId", (context) =>
    runJson(
      runtime,
      context,
      DaemonService.use((service) => service.deleteClone(context.req.param("repoSlug"), context.req.param("cloneId"))),
    ));

  app.post("/api/v1/web/repos/:repoSlug/worktrees/archive", async (context) => {
    const body = await decodeBody(ArchiveWorktreeRequest, context);
    return runJson(
      runtime,
      context,
      DaemonService.use((service) => service.archiveWorktree(context.req.param("repoSlug"), body)),
    );
  });

  app.post("/api/v1/web/config/suggest", async (context) => {
    const body = await decodeBody(ConfigSuggestRequest, context);
    return runJson(runtime, context, DaemonService.use((service) => service.suggestConfig(body)));
  });

  app.post("/api/v1/web/config/test", async (context) => {
    const body = await decodeBody(ConfigTestRequest, context);
    return runJson(runtime, context, DaemonService.use((service) => service.testConfig(body)));
  });

  app.post("/api/v1/web/config/preview/start", async (context) => {
    const body = await decodeBody(ConfigPreviewRequest, context);
    return runJson(runtime, context, DaemonService.use((service) => service.startConfigPreview(body)));
  });

  app.post("/api/v1/web/config/preview/stop", async (context) => {
    const body = await decodeBody(ConfigPreviewStopRequest, context);
    return runJson(runtime, context, DaemonService.use((service) => service.stopConfigPreview(body)));
  });

  app.post("/api/v1/web/config/save", async (context) => {
    const body = await decodeBody(ConfigSaveRequest, context);
    return runJson(runtime, context, DaemonService.use((service) => service.saveConfig(body)));
  });

  app.get("*", (context) => serveWebAsset(context.req.path));

  app.onError((error) => apiErrorResponse(error));

  return app;
}

export function hasBundledWebApp() {
  return existsSync(webIndexPath);
}

async function decodeBody<A extends Schema.Top>(schema: A, context: Context) {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new BadRequestError({ code: "INVALID_JSON", message: "Invalid JSON body" });
  }

  try {
    return await (Schema.decodeUnknownPromise(schema as never)(body) as Promise<Schema.Schema.Type<A>>);
  } catch (error) {
    throw new BadRequestError({ code: "INVALID_BODY", message: toErrorMessage(error) });
  }
}

async function runJson(
  runtime: ManagedRuntime.ManagedRuntime<DaemonService, never>,
  _context: Context,
  effect: Effect.Effect<unknown, unknown, DaemonService>,
  status = 200,
) {
  try {
    const body = await runtime.runPromise(effect);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

function apiErrorResponse(error: unknown) {
  const { status, code, message, details } = normalizeError(error);
  return new Response(JSON.stringify({ error: message, code, details }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function normalizeError(error: unknown) {
  if (isTagged(error, "BadRequestError")) {
    return { status: 400, code: error.code, message: error.message, details: error.details };
  }
  if (isTagged(error, "NotFoundError")) {
    return { status: 404, code: error.code, message: error.message, details: error.details };
  }
  if (isTagged(error, "ConflictError")) {
    return { status: 409, code: error.code, message: error.message, details: error.details };
  }
  if (isTagged(error, "InternalError")) {
    return { status: 500, code: error.code, message: error.message, details: error.details };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: toErrorMessage(error),
    details: undefined,
  };
}

function isTagged<T extends string>(
  error: unknown,
  tag: T,
): error is { _tag: T; code: string; message: string; details?: unknown; } {
  return typeof error === "object" && error !== null && "_tag" in error && (error as { _tag?: string; })._tag === tag;
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function serveWebAsset(pathname: string) {
  if (!hasBundledWebApp()) {
    return new Response(
      [
        "spawntree web bundle not found.",
        "",
        "Run `pnpm build` to have the daemon serve the built UI,",
        "or run `pnpm dev:web:qa` separately for live frontend development.",
      ].join("\n"),
      {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      },
    );
  }

  const safePath = pathname === "/" ? webIndexPath : resolve(webDistDir, `.${pathname}`);
  if (safePath.startsWith(webDistDir) && existsSync(safePath)) {
    return new Response(readFileSync(safePath), {
      headers: { "Content-Type": contentTypeFor(safePath) },
    });
  }

  return new Response(readFileSync(webIndexPath), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function contentTypeFor(path: string) {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}
