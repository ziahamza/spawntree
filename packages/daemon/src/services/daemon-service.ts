import { Effect, Layer, ServiceMap } from "effect";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type AddFolderProbeResult,
  type AddFolderRequest,
  type AddFolderResponse,
  type ArchiveWorktreeRequest,
  type Clone,
  type ConfigPreviewRequest,
  type ConfigPreviewResponse,
  type ConfigPreviewStopRequest,
  type ConfigSaveRequest,
  type ConfigSaveResponse,
  type ConfigServiceSuggestion,
  type ConfigSignal,
  type ConfigSuggestRequest,
  type ConfigSuggestResponse,
  type ConfigTestRequest,
  type ConfigTestResponse,
  type ConfigTestServiceResult,
  type CreateEnvRequest,
  type CreateEnvResponse,
  type DaemonInfo,
  deriveRepoId,
  type DomainEvent,
  type DumpDbRequest,
  type DumpDbResponse,
  type EnvInfo,
  type GetEnvResponse,
  type GitPathInfo,
  type InfraStatusResponse,
  type ListEnvsResponse,
  loadEnv,
  parseConfig,
  type RegisteredRepo,
  type RegisterRepoRequest,
  type RegisterRepoResponse,
  type RelinkCloneRequest,
  type Repo,
  type RestoreDbRequest,
  type RestoreDbResponse,
  type ServiceConfig,
  type ServiceInfo,
  type StopInfraRequest,
  type StopInfraResponse,
  validateConfig,
  type WatchedPath,
  type WebListReposResponse,
  type WebRepo,
  type WebRepoDetailResponse,
  type WebRepoTreeResponse,
  type Worktree,
} from "spawntree-core";
import { parse as parseYaml } from "yaml";
import { CatalogDatabase } from "../catalog/database.ts";
import {
  canonicalRepoId,
  deriveCloneId,
  detectRemotes,
  detectRepoInfo,
  defaultBranchName,
  discoverWorktrees,
  findImmediateGitRepos,
  findWorktreeForBranch,
  inspectGitPath,
  normalizeInputPath,
  parseRemoteUrl,
  probePath,
  removeGitWorktree,
  repoSlug,
  tryGhMetadata,
  validateGitRepo,
} from "../catalog/git.ts";
import { BadRequestError, ConflictError, InternalError, NotFoundError } from "../errors.ts";
import { DomainEvents } from "../events/domain-events.ts";
import { EnvManager, NotFoundError as EnvManagerNotFoundError } from "../managers/env-manager.ts";
import { InfraManager } from "../managers/infra-manager.ts";
import { LogStreamer } from "../managers/log-streamer.ts";
import { PortRegistry } from "../managers/port-registry.ts";
import { ProxyManager } from "../managers/proxy-manager.ts";
import { spawntreeHome } from "../state/global-state.ts";

const VERSION = "0.4.0";
type DaemonError = BadRequestError | ConflictError | InternalError | NotFoundError;

interface PreviewSession {
  previewId: string;
  repoId: string;
  envId: string;
  repoPath: string;
  configPath: string;
  env: EnvInfo;
}

