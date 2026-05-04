import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadEnv,
  localConfigPathForRepo,
  findVarRefs,
  parseConfig,
  substituteVars,
  validateConfig,
  WorktreeManager,
} from "spawntree-core";
import type {
  CreateEnvRequest,
  EnvInfo,
  Service,
  ServiceConfig,
  ServiceInfo,
  ServiceStatus,
  SpawntreeConfig,
} from "spawntree-core";
import { DockerRunner } from "../runners/docker-runner.ts";
import { ExternalRunner } from "../runners/external-runner.ts";
import { ProcessRunner } from "../runners/process-runner.ts";
import {
  loadRepoState,
  type RepoEnvRecord,
  type RepoState,
  saveRepoState,
} from "../state/global-state.ts";
import { InfraManager } from "./infra-manager.ts";
import { LogStreamer } from "./log-streamer.ts";
import { PortRegistry } from "./port-registry.ts";
import { ProxyManager } from "./proxy-manager.ts";

export interface ManagedEnv {
  envId: string;
  repoId: string;
  repoPath: string;
  branch: string;
  basePort: number;
  createdAt: string;
  config: SpawntreeConfig;
  services: Map<string, Service>;
  serviceOrder: string[];
  worktreePath: string;
  profile: string;
  worktreeStrategy: "current" | "isolated";
  /** Redis db indices allocated for this env, keyed by service name */
  redisDbIndices: Map<string, number>;
  /** Postgres databases created for this env, keyed by service name */
  postgresDatabases: Map<string, string>;
}

/**
 * Derive a stable repo ID from an absolute repo path.
 */
function repoIdFromPath(repoPath: string): string {
  const parts = repoPath.split("/");
  for (let i = parts.length - 1; i >= 0; i--) {
    const segment = parts[i];
    if (segment && segment.length > 0) {
      return segment.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    }
  }
  return "unknown";
}

function resolveConfigPath(repoPath: string, configFile?: string): string {
  if (configFile) {
    return configFile.startsWith("/") ? configFile : resolve(repoPath, configFile);
  }
  const repoConfig = resolve(repoPath, "spawntree.yaml");
  if (existsSync(repoConfig)) return repoConfig;
  const localConfig = localConfigPathForRepo(repoPath);
  if (existsSync(localConfig)) return localConfig;
  return repoConfig;
}

function safeSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-|-$/g, "") || "env"
  );
}

