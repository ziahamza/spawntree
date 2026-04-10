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
import { DaemonService } from "./services/daemon-service.ts";

const webDistDir = resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const webIndexPath = resolve(webDistDir, "index.html");

export function createApp(runtime: ManagedRuntime.ManagedRuntime<DaemonService, never>) {
  const app = new Hono();

  app.use(async (context, next) => {
    const startedAt = Date.now();
    process.stderr.write(`[spawntree-daemon] -> ${context.req.method} ${context.req.path}\n`);
    await next();
    process.stderr.write(
      `[spawntree-daemon] <- ${context.req.method} ${context.req.path} ${context.res.status} ${Date.now() - startedAt}ms\n`,
    );
  });

  app.get("/health", (context) => context.text("ok"));

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