export class DaemonService extends ServiceMap.Service<DaemonService, {
  readonly shutdown: Effect.Effect<void, DaemonError>;
  readonly daemonInfo: Effect.Effect<DaemonInfo, DaemonError>;
  listEnvs(repoId?: string): Effect.Effect<ListEnvsResponse, DaemonError>;
  createEnv(request: CreateEnvRequest): Effect.Effect<CreateEnvResponse, DaemonError>;
  getEnv(repoRef: string, envId: string, repoPath?: string): Effect.Effect<GetEnvResponse, DaemonError>;
  downEnv(repoRef: string, envId: string, repoPath?: string): Effect.Effect<void, DaemonError>;
  deleteEnv(repoRef: string, envId: string, repoPath?: string): Effect.Effect<void, DaemonError>;
  logs(
    repoRef: string,
    envId: string,
    repoPath: string | undefined,
    options: { service?: string; follow?: boolean; lines?: number; },
  ): Effect.Effect<ReadableStream<Uint8Array>, DaemonError>;
  events(since?: number): Effect.Effect<ReadableStream<Uint8Array>>;
  registerRepo(request: RegisterRepoRequest): Effect.Effect<RegisterRepoResponse, DaemonError>;
  infraStatus: Effect.Effect<InfraStatusResponse, DaemonError>;
  stopInfra(request: StopInfraRequest): Effect.Effect<StopInfraResponse, DaemonError>;
  dumpDb(request: DumpDbRequest): Effect.Effect<DumpDbResponse, DaemonError>;
  restoreDb(request: RestoreDbRequest): Effect.Effect<RestoreDbResponse, DaemonError>;
  readonly listWebRepos: Effect.Effect<WebListReposResponse, DaemonError>;
  getWebRepoTree(repoSlug: string): Effect.Effect<WebRepoTreeResponse, DaemonError>;
  getWebRepo(repoSlug: string): Effect.Effect<WebRepoDetailResponse, DaemonError>;
  probeAddPath(path: string): Effect.Effect<AddFolderProbeResult, DaemonError>;
  addFolder(request: AddFolderRequest): Effect.Effect<AddFolderResponse, DaemonError>;
  relinkClone(repoSlug: string, cloneId: string, request: RelinkCloneRequest): Effect.Effect<void, DaemonError>;
  deleteClone(repoSlug: string, cloneId: string): Effect.Effect<void, DaemonError>;
  archiveWorktree(repoSlug: string, request: ArchiveWorktreeRequest): Effect.Effect<void, DaemonError>;
  suggestConfig(request: ConfigSuggestRequest): Effect.Effect<ConfigSuggestResponse, DaemonError>;
  testConfig(request: ConfigTestRequest): Effect.Effect<ConfigTestResponse, DaemonError>;
  startConfigPreview(request: ConfigPreviewRequest): Effect.Effect<ConfigPreviewResponse, DaemonError>;
  stopConfigPreview(request: ConfigPreviewStopRequest): Effect.Effect<void, DaemonError>;
  saveConfig(request: ConfigSaveRequest): Effect.Effect<ConfigSaveResponse, DaemonError>;
}>()("spawntree/DaemonService") {
  static readonly layer = Layer.effect(
    DaemonService,
    Effect.sync(() => {
      const startedAt = Date.now();
      const portRegistry = new PortRegistry();
      const logStreamer = new LogStreamer();
      const infraManager = new InfraManager();
      const proxyManager = new ProxyManager();
      const envManager = new EnvManager(portRegistry, logStreamer, infraManager, proxyManager);
      const catalog = new CatalogDatabase();
      const events = new DomainEvents();
      const previewSessions = new Map<string, PreviewSession>();

      const publish = (event: Omit<DomainEvent, "seq" | "timestamp">) => {
        events.publish(event);
      };

      const shutdown = Effect.gen(function*() {
        for (const session of previewSessions.values()) {
          yield* Effect.tryPromise({
            try: () => envManager.deleteEnv(session.repoId, session.envId),
            catch: (error) => new InternalError({ code: "PREVIEW_SHUTDOWN_FAILED", message: toMessage(error) }),
          }).pipe(Effect.catchTag("InternalError", () => Effect.void));
          safeRemove(session.configPath);
        }
        previewSessions.clear();

        const envs = envManager.listEnvs();
        for (const env of envs) {
          yield* Effect.tryPromise({
            try: () => envManager.downEnv(env.repoId, env.envId),
            catch: (error) => new InternalError({ code: "ENV_SHUTDOWN_FAILED", message: toMessage(error) }),
          }).pipe(Effect.catchTag("InternalError", () => Effect.void));
        }

        yield* Effect.tryPromise({
          try: () => proxyManager.stop(),
          catch: (error) => new InternalError({ code: "PROXY_STOP_FAILED", message: toMessage(error) }),
        }).pipe(Effect.catchTag("InternalError", () => Effect.void));

        yield* Effect.sync(() => {
          catalog.close();
        });
      });

      const daemonInfo = Effect.sync(() => ({
        version: VERSION,
        pid: process.pid,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        repos: catalog.repoCount(),
        activeEnvs: envManager.listEnvs().length,
      }));

      const listEnvs = Effect.fn("DaemonService.listEnvs")(function*(repoId?: string) {
        return yield* Effect.succeed({ envs: envManager.listEnvs(repoId) });
      });

      const createEnv = Effect.fn("DaemonService.createEnv")(function*(request: CreateEnvRequest) {
        logDaemonMessage("create env", { repoPath: request.repoPath, envId: request.envId, configFile: request.configFile });
        const env = yield* Effect.tryPromise({
          try: () => envManager.createEnv(request),
          catch: mapCreateEnvError,
        });
        logDaemonMessage("env ready", { repoId: env.repoId, envId: env.envId, repoPath: env.repoPath });
        publish({ type: "env.updated", repoId: env.repoId, envId: env.envId, repoSlug: repoSlugForRepoId(catalog, env.repoId) });
        return { env };
      });

      const getEnv = Effect.fn("DaemonService.getEnv")(function*(repoRef: string, envId: string, repoPath?: string) {
        const resolved = yield* resolveRepoEnv(catalog, envManager, previewSessions, repoRef, envId, repoPath);
        return { env: resolved.env };
      });

      const downEnv = Effect.fn("DaemonService.downEnv")(function*(repoRef: string, envId: string, repoPath?: string) {
        const resolved = yield* resolveRepoEnv(catalog, envManager, previewSessions, repoRef, envId, repoPath);
        logDaemonMessage("down env", { repoId: resolved.repoId, envId: resolved.env.envId, repoPath: resolved.env.repoPath });
        yield* Effect.tryPromise({
          try: () => envManager.downEnv(resolved.repoId, resolved.env.envId),
          catch: (error) => mapInternalError("DOWN_ENV_FAILED", error),
        });
        publish({
          type: "env.updated",
          repoId: resolved.repoId,
          envId: resolved.env.envId,
          repoSlug: repoSlugForRepoId(catalog, resolved.repoId),
        });
      });

      const deleteEnv = Effect.fn("DaemonService.deleteEnv")(
        function*(repoRef: string, envId: string, repoPath?: string) {
          const resolved = yield* resolveRepoEnv(catalog, envManager, previewSessions, repoRef, envId, repoPath);
          logDaemonMessage("delete env", { repoId: resolved.repoId, envId: resolved.env.envId, repoPath: resolved.env.repoPath });
          yield* Effect.tryPromise({
            try: () => envManager.deleteEnv(resolved.repoId, resolved.env.envId),
            catch: (error) => mapInternalError("DELETE_ENV_FAILED", error),
          });
          publish({
            type: "env.deleted",
            repoId: resolved.repoId,
            envId: resolved.env.envId,
            repoSlug: repoSlugForRepoId(catalog, resolved.repoId),
          });
        },
      );

      const logs = Effect.fn("DaemonService.logs")(function*(
        repoRef: string,
        envId: string,
        repoPath: string | undefined,
        options: { service?: string; follow?: boolean; lines?: number; },
      ) {
        const resolved = yield* resolveRepoEnv(catalog, envManager, previewSessions, repoRef, envId, repoPath);
        logDaemonMessage("open log stream", {
          repoId: resolved.repoId,
          envId: resolved.env.envId,
          service: options.service ?? "all",
          follow: options.follow ?? true,
          lines: options.lines ?? 50,
        });
        return logStreamer.subscribe(resolved.repoId, resolved.env.envId, options);
      });

      const domainEvents = Effect.fn("DaemonService.events")(function*(since?: number) {
        return yield* Effect.succeed(sseStream((signal) => events.subscribe(since ?? 0, signal)));
      });

      const registerRepo = Effect.fn("DaemonService.registerRepo")(function*(request: RegisterRepoRequest) {
        const repoPath = yield* normalizeRepoPath(request.repoPath);
        const repoId = deriveRepoId(repoPath) as RegisteredRepo["repoId"];
        const repo: RegisteredRepo = {
          repoId,
          repoPath,
          configPath: request.configPath,
          lastSeenAt: new Date().toISOString(),
        };
        yield* Effect.sync(() => {
          catalog.registerRepo(repo);
        });
        publish({ type: "repo.updated", repoId });
        return { repo };
      });

      const infraStatus = Effect.tryPromise({
        try: () => infraManager.getStatus(),
        catch: (error) => mapInternalError("INFRA_STATUS_FAILED", error),
      });

      const stopInfra = Effect.fn("DaemonService.stopInfra")(function*(request: StopInfraRequest) {
        yield* Effect.tryPromise({
          try: async () => {
            switch (request.target) {
              case "postgres":
                await infraManager.stopPostgres(request.version);
                return;
              case "redis":
                await infraManager.stopRedis();
                return;
              case "all":
                await infraManager.stopAll();
                return;
              default:
                throw new BadRequestError({
                  code: "INVALID_TARGET",
                  message: "target must be postgres, redis, or all",
                });
            }
          },
          catch: (error) => mapStopInfraError(error),
        });
        publish({ type: "infra.updated" });
        return { ok: true };
      });

      const dumpDb = Effect.fn("DaemonService.dumpDb")(function*(request: DumpDbRequest) {
        const runner = yield* Effect.tryPromise({
          try: () => infraManager.ensurePostgres(),
          catch: (error) => mapInternalError("POSTGRES_UNAVAILABLE", error),
        });
        yield* Effect.tryPromise({
          try: () => runner.dumpToTemplate(request.dbName, request.templateName),
          catch: (error) => mapInternalError("DB_DUMP_FAILED", error),
        });
        const template = yield* Effect.sync(() => {
          const found = runner.listTemplates().find((item) => item.name === request.templateName);
          if (!found) {
            throw new InternalError({
              code: "TEMPLATE_NOT_FOUND",
              message: "Template saved but could not be reloaded",
            });
          }
          return found;
        });
        return { template };
      });

      const restoreDb = Effect.fn("DaemonService.restoreDb")(function*(request: RestoreDbRequest) {
        const runner = yield* Effect.tryPromise({
          try: () => infraManager.ensurePostgres(),
          catch: (error) => mapInternalError("POSTGRES_UNAVAILABLE", error),
        });
        yield* Effect.tryPromise({
          try: () => runner.restoreFromTemplate(request.dbName, request.templateName),
          catch: (error) => mapInternalError("DB_RESTORE_FAILED", error),
        });
        return { ok: true };
      });

      const listWebRepos = Effect.gen(function*() {
        const listStartedAt = Date.now();
        const repos = yield* Effect.sync(() => catalog.listRepos());
        const enriched = repos.map((repo) => enrichRepo(repo, catalog, envManager));
        logDaemonMessage("repo list ready", {
          repoCount: enriched.length,
          durationMs: Date.now() - listStartedAt,
        });
        return { repos: enriched };
      });

      const getWebRepoTree = Effect.fn("DaemonService.getWebRepoTree")(function*(repoSlugValue: string) {
        const treeStartedAt = Date.now();
        const repo = yield* getRepoBySlug(catalog, repoSlugValue);
        const clones = yield* Effect.sync(() => catalog.listClones(repo.id));
        const worktreesByClone: Record<string, Array<Worktree>> = {};

        for (const clone of clones) {
          yield* syncCloneWorktrees(catalog, clone);
          worktreesByClone[clone.id] = catalog.listWorktrees(clone.id);
        }

        const refreshedClones = yield* Effect.sync(() => catalog.listClones(repo.id));
        const envs = listRepoEnvsForRepo(catalog, envManager, repo);

        logDaemonMessage("repo tree ready", {
          repoSlug: repoSlugValue,
          cloneCount: refreshedClones.length,
          envCount: envs.length,
          durationMs: Date.now() - treeStartedAt,
        });

        return {
          repo,
          clones: refreshedClones,
          worktrees: worktreesByClone,
          envs,
        };
      });

      const getWebRepo = Effect.fn("DaemonService.getWebRepo")(function*(repoSlugValue: string) {
        const detailStartedAt = Date.now();
        const repo = yield* getRepoBySlug(catalog, repoSlugValue);
        const clones = yield* Effect.sync(() => catalog.listClones(repo.id));
        const worktreesByClone: Record<string, Array<Worktree>> = {};

        for (const clone of clones) {
          yield* syncCloneWorktrees(catalog, clone);
          worktreesByClone[clone.id] = catalog.listWorktrees(clone.id);
        }

        const refreshedClones = yield* Effect.sync(() => catalog.listClones(repo.id));
        const envs = listRepoEnvsForRepo(catalog, envManager, repo);
        const gitStartedAt = Date.now();
        const gitPaths = buildGitPathInfoMap(repo, refreshedClones, worktreesByClone, envs);

        logDaemonMessage("repo detail ready", {
          repoSlug: repoSlugValue,
          cloneCount: refreshedClones.length,
          envCount: envs.length,
          worktreeSyncMs: gitStartedAt - detailStartedAt,
          gitMetaMs: Date.now() - gitStartedAt,
          durationMs: Date.now() - detailStartedAt,
        });

        return {
          repo,
          clones: refreshedClones,
          worktrees: worktreesByClone,
          envs,
          gitPaths,
        };
      });

      const probeAddPath = Effect.fn("DaemonService.probeAddPath")(function*(path: string) {
        return yield* Effect.try({
          try: () => probePath(path),
          catch: (error) => new BadRequestError({ code: "INVALID_PATH", message: toMessage(error) }),
        });
      });

      const addFolder = Effect.fn("DaemonService.addFolder")(function*(request: AddFolderRequest) {
        logDaemonMessage("add folder", { path: request.path, remoteName: request.remoteName, scanChildren: request.scanChildren });
        const probe = yield* Effect.try({
          try: () => probePath(request.path),
          catch: (error) => new BadRequestError({ code: "INVALID_PATH", message: toMessage(error) }),
        });

        if (!probe.exists) {
          return yield* new BadRequestError({ code: "PATH_NOT_FOUND", message: "Path not found" });
        }

        if (probe.isGitRepo && !request.remoteName) {
          const remotes = yield* Effect.try({
            try: () => detectRemotes(probe.path),
            catch: (error) => new InternalError({ code: "REMOTE_DETECTION_FAILED", message: toMessage(error) }),
          });
          if (remotes.length > 1) {
            return { remotes };
          }
        }

        const watchedPath: WatchedPath = {
          path: probe.path,
          scanChildren: !probe.isGitRepo && !!request.scanChildren,
          addedAt: new Date().toISOString(),
        };

        yield* Effect.sync(() => {
          catalog.upsertWatchedPath(watchedPath);
        });

        if (probe.isGitRepo) {
          const imported = yield* importGitRepoPath(catalog, probe.path, request.remoteName, true);
          publish({ type: "repo.updated", repoId: imported.repo.id, repoSlug: imported.repo.slug });
          return {
            repo: imported.repo,
            clone: imported.clone,
            watchedPath,
            importedCount: 1,
          };
        }

        let importedCount = 0;
        if (watchedPath.scanChildren) {
          importedCount = yield* syncWatchedPath(catalog, watchedPath);
        }
        publish({ type: "repo.updated" });
        return { watchedPath, importedCount };
      });

      const relinkClone = Effect.fn("DaemonService.relinkClone")(
        function*(repoSlugValue: string, cloneId: string, request: RelinkCloneRequest) {
          yield* getRepoBySlug(catalog, repoSlugValue);
          const clone = yield* getClone(catalog, cloneId);
          const gitRoot = yield* normalizeRepoPath(request.path);
          yield* Effect.try({
            try: () => {
              validateGitRepo(gitRoot);
              catalog.updateClonePath(clone.id, gitRoot);
              syncCloneWorktreesSync(catalog, { ...clone, path: gitRoot });
            },
            catch: (error) => new BadRequestError({ code: "RELINK_FAILED", message: toMessage(error) }),
          });
          publish({ type: "repo.updated", repoSlug: repoSlugValue });
        },
      );

      const deleteClone = Effect.fn("DaemonService.deleteClone")(function*(repoSlugValue: string, cloneId: string) {
        const repo = yield* getRepoBySlug(catalog, repoSlugValue);
        const clone = yield* getClone(catalog, cloneId);
        const worktrees = yield* Effect.sync(() => catalog.listWorktrees(clone.id));
        const activePaths = new Set<string>([clone.path, ...worktrees.map((worktree) => worktree.path)]);

        for (const env of listRepoEnvsForRepo(catalog, envManager, repo)) {
          if (!activePaths.has(env.repoPath)) {
            continue;
          }
          if (
            env.services.some((service: ServiceInfo) => service.status === "running" || service.status === "starting")
          ) {
            return yield* new ConflictError({
              code: "CLONE_HAS_RUNNING_ENVS",
              message: "Cannot delete clone with running environments. Stop them first.",
            });
          }
        }

        yield* Effect.sync(() => {
          catalog.deleteClone(cloneId);
        });
        publish({ type: "repo.updated", repoSlug: repoSlugValue });
      });

      const archiveWorktree = Effect.fn("DaemonService.archiveWorktree")(
        function*(repoSlugValue: string, request: ArchiveWorktreeRequest) {
          const repo = yield* getRepoBySlug(catalog, repoSlugValue);
          const clones = yield* Effect.sync(() => catalog.listClones(repo.id));

          const ownerClone = clones.find((clone) =>
            catalog.listWorktrees(clone.id).some((worktree) => worktree.path === request.path)
          );
          if (!ownerClone) {
            return yield* new NotFoundError({ code: "WORKTREE_NOT_FOUND", message: "Worktree not found" });
          }
          if (ownerClone.path === request.path) {
            return yield* new ConflictError({
              code: "PRIMARY_CLONE",
              message: "Cannot archive the primary clone from the sidebar",
            });
          }

          if (listRepoEnvsForRepo(catalog, envManager, repo).some((env) => env.repoPath === request.path)) {
            return yield* new ConflictError({
              code: "WORKTREE_HAS_ENVS",
              message: "Remove environments for this worktree before archiving it.",
            });
          }

          const info = yield* Effect.try({
            try: () => inspectGitPath(request.path, repo.defaultBranch, false),
            catch: (error) => new InternalError({ code: "WORKTREE_INSPECTION_FAILED", message: toMessage(error) }),
          });
          if (!info.canArchive) {
            return yield* new ConflictError({
              code: "WORKTREE_NOT_ARCHIVABLE",
              message: "Only clean worktrees already merged into main can be archived.",
            });
          }

          yield* Effect.try({
            try: () => {
              removeGitWorktree(request.path);
              syncCloneWorktreesSync(catalog, ownerClone);
            },
            catch: (error) => new InternalError({ code: "WORKTREE_ARCHIVE_FAILED", message: toMessage(error) }),
          });
          publish({ type: "repo.updated", repoSlug: repoSlugValue });
        },
      );

      const suggestConfigEffect = Effect.fn("DaemonService.suggestConfig")(function*(request: ConfigSuggestRequest) {
        const repoPath = yield* normalizeRepoPath(request.repoPath);
        logDaemonMessage("suggest config", { repoPath });
        return yield* Effect.try({
          try: () => buildConfigSuggestions(repoPath),
          catch: (error) =>
            error instanceof BadRequestError
              ? error
              : new InternalError({ code: "CONFIG_SUGGEST_FAILED", message: toMessage(error) }),
        });
      });

      const testConfig = Effect.fn("DaemonService.testConfig")(function*(request: ConfigTestRequest) {
        const repoPath = yield* normalizeRepoPath(request.repoPath);
        logDaemonMessage("test config", { repoPath });
        return yield* Effect.try({
          try: () => runConfigTest(repoPath, request.content),
          catch: (error) =>
            error instanceof BadRequestError
              ? error
              : new InternalError({ code: "CONFIG_TEST_FAILED", message: toMessage(error) }),
        });
      });

      const startConfigPreview = Effect.fn("DaemonService.startConfigPreview")(
          function*(request: ConfigPreviewRequest) {
            const repoPath = yield* normalizeRepoPath(request.repoPath);
            const previewId = `preview-${Date.now()}`;
            const previewsDir = resolve(spawntreeHome(), "previews");
            const configPath = resolve(previewsDir, `${previewId}.yaml`);
            mkdirSync(previewsDir, { recursive: true });
            writeFileSync(configPath, request.content, "utf8");
            logDaemonMessage("start preview", { repoPath, previewId, serviceName: request.serviceName ?? "all" });

            const env = yield* Effect.tryPromise({
              try: () =>
                envManager.createEnv({
                  repoPath,
                  envId: previewId,
                  configFile: configPath,
                  skipHealthcheckWait: true,
                }),
              catch: mapCreateEnvError,
            }).pipe(
              Effect.tapError(() => Effect.sync(() => safeRemove(configPath))),
            );

            previewSessions.set(previewId, {
              previewId,
            repoId: env.repoId,
            envId: env.envId,
            repoPath: env.repoPath,
            configPath,
            env,
            });
            logDaemonMessage("preview ready", { previewId, envId: env.envId, repoId: env.repoId, repoPath: env.repoPath });
            return { ok: true, previewId, env };
          },
        );

      const stopConfigPreview = Effect.fn("DaemonService.stopConfigPreview")(
          function*(request: ConfigPreviewStopRequest) {
            const session = previewSessions.get(request.previewId);
            if (!session) {
              return yield* new NotFoundError({ code: "PREVIEW_NOT_FOUND", message: "Preview not found" });
            }
            logDaemonMessage("stop preview", { previewId: request.previewId, envId: session.envId });
            yield* Effect.tryPromise({
            try: () => envManager.deleteEnv(session.repoId, session.envId),
            catch: (error) => mapInternalError("STOP_PREVIEW_FAILED", error),
          });
          previewSessions.delete(request.previewId);
          safeRemove(session.configPath);
        },
      );

      const saveConfig = Effect.fn("DaemonService.saveConfig")(function*(request: ConfigSaveRequest) {
        const repoPath = yield* normalizeRepoPath(request.repoPath);
        logDaemonMessage("save config", { repoPath, saveMode: request.saveMode });
        const gitRoot = yield* Effect.try({
          try: () => validateGitRepo(repoPath),
          catch: (error) => new BadRequestError({ code: "NOT_A_GIT_REPO", message: toMessage(error) }),
        });
        const saveMode = request.saveMode || "repo";
        const configPath = saveMode === "global"
          ? resolve(
            spawntreeHome(),
            "configs",
            `${createHash("sha256").update(gitRoot).digest("hex").slice(0, 12)}.yaml`,
          )
          : resolve(
            yield* Effect.try({
              try: () => findWorktreeForBranch(gitRoot, defaultBranchName(repoPath)),
              catch: (error) => new ConflictError({ code: "DEFAULT_BRANCH_WORKTREE_NOT_FOUND", message: toMessage(error) }),
            }),
            "spawntree.yaml",
          );
        mkdirSync(resolve(configPath, ".."), { recursive: true });
        writeFileSync(configPath, request.content, "utf8");
        catalog.registerRepo({
          repoId: deriveRepoId(gitRoot),
          repoPath: gitRoot,
          configPath,
          lastSeenAt: new Date().toISOString(),
        });
        publish({ type: "repo.updated", repoId: deriveRepoId(gitRoot) });
        return { ok: true, configPath, saveMode };
      });

      return DaemonService.of({
        shutdown,
        daemonInfo,
        listEnvs,
        createEnv,
        getEnv,
        downEnv,
        deleteEnv,
        logs,
        events: domainEvents,
        registerRepo,
        infraStatus,
        stopInfra,
        dumpDb,
        restoreDb,
        listWebRepos,
        getWebRepoTree,
        getWebRepo,
        probeAddPath,
        addFolder,
        relinkClone,
        deleteClone,
        archiveWorktree,
        suggestConfig: suggestConfigEffect,
        testConfig,
        startConfigPreview,
        stopConfigPreview,
        saveConfig,
      });
    }),
  );
}