function detachedEnvId(repoPath: string): string {
  const name = repoPath.split("/").filter(Boolean).at(-1) ?? "worktree";
  return `${safeSlug(name)}-${WorktreeManager.currentHead(repoPath)}`;
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serviceIsActive(status: ServiceStatus): boolean {
  return status === "running" || status === "starting";
}

function defaultHealthcheckFor(
  serviceConfig: ServiceConfig,
  envVars: Record<string, string>,
  resolvedUrl?: string,
): ServiceConfig["healthcheck"] {
  if (serviceConfig.type === "external" && resolvedUrl) {
    return { url: resolvedUrl, timeout: 30 };
  }

  if (
    (serviceConfig.type === "process" || serviceConfig.type === "container") &&
    serviceConfig.port &&
    envVars.PORT
  ) {
    return { url: `tcp://127.0.0.1:${envVars.PORT}`, timeout: 30 };
  }

  return undefined;
}

function assertNoUnresolvedServiceVars(name: string, config: ServiceConfig): void {
  const refs = new Set<string>();
  collectRefs(config.command, refs);
  collectRefs(config.url, refs);
  collectRefs(config.fork_from, refs);
  collectRefs(config.healthcheck?.url, refs);
  for (const value of Object.values(config.environment ?? {})) {
    collectRefs(value, refs);
  }

  if (refs.size > 0) {
    throw new Error(
      `Service "${name}" has unresolved config variable(s): ${[...refs].sort().join(", ")}. Define them in .env, shell env, profile environment, or --env KEY=VALUE.`,
    );
  }
}

function collectRefs(value: string | undefined, refs: Set<string>): void {
  if (!value) return;
  for (const ref of findVarRefs(value)) {
    refs.add(ref);
  }
}

/**
 * Topological sort of services by depends_on.
 * Returns service names in start order (dependencies first).
 */
function topologicalSort(config: SpawntreeConfig): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (name: string) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Circular dependency detected involving "${name}"`);
    }

    visiting.add(name);

    const deps = config.services[name]?.depends_on ?? [];
    for (const dep of deps) {
      visit(dep);
    }

    visiting.delete(name);
    visited.add(name);
    result.push(name);
  };

  for (const name of Object.keys(config.services)) {
    visit(name);
  }

  return result;
}

/**
 * Manages the lifecycle of all environments across all repos.
 * Single source of truth for running envs.
 */
export class EnvManager {
  /** repoId → envId → ManagedEnv */
  private envs: Map<string, Map<string, ManagedEnv>> = new Map();
  private readonly portRegistry: PortRegistry;
  private readonly logStreamer: LogStreamer;
  private readonly infraManager: InfraManager;
  private readonly proxyManager: ProxyManager;

  constructor(
    portRegistry: PortRegistry,
    logStreamer: LogStreamer,
    infraManager: InfraManager,
    proxyManager: ProxyManager,
  ) {
    this.portRegistry = portRegistry;
    this.logStreamer = logStreamer;
    this.infraManager = infraManager;
    this.proxyManager = proxyManager;
  }

  // ---------------------------------------------------------------------------
  // createEnv
  // ---------------------------------------------------------------------------

  async createEnv(req: CreateEnvRequest): Promise<EnvInfo> {
    const { repoPath, envOverrides = {}, configFile } = req;
    const requestedRepoPath = resolve(repoPath);

    // Resolve config file path (absolute, repo-relative, or per-user fallback)
    const configPath = resolveConfigPath(requestedRepoPath, configFile);
    const configDir = resolve(configPath, "..");

    // Validate git repo
    const gitRoot = WorktreeManager.validateGitRepo(requestedRepoPath);
    const branch = WorktreeManager.currentBranch(gitRoot);
    const repoId = repoIdFromPath(gitRoot);
    const baseServiceDir = configDir.startsWith(gitRoot) ? configDir : requestedRepoPath;

    const profile = req.profile || "default";
    if (branch === "detached" && !req.envId && !req.prefix) {
      throw new Error(
        "Detached HEAD detected. Create or switch to a branch before running SpawnTree, or pass an explicit envId for advanced detached-commit runs.",
      );
    }
    const safeBranch = branch === "detached" ? detachedEnvId(gitRoot) : safeSlug(branch);
    const profileSuffix = profile === "default" ? "" : `-${safeSlug(profile)}`;
    const envId =
      req.envId ?? (req.prefix ? `${safeBranch}-${req.prefix}` : `${safeBranch}${profileSuffix}`);
    const envKey = `${repoId}:${envId}`;

    // Check if already running
    const existingRepoEnvs = this.envs.get(repoId);
    if (existingRepoEnvs?.has(envId)) {
      const existing = this.getManaged(repoId, envId);
      const hasActiveService = [...existing.services.values()].some((service) =>
        serviceIsActive(service.status()),
      );
      if (hasActiveService) {
        return this.getEnv(repoId, envId);
      }

      console.log(`[spawntree-daemon] Recreating stopped env ${envId} for repo ${repoId}`);
      await this.deleteEnv(repoId, envId);
    }

    console.log(`[spawntree-daemon] Creating env ${envId} for repo ${repoId} (${gitRoot})`);

    if (!existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }

    const envVars = loadEnv({
      envName: envId,
      configDir: baseServiceDir,
      cliOverrides: envOverrides,
    });

    const rawYaml = readFileSync(configPath, "utf-8");
    const parsedConfig = parseConfig(rawYaml, envVars, { profile });

    const validation = validateConfig(parsedConfig);
    if ("errors" in validation) {
      throw new Error(
        `Config validation failed:\n${validation.errors
          .map((error: { path: string; message: string }) => `  ${error.path}: ${error.message}`)
          .join("\n")}`,
      );
    }

    const config = validation.config;

    // Allocate ports
    const basePort = this.portRegistry.allocate(envKey);

    // Determine service working directory:
    // - For the default branch env (no prefix), run from the project root directly.
    //   Worktrees don't have node_modules, build artifacts, etc.
    // - For prefixed/additional envs, create a worktree for source isolation.
    let serviceCwd: string;
    let worktreePath: string;

    const requestedStrategy = req.worktreeStrategy ?? (req.prefix ? "isolated" : "current");
    const worktreeStrategy =
      requestedStrategy === "auto" ? (req.prefix ? "isolated" : "current") : requestedStrategy;
    if (worktreeStrategy === "current") {
      // Run from the actual project directory (has node_modules, deps installed)
      worktreePath = gitRoot;
      serviceCwd = baseServiceDir;
    } else {
      const worktreeManager = new WorktreeManager(gitRoot);
      worktreeManager.ensureGitignore();
      worktreePath = worktreeManager.create(envId);
      const relativeConfigDir = baseServiceDir.startsWith(gitRoot)
        ? baseServiceDir.slice(gitRoot.length + 1)
        : "";
      serviceCwd = relativeConfigDir ? resolve(worktreePath, relativeConfigDir) : worktreePath;
    }

    // Start services in dependency order
    const serviceOrder = topologicalSort(config);
    const serviceNames = Object.keys(config.services);
    const services = new Map<string, Service>();
    const redisDbIndices = new Map<string, number>();
    const postgresDatabases = new Map<string, string>();

    // Register log buffers for all services
    for (const name of serviceNames) {
      this.logStreamer.initService(repoId, envId, name);
      this.logStreamer.addLine(repoId, envId, name, "system", "[spawntree] Service registered");
    }

    // First pass: resolve infra env vars (postgres/redis URLs) so they are available
    // when building service env vars for process services
    const infraEnvVars: Record<string, string> = {};
    let firstPostgresService = true;
    for (const name of serviceNames) {
      const serviceConfig = config.services[name];
      if (serviceConfig.type === "postgres") {
        // Skip if DATABASE_URL already provided externally
        if (!envVars.DATABASE_URL) {
          const pgVersion = (serviceConfig as ServiceConfig & { version?: string }).version ?? "17";
          const pgRunner = await this.infraManager.ensurePostgres(pgVersion);
          const dbName = `spawntree_${repoId}_${envId}_${name}`
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, "_")
            .slice(0, 63);
          await pgRunner.createDatabase(dbName);
          postgresDatabases.set(name, dbName);

          // Fork from source if configured
          const resolvedForkFrom = serviceConfig.fork_from
            ? substituteVars(serviceConfig.fork_from, { ...envVars, ...infraEnvVars })
            : undefined;
          if (resolvedForkFrom) {
            console.log(
              `[spawntree-daemon]   Forking database "${dbName}" from ${resolvedForkFrom}...`,
            );
            await pgRunner.forkFrom(dbName, resolvedForkFrom);
          }

          const pgUrl = `postgresql://postgres@localhost:${pgRunner.port}/${dbName}`;
          const upperName = name.toUpperCase().replace(/-/g, "_");

          // Only set generic DATABASE_URL for the first postgres service encountered
          if (firstPostgresService) {
            infraEnvVars.DATABASE_URL = pgUrl;
            infraEnvVars.DB_HOST = "127.0.0.1";
            infraEnvVars.DB_PORT = String(pgRunner.port);
            infraEnvVars.DB_NAME = dbName;
            firstPostgresService = false;
          }

          // Always set per-service-name env vars
          infraEnvVars[`${upperName}_DATABASE_URL`] = pgUrl;
          infraEnvVars[`${upperName}_HOST`] = "127.0.0.1";
          infraEnvVars[`${upperName}_PORT`] = String(pgRunner.port);
          infraEnvVars[`${upperName}_NAME`] = dbName;

          console.log(
            `[spawntree-daemon]   Postgres db "${dbName}" ready at port ${pgRunner.port}`,
          );
        } else {
          console.log(
            `[spawntree-daemon]   Skipping Docker Postgres — DATABASE_URL already set externally`,
          );
        }
      } else if (serviceConfig.type === "redis") {
        // Skip if REDIS_URL already provided externally
        if (!envVars.REDIS_URL) {
          const redisRunner = await this.infraManager.ensureRedis();
          const dbIndex = redisRunner.allocateDbIndex(envKey);
          redisDbIndices.set(name, dbIndex);

          infraEnvVars.REDIS_URL = `redis://localhost:${redisRunner.port}/${dbIndex}`;
          infraEnvVars.REDIS_HOST = "127.0.0.1";
          infraEnvVars.REDIS_PORT = String(redisRunner.port);
          infraEnvVars.REDIS_DB = String(dbIndex);
          console.log(
            `[spawntree-daemon]   Redis db index ${dbIndex} ready at port ${redisRunner.port}`,
          );
        } else {
          console.log(
            `[spawntree-daemon]   Skipping Docker Redis — REDIS_URL already set externally`,
          );
        }
      }
    }

    for (const name of serviceOrder) {
      const serviceConfig = config.services[name];

      // Infra services are managed by InfraManager, not by process/external runners
      if (serviceConfig.type === "postgres" || serviceConfig.type === "redis") {
        console.log(
          `[spawntree-daemon]   ${name} (${serviceConfig.type}) managed by infra layer — skipping process start`,
        );
        continue;
      }

      const serviceIndex = serviceNames.indexOf(name);
      const port = this.portRegistry.getPhysicalPort(basePort, serviceIndex);

      const baseServiceEnvVars = {
        ...envVars,
        ...infraEnvVars,
      };
      Object.assign(baseServiceEnvVars, config.environment);

      const serviceEnvVars = this.buildServiceEnvVars(
        name,
        serviceConfig,
        baseServiceEnvVars,
        envId,
        serviceCwd,
        basePort,
        config,
        serviceNames,
      );

      try {
        const resolvedConfig = this.resolveServiceConfig(serviceConfig, serviceEnvVars);
        assertNoUnresolvedServiceVars(name, resolvedConfig);

        const service = this.createService(
          name,
          resolvedConfig,
          serviceEnvVars,
          serviceCwd,
          repoId,
          envId,
        );
        services.set(name, service);

        console.log(`[spawntree-daemon]   Starting ${name} on port ${port}...`);
        this.logStreamer.addLine(
          repoId,
          envId,
          name,
          "system",
          `[spawntree] Starting ${name} on port ${port}`,
        );

        await service.start();

        if (service.healthcheck && !req.skipHealthcheckWait) {
          const timeout = resolvedConfig.healthcheck?.timeout ?? 30;
          this.logStreamer.addLine(
            repoId,
            envId,
            name,
            "system",
            `[spawntree] Waiting for healthcheck (${timeout}s timeout)`,
          );
          const healthy = await this.waitForHealthy(service, timeout * 1000);
          if (!healthy) {
            throw new Error(`Healthcheck failed for "${name}" after ${timeout}s`);
          }
          this.logStreamer.addLine(repoId, envId, name, "system", "[spawntree] Healthcheck passed");
        } else if (service.healthcheck && req.skipHealthcheckWait) {
          this.logStreamer.addLine(
            repoId,
            envId,
            name,
            "system",
            "[spawntree] Preview mode: skipping healthcheck wait",
          );
        }

        // Register with reverse proxy for clean URLs
        try {
          const proxyReady = await this.proxyManager.ensureRunning();
          if (proxyReady) {
            const cleanUrl = this.proxyManager.register(envId, name, port);
            console.log(`[spawntree-daemon]   ${name} started → ${cleanUrl}`);
            this.logStreamer.addLine(
              repoId,
              envId,
              name,
              "system",
              `[spawntree] ${name} started → ${cleanUrl}`,
            );
          } else {
            console.log(
              `[spawntree-daemon]   ${name} started → http://127.0.0.1:${port} (proxy unavailable)`,
            );
            this.logStreamer.addLine(
              repoId,
              envId,
              name,
              "system",
              `[spawntree] ${name} started → http://127.0.0.1:${port} (proxy unavailable)`,
            );
          }
        } catch {
          console.log(`[spawntree-daemon]   ${name} started (port ${port}, proxy unavailable)`);
          this.logStreamer.addLine(
            repoId,
            envId,
            name,
            "system",
            `[spawntree] ${name} started (port ${port}, proxy unavailable)`,
          );
        }
      } catch (err) {
        this.logStreamer.addLine(
          repoId,
          envId,
          name,
          "system",
          `[spawntree] Failed to start ${name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Stop already-started services before bubbling
        // (only process services are in the map)
        await this.stopServices(services, serviceOrder.slice(0, serviceOrder.indexOf(name)));
        // Free redis db indices
        for (const [svcName, dbIdx] of redisDbIndices.entries()) {
          try {
            const redisRunner = await this.infraManager.ensureRedis();
            await redisRunner.flushDb(dbIdx);
          } catch {
            /* best-effort cleanup */
          }
          void svcName;
        }
        this.portRegistry.free(envKey);
        if (worktreeStrategy === "isolated") {
          const wm = new WorktreeManager(gitRoot);
          wm.remove(envId);
        }
        this.logStreamer.closeEnv(repoId, envId);
        throw err;
      }
    }

    const managed: ManagedEnv = {
      envId,
      repoId,
      repoPath: gitRoot,
      branch,
      basePort,
      createdAt: new Date().toISOString(),
      config,
      services,
      serviceOrder,
      worktreePath,
      profile,
      worktreeStrategy,
      redisDbIndices,
      postgresDatabases,
    };

    // Store in-memory
    if (!this.envs.has(repoId)) {
      this.envs.set(repoId, new Map());
    }
    this.envs.get(repoId)!.set(envId, managed);

    // Persist to disk
    this.persistRepoState(repoId);

    return this.toEnvInfo(managed);
  }

  // ---------------------------------------------------------------------------
  // downEnv
  // ---------------------------------------------------------------------------

  async downEnv(repoId: string, envId: string): Promise<void> {
    const managed = this.getManaged(repoId, envId);
    console.log(`[spawntree-daemon] Stopping env ${envId} (keeping state)`);

    await this.stopServices(managed.services, managed.serviceOrder.toReversed());
    this.proxyManager.unregisterAll(envId);
    this.persistRepoState(repoId);
  }

  // ---------------------------------------------------------------------------
  // deleteEnv
  // ---------------------------------------------------------------------------

  async deleteEnv(repoId: string, envId: string): Promise<void> {
    const managed = this.getManaged(repoId, envId);
    const envKey = `${repoId}:${envId}`;

    console.log(`[spawntree-daemon] Deleting env ${envId}`);

    // Stop services and unregister proxy routes
    await this.stopServices(managed.services, managed.serviceOrder.toReversed());
    this.proxyManager.unregisterAll(envId);

    // Free Redis db indices (flush and de-allocate)
    if (managed.redisDbIndices.size > 0) {
      try {
        const redisRunner = await this.infraManager.ensureRedis();
        for (const [, dbIndex] of managed.redisDbIndices.entries()) {
          try {
            await redisRunner.flushDb(dbIndex);
          } catch (err) {
            console.error(
              `[spawntree-daemon] Failed to flush redis db ${dbIndex}: ${formatUnknownError(err)}`,
            );
          }
          redisRunner.freeDbIndex(envKey);
        }
      } catch (err) {
        console.error(
          `[spawntree-daemon] Failed to access redis for cleanup: ${formatUnknownError(err)}`,
        );
      }
    }

    // Drop Postgres databases
    for (const [svcName, dbName] of managed.postgresDatabases.entries()) {
      const serviceConfig = managed.config.services[svcName];
      const pgVersion = (serviceConfig as ServiceConfig & { version?: string }).version ?? "17";
      try {
        const pgRunner = await this.infraManager.ensurePostgres(pgVersion);
        await pgRunner.dropDatabase(dbName);
      } catch (err) {
        console.error(
          `[spawntree-daemon] Failed to drop postgres db "${dbName}": ${formatUnknownError(err)}`,
        );
      }
    }

    // Close log streams
    this.logStreamer.closeEnv(repoId, envId);

    // Remove worktree
    const worktreeManager = new WorktreeManager(managed.repoPath);
    worktreeManager.remove(envId);

    // Free ports
    this.portRegistry.free(envKey);

    // Remove from memory
    this.envs.get(repoId)?.delete(envId);
    if (this.envs.get(repoId)?.size === 0) {
      this.envs.delete(repoId);
    }

    this.persistRepoState(repoId);
  }

  // ---------------------------------------------------------------------------
  // getEnv / listEnvs
  // ---------------------------------------------------------------------------

  getEnv(repoId: string, envId: string): EnvInfo {
    return this.toEnvInfo(this.getManaged(repoId, envId));
  }

  listEnvs(repoId?: string): EnvInfo[] {
    const result: EnvInfo[] = [];

    if (repoId) {
      const repoEnvs = this.envs.get(repoId);
      if (repoEnvs) {
        for (const managed of repoEnvs.values()) {
          result.push(this.toEnvInfo(managed));
        }
      }
    } else {
      for (const repoEnvs of this.envs.values()) {
        for (const managed of repoEnvs.values()) {
          result.push(this.toEnvInfo(managed));
        }
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getManaged(repoId: string, envId: string): ManagedEnv {
    const managed = this.envs.get(repoId)?.get(envId);
    if (!managed) {
      throw new NotFoundError(`Environment "${envId}" not found for repo "${repoId}"`);
    }
    return managed;
  }

  private buildServiceEnvVars(
    name: string,
    _serviceConfig: ServiceConfig,
    baseEnvVars: Record<string, string>,
    envId: string,
    worktreePath: string,
    basePort: number,
    config: SpawntreeConfig,
    serviceNames: string[],
  ): Record<string, string> {
    const serviceIndex = serviceNames.indexOf(name);
    const port = this.portRegistry.getPhysicalPort(basePort, serviceIndex);

    const vars: Record<string, string> = {
      ...baseEnvVars,
      PORT: String(port),
      HOST: "127.0.0.1",
      ENV_NAME: envId,
      STATE_DIR: `${worktreePath}/.spawntree/state/${envId}`,
      // Disable portless if it's embedded in service dev scripts.
      // spawntree owns port allocation and proxy — portless would conflict.
      PORTLESS: "0",
    };

    // Inject service discovery env vars for process services.
    // Postgres/Redis infra URLs are already in baseEnvVars (injected by the infra layer).
    for (const [otherName, otherConfig] of Object.entries(config.services) as Array<
      [string, ServiceConfig]
    >) {
      // Skip infra-managed services — their URLs come from baseEnvVars
      if (otherConfig.type === "postgres" || otherConfig.type === "redis") continue;

      const otherIndex = serviceNames.indexOf(otherName);
      const otherPort = this.portRegistry.getPhysicalPort(basePort, otherIndex);
      const upperName = otherName.toUpperCase().replace(/-/g, "_");

      vars[`${upperName}_HOST`] = "127.0.0.1";
      vars[`${upperName}_PORT`] = String(otherPort);
      // Use proxy URL if proxy is running, otherwise fall back to raw port
      const proxyUrl = `http://${otherName}-${envId}.localhost:${this.proxyManager.proxyPort}`;
      vars[`${upperName}_URL`] = this.proxyManager.isRunning
        ? proxyUrl
        : `http://127.0.0.1:${otherPort}`;
    }

    // Resolve per-service environment overrides using the now-computed vars
    const serviceConfig = config.services[name];
    const resolvedEnv: Record<string, string> | undefined = serviceConfig.environment
      ? Object.fromEntries(
          Object.entries(serviceConfig.environment).map(([k, v]) => [k, substituteVars(v, vars)]),
        )
      : undefined;

    if (resolvedEnv) {
      Object.assign(vars, resolvedEnv);
    }

    return vars;
  }

  private resolveServiceConfig(
    serviceConfig: ServiceConfig,
    envVars: Record<string, string>,
  ): ServiceConfig {
    const resolvedUrl = serviceConfig.url ? substituteVars(serviceConfig.url, envVars) : undefined;
    const resolvedHealthcheck = serviceConfig.healthcheck
      ? {
          ...serviceConfig.healthcheck,
          url: substituteVars(serviceConfig.healthcheck.url, envVars),
        }
      : defaultHealthcheckFor(serviceConfig, envVars, resolvedUrl);

    return {
      ...serviceConfig,
      url: resolvedUrl ?? serviceConfig.url,
      command: serviceConfig.command
        ? substituteVars(serviceConfig.command, envVars)
        : serviceConfig.command,
      healthcheck: resolvedHealthcheck,
      environment: serviceConfig.environment
        ? Object.fromEntries(
            Object.entries(serviceConfig.environment).map(([key, value]) => [
              key,
              substituteVars(value, envVars),
            ]),
          )
        : serviceConfig.environment,
      fork_from: serviceConfig.fork_from
        ? substituteVars(serviceConfig.fork_from, envVars)
        : serviceConfig.fork_from,
    };
  }

  private createService(
    name: string,
    config: ServiceConfig,
    envVars: Record<string, string>,
    cwd: string,
    repoId: string,
    envId: string,
  ): Service {
    switch (config.type) {
      case "process":
        return new ProcessRunner({
          name,
          config,
          envVars,
          cwd,
          repoId,
          envId,
          logStreamer: this.logStreamer,
        });
      case "external":
        return new ExternalRunner({
          name,
          config,
          allocatedPort: parseInt(envVars.PORT || "0", 10),
        });
      case "container":
        return new DockerRunner({
          name,
          config,
          envVars,
          allocatedPort: parseInt(envVars.PORT || "0", 10),
          repoId,
          envId,
          logStreamer: this.logStreamer,
        });
      case "postgres":
      case "redis":
        throw new Error(
          `Internal error: infra service "${config.type}" should not reach createService().`,
        );
      default:
        throw new Error(`Unknown service type: ${(config as ServiceConfig).type}`);
    }
  }

  private async stopServices(services: Map<string, Service>, order: string[]): Promise<void> {
    for (const name of order) {
      const service = services.get(name);
      if (service && service.status() !== "stopped") {
        console.log(`[spawntree-daemon]   Stopping ${name}...`);
        try {
          await service.stop();
        } catch (err) {
          console.error(`[spawntree-daemon]   Failed to stop ${name}: ${formatUnknownError(err)}`);
        }
      }
    }
  }

  private async waitForHealthy(service: Service, timeoutMs: number): Promise<boolean> {
    if (!service.healthcheck) return true;

    const start = Date.now();
    const interval = 1000;

    while (Date.now() - start < timeoutMs) {
      try {
        if (await service.healthcheck()) return true;
      } catch {
        // ignore, retry
      }
      await new Promise((r) => setTimeout(r, interval));
    }

    return false;
  }

  private toEnvInfo(managed: ManagedEnv): EnvInfo {
    const serviceNames = Object.keys(managed.config.services);
    const services: ServiceInfo[] = serviceNames.map((name, index) => {
      const service = managed.services.get(name);
      const serviceConfig = managed.config.services[name];
      const port = this.portRegistry.getPhysicalPort(managed.basePort, index);
      const status: ServiceStatus = service ? service.status() : "stopped";
      const pid = service instanceof ProcessRunner ? service.pid : undefined;

      // Use proxy URL for non-infra, non-external services
      const isInfra = serviceConfig.type === "postgres" || serviceConfig.type === "redis";
      const isExternal = serviceConfig.type === "external";
      const proxyUrl =
        isInfra || !this.proxyManager.isRunning
          ? undefined
          : `http://${name}-${managed.envId}.localhost:${this.proxyManager.proxyPort}`;
      // External services show their upstream URL
      const externalUrl = isExternal ? serviceConfig.url : undefined;
      const url = externalUrl || proxyUrl || `http://127.0.0.1:${port}`;
      const routes = isExternal
        ? [
            {
              url,
              hostname: hostnameFromUrl(url),
              targetPort: port,
              kind: "external" as const,
            },
          ]
        : [
            ...(proxyUrl
              ? [
                  {
                    url: proxyUrl,
                    hostname: `${name}-${managed.envId}.localhost`,
                    targetPort: port,
                    kind: "proxy" as const,
                  },
                ]
              : []),
            {
              url: `http://127.0.0.1:${port}`,
              hostname: "127.0.0.1",
              targetPort: port,
              kind: "direct" as const,
            },
          ];

      const info: ServiceInfo =
        pid !== undefined
          ? {
              name,
              type: serviceConfig.type,
              status,
              port,
              pid,
              url,
              routes,
            }
          : {
              name,
              type: serviceConfig.type,
              status,
              port,
              url,
              routes,
            };
      return info;
    });

    return {
      envId: managed.envId,
      repoId: managed.repoId,
      repoPath: managed.repoPath,
      branch: managed.branch,
      profile: managed.profile,
      worktreePath: managed.worktreePath,
      basePort: managed.basePort,
      createdAt: managed.createdAt,
      services,
    };
  }

  private persistRepoState(repoId: string): void {
    const repoEnvs = this.envs.get(repoId);
    const envRecords: RepoEnvRecord[] = [];

    if (repoEnvs) {
      for (const managed of repoEnvs.values()) {
        const serviceNames = Object.keys(managed.config.services);
        envRecords.push({
          envId: managed.envId,
          repoId: managed.repoId,
          repoPath: managed.repoPath,
          branch: managed.branch,
          basePort: managed.basePort,
          createdAt: managed.createdAt,
          services: serviceNames.map((name, index) => {
            const service = managed.services.get(name);
            const serviceConfig = managed.config.services[name];
            const port = this.portRegistry.getPhysicalPort(managed.basePort, index);
            const pid = service instanceof ProcessRunner ? service.pid : undefined;
            const record: RepoEnvRecord["services"][number] = {
              name,
              type: serviceConfig.type,
              port,
            };
            if (pid !== undefined) record.pid = pid;
            return record;
          }),
        });
      }
    }

    const state: RepoState = {
      repoId,
      repoPath: repoEnvs
        ? ([...repoEnvs.values()][0]?.repoPath ?? "")
        : (loadRepoState(repoId)?.repoPath ?? ""),
      envs: envRecords,
    };

    saveRepoState(repoId, state);
  }
}

// ---------------------------------------------------------------------------
// NotFoundError
// ---------------------------------------------------------------------------

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