function listRepoEnvsForRepo(catalog: CatalogDatabase, envManager: EnvManager, repo: Repo) {
  const clones = catalog.listClones(repo.id);
  const paths = new Set<string>();
  for (const clone of clones) {
    paths.add(clone.path);
    for (const worktree of catalog.listWorktrees(clone.id)) {
      paths.add(worktree.path);
    }
  }
  return envManager.listEnvs("").filter((env) => paths.has(env.repoPath));
}

function buildGitPathInfoMap(
  repo: Repo,
  clones: Array<Clone>,
  worktreesByClone: Record<string, Array<Worktree>>,
  envs: Array<EnvInfo>,
) {
  const envCounts = new Map<string, number>();
  for (const env of envs) {
    envCounts.set(env.repoPath, (envCounts.get(env.repoPath) ?? 0) + 1);
  }

  const gitPaths: Record<string, GitPathInfo> = {};
  for (const clone of clones) {
    try {
      gitPaths[clone.path] = inspectGitPath(clone.path, repo.defaultBranch, (envCounts.get(clone.path) ?? 0) > 0);
    } catch {
      // ignore missing or invalid git paths
    }
    for (const worktree of worktreesByClone[clone.id] ?? []) {
      if (worktree.path === clone.path) {
        continue;
      }
      try {
        gitPaths[worktree.path] = inspectGitPath(
          worktree.path,
          repo.defaultBranch,
          (envCounts.get(worktree.path) ?? 0) > 0,
        );
      } catch {
        // ignore missing or invalid git paths
      }
    }
  }
  return gitPaths;
}

function enrichRepo(repo: Repo, catalog: CatalogDatabase, envManager: EnvManager): WebRepo {
  const clones = catalog.listClones(repo.id);
  const envs = listRepoEnvsForRepo(catalog, envManager, repo);
  let overallStatus: WebRepo["overallStatus"] = "offline";
  let activeEnvCount = 0;

  for (const env of envs) {
    const hasRunning = env.services.some((service: ServiceInfo) => service.status === "running");
    if (hasRunning) {
      activeEnvCount += 1;
      overallStatus = "running";
      continue;
    }
    if (env.services.some((service: ServiceInfo) => service.status === "failed") && overallStatus !== "running") {
      overallStatus = "crashed";
    } else if (
      env.services.some((service: ServiceInfo) => service.status === "starting")
      && overallStatus !== "running"
      && overallStatus !== "crashed"
    ) {
      overallStatus = "starting";
    } else if (overallStatus === "offline") {
      overallStatus = "stopped";
    }
  }

  return {
    slug: repo.slug,
    name: repo.name,
    remoteUrl: repo.remoteUrl || undefined,
    cloneCount: clones.length,
    activeEnvCount,
    overallStatus,
    updatedAt: repo.updatedAt,
  };
}

function repoSlugForRepoId(catalog: CatalogDatabase, repoId: string) {
  return catalog.getRepo(repoId)?.slug;
}

function mapCreateEnvError(error: unknown) {
  if (error instanceof BadRequestError || error instanceof InternalError) {
    return error;
  }
  if (error instanceof EnvManagerNotFoundError) {
    return new NotFoundError({ code: "ENV_NOT_FOUND", message: error.message });
  }
  return new BadRequestError({ code: "CREATE_ENV_FAILED", message: toMessage(error) });
}

function mapInternalError(code: string, error: unknown) {
  if (
    error instanceof InternalError || error instanceof BadRequestError || error instanceof ConflictError
    || error instanceof NotFoundError
  ) {
    return error;
  }
  return new InternalError({ code, message: toMessage(error) });
}

function mapStopInfraError(error: unknown) {
  if (error instanceof BadRequestError || error instanceof InternalError) {
    return error;
  }
  return new InternalError({ code: "STOP_INFRA_FAILED", message: toMessage(error) });
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function logDaemonMessage(message: string, details?: Record<string, unknown>) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`[spawntree-daemon] ${message}${suffix}\n`);
}

function safeRemove(path: string) {
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}

function sseStream(events: (signal: AbortSignal) => AsyncIterable<DomainEvent>) {
  const abortController = new AbortController();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const iterator = events(abortController.signal)[Symbol.asyncIterator]();

      try {
        while (!abortController.signal.aborted) {
          const result = await iterator.next();
          if (result.done) {
            break;
          }
          const event = result.value;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          controller.error(error);
          return;
        }
      } finally {
        await iterator.return?.();
      }

      if (!abortController.signal.aborted) {
        controller.close();
      }
    },
    cancel() {
      abortController.abort();
    },
  });
}

function syncCloneWorktreesSync(catalog: CatalogDatabase, clone: Clone) {
  if (!existsSync(clone.path)) {
    catalog.updateCloneStatus(clone.id, "missing");
    catalog.replaceWorktrees(clone.id, []);
    return;
  }
  catalog.updateCloneStatus(clone.id, "active");
  catalog.replaceWorktrees(clone.id, discoverWorktrees(clone.path, clone.id));
}

function syncCloneWorktrees(catalog: CatalogDatabase, clone: Clone) {
  return Effect.sync(() => {
    syncCloneWorktreesSync(catalog, clone);
  });
}

function syncWatchedPath(catalog: CatalogDatabase, watchedPath: WatchedPath) {
  return Effect.sync(() => {
    const probe = probePath(watchedPath.path);
    if (!probe.exists) {
      throw new Error("path not found");
    }

    let imported = 0;
    if (probe.isGitRepo) {
      importGitRepoPathSync(catalog, probe.path, undefined, false);
      imported += 1;
    }
    if (!probe.isGitRepo && watchedPath.scanChildren) {
      for (const repoPath of findImmediateGitRepos(watchedPath.path)) {
        importGitRepoPathSync(catalog, repoPath, undefined, false);
        imported += 1;
      }
    }
    catalog.updateWatchedPathScan(watchedPath.path, new Date().toISOString(), "");
    return imported;
  });
}

function importGitRepoPath(
  catalog: CatalogDatabase,
  gitRoot: string,
  remoteName: string | undefined,
  requireRemotePick: boolean,
) {
  return Effect.sync(() => importGitRepoPathSync(catalog, gitRoot, remoteName, requireRemotePick));
}

function importGitRepoPathSync(
  catalog: CatalogDatabase,
  gitRoot: string,
  remoteName: string | undefined,
  requireRemotePick: boolean,
) {
  const { info: detectedInfo, remotes } = detectRepoInfo(gitRoot);
  let info = detectedInfo;

  if (requireRemotePick && remotes.length > 1 && !remoteName) {
    throw new ConflictError({
      code: "REMOTE_PICK_REQUIRED",
      message: "Multiple remotes found",
      details: { remotes },
    });
  }

  if (remoteName) {
    const selected = remotes.find((remote) => remote.name === remoteName);
    if (!selected) {
      throw new BadRequestError({ code: "REMOTE_NOT_FOUND", message: `Remote "${remoteName}" not found` });
    }
    info = parseRemoteUrl(selected.url);
  }

  let repo: Repo = {
    id: canonicalRepoId(info),
    slug: repoSlug(info),
    name: info.repo,
    provider: info.provider,
    owner: info.owner,
    remoteUrl: info.url,
    defaultBranch: "",
    description: "",
    registeredAt: "",
    updatedAt: "",
  };

  if (info.provider === "github" && info.owner && info.repo) {
    const metadata = tryGhMetadata(info.owner, info.repo);
    repo = {
      ...repo,
      defaultBranch: metadata.defaultBranch,
      description: metadata.description,
    };
  }

  catalog.upsertRepo(repo);
  const clone: Clone = {
    id: deriveCloneId(gitRoot),
    repoId: repo.id,
    path: gitRoot,
    status: "active",
    lastSeenAt: "",
    registeredAt: "",
  };
  catalog.upsertClone(clone);
  syncCloneWorktreesSync(catalog, clone);

  return { repo, clone };
}

function resolveRepoEnv(
  catalog: CatalogDatabase,
  envManager: EnvManager,
  previewSessions: Map<string, PreviewSession>,
  repoRef: string,
  envId: string,
  repoPath?: string,
) {
  return Effect.sync(() => {
    try {
      const env = envManager.getEnv(repoRef, envId);
      if (!repoPath || env.repoPath === repoPath) {
        return { env, repoId: repoRef };
      }
    } catch {
      // fall through
    }

    const repo = catalog.getRepoBySlug(repoRef) ?? catalog.getRepo(repoRef);
    if (repo) {
      const envs = listRepoEnvsForRepo(catalog, envManager, repo);
      const found = envs.find((env) => env.envId === envId && (!repoPath || env.repoPath === repoPath));
      if (found) {
        return { env: found, repoId: found.repoId };
      }
    }

    for (const session of previewSessions.values()) {
      if (session.envId === envId && (!repoPath || session.repoPath === repoPath)) {
        return { env: session.env, repoId: session.repoId };
      }
    }

    throw new NotFoundError({ code: "ENV_NOT_FOUND", message: `Environment "${envId}" not found` });
  });
}

function getRepoBySlug(catalog: CatalogDatabase, slug: string) {
  return Effect.sync(() => {
    const repo = catalog.getRepoBySlug(slug);
    if (!repo) {
      throw new NotFoundError({ code: "REPO_NOT_FOUND", message: `Repo "${slug}" not found` });
    }
    return repo;
  });
}

function getClone(catalog: CatalogDatabase, cloneId: string) {
  return Effect.sync(() => {
    const clone = catalog.getClone(cloneId);
    if (!clone) {
      throw new NotFoundError({ code: "CLONE_NOT_FOUND", message: `Clone "${cloneId}" not found` });
    }
    return clone;
  });
}

function normalizeRepoPath(repoPath: string) {
  return Effect.try({
    try: () => normalizeInputPath(repoPath),
    catch: (error) => new BadRequestError({ code: "INVALID_REPO_PATH", message: toMessage(error) }),
  });
}

function runConfigTest(repoPath: string, content: string): ConfigTestResponse {
  const envVars = loadEnv({
    envName: "config-test",
    configDir: repoPath,
    cliOverrides: {},
  });
  const config = parseConfig(content, envVars);
  const validation = validateConfig(config);
  if ("errors" in validation) {
    throw new BadRequestError({
      code: "CONFIG_VALIDATION_FAILED",
      message: validation.errors.map((error: { path: string; message: string; }) => `${error.path}: ${error.message}`)
        .join("\n"),
    });
  }

  const missingHealthchecks = (Object.entries(validation.config.services) as Array<[string, ServiceConfig]>)
    .filter(([, service]) => ["process", "container", "external"].includes(service.type))
    .filter(([, service]) => !service.healthcheck?.url)
    .map(([name]) => name);

  if (missingHealthchecks.length > 0) {
    throw new BadRequestError({
      code: "MISSING_HEALTHCHECKS",
      message: `add healthchecks before testing or saving. missing: ${missingHealthchecks.join(", ")}`,
    });
  }

  const services = (Object.entries(validation.config.services) as Array<[string, ServiceConfig]>).map((
    [name, service],
  ) => ({
    name,
    type: service.type,
    status: "validated",
    url: service.type === "external" ? service.url : undefined,
    previewUrl: service.type === "external"
      ? service.url
      : service.port
      ? `http://127.0.0.1:${service.port}`
      : undefined,
    probeOk: false,
    logs: [],
  })) as Array<ConfigTestServiceResult>;

  return {
    ok: true,
    serviceNames: Object.keys(validation.config.services),
    services,
  };
}

function buildConfigSuggestions(repoPath: string): ConfigSuggestResponse {
  const signals: Array<ConfigSignal> = [];
  const services: Array<ConfigServiceSuggestion> = [];
  const packageJsonPath = resolve(repoPath, "package.json");

  if (existsSync(resolve(repoPath, "pnpm-lock.yaml"))) {
    signals.push({ kind: "package-manager", label: "pnpm", detail: "detected package manager" });
  } else if (existsSync(resolve(repoPath, "bun.lock")) || existsSync(resolve(repoPath, "bun.lockb"))) {
    signals.push({ kind: "package-manager", label: "bun", detail: "detected package manager" });
  } else if (existsSync(resolve(repoPath, "package-lock.json"))) {
    signals.push({ kind: "package-manager", label: "npm", detail: "detected package manager" });
  }

  for (const file of [".mise.toml", ".nvmrc", ".node-version", "pnpm-workspace.yaml", "turbo.json"]) {
    const fullPath = resolve(repoPath, file);
    if (existsSync(fullPath)) {
      signals.push({
        kind: file.includes("workspace") || file === "turbo.json" ? "workspace" : "toolchain",
        label: file,
        detail: "detected project signal",
      });
    }
  }

  if (existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
      packageManager?: string;
    };
    if (packageJson.packageManager) {
      const manager = packageJson.packageManager.split("@")[0] ?? packageJson.packageManager;
      signals.push({ kind: "package-manager", label: manager, detail: "declared in package.json" });
    }
    const scripts = packageJson.scripts ?? {};
    const primaryScript = scripts.dev ?? scripts.start ?? scripts.serve;
    if (primaryScript) {
      services.push({
        id: "app",
        name: "app",
        type: "process",
        command: primaryScript,
        port: inferPort(primaryScript) ?? 3000,
        healthcheckUrl: "http://localhost:${PORT}",
        selected: true,
        source: ".",
        reason: "derived from package.json scripts",
      });
    }
  }

  for (const composeFile of ["docker-compose.yml", "docker-compose.yaml"]) {
    const composePath = resolve(repoPath, composeFile);
    if (!existsSync(composePath)) {
      continue;
    }
    signals.push({ kind: "compose", label: composeFile, detail: "docker compose config" });
    const parsed = parseYaml(readFileSync(composePath, "utf8")) as {
      services?: Record<string, { image?: string; ports?: Array<string | number>; }>;
    };
    for (const [name, service] of Object.entries(parsed.services ?? {})) {
      services.push({
        id: `compose-${name}`,
        name,
        type: "container",
        image: service.image,
        port: inferComposePort(service.ports ?? []),
        healthcheckUrl: "http://localhost:${PORT}",
        selected: services.length === 0,
        source: composeFile,
        reason: "derived from compose service",
      });
    }
  }

  if (services.length === 0) {
    services.push({
      id: "starter-app",
      name: "app",
      type: "process",
      command: "npm run dev",
      port: 3000,
      healthcheckUrl: "http://localhost:${PORT}",
      selected: true,
      source: ".",
      reason: "starter config",
    });
  }

  return {
    signals,
    services,
  };
}

function inferPort(command: string) {
  for (
    const pattern of [
      /--port(?:=|\s+)(\d{2,5})/,
      /PORT=(\d{2,5})/,
      /-p\s*(\d{2,5})/,
    ]
  ) {
    const match = command.match(pattern);
    if (match?.[1]) {
      return Number.parseInt(match[1], 10);
    }
  }
  return undefined;
}

function inferComposePort(ports: Array<string | number>) {
  const first = ports[0];
  if (typeof first === "number") {
    return first;
  }
  if (typeof first === "string") {
    const parts = first.split(":");
    const last = parts[parts.length - 1];
    return Number.parseInt(last ?? "", 10) || undefined;
  }
  return undefined;
}
