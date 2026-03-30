import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseConfig,
  validateConfig,
  loadEnv,
  substituteVars,
  WorktreeManager,
} from "spawntree-core";
import type {
  SpawntreeConfig,
  ServiceConfig,
  Service,
  ServiceStatus,
  EnvInfo,
  ServiceInfo,
  CreateEnvRequest,
} from "spawntree-core";
import { ProcessRunner } from "../runners/process-runner.js";
import { PortRegistry } from "./port-registry.js";
import { LogStreamer } from "./log-streamer.js";
import { InfraManager } from "./infra-manager.js";
import {
  saveRepoState,
  loadRepoState,
  type RepoState,
  type RepoEnvRecord,
} from "../state/global-state.js";

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

/**
 * Generate a short random suffix.
 */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 7);
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

  constructor(portRegistry: PortRegistry, logStreamer: LogStreamer, infraManager: InfraManager) {
    this.portRegistry = portRegistry;
    this.logStreamer = logStreamer;
    this.infraManager = infraManager;
  }

  // ---------------------------------------------------------------------------
  // createEnv
  // ---------------------------------------------------------------------------

  async createEnv(req: CreateEnvRequest): Promise<EnvInfo> {
    const { repoPath, envOverrides = {}, configFile } = req;

    // Resolve config file path (absolute or relative to repoPath)
    const configPath = configFile && configFile.startsWith("/")
      ? configFile
      : resolve(repoPath, configFile || "spawntree.yaml");
    const configDir = resolve(configPath, "..");

    // Validate git repo
    const gitRoot = WorktreeManager.validateGitRepo(configDir);
    const branch = WorktreeManager.currentBranch(gitRoot);
    const repoId = repoIdFromPath(gitRoot);

    // Derive envId from branch name (sanitize slashes)
    const safeBranch = branch.replace(/\//g, "-");
    const envId = req.envId ?? (req.prefix ? `${safeBranch}-${req.prefix}` : safeBranch);
    const envKey = `${repoId}:${envId}`;

    // Check if already running
    const existingRepoEnvs = this.envs.get(repoId);
    if (existingRepoEnvs?.has(envId)) {
      return this.getEnv(repoId, envId);
    }

    console.log(`[spawntree-daemon] Creating env ${envId} for repo ${repoId} (${gitRoot})`);

    if (!existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }

    const envVars = loadEnv({
      envName: envId,
      configDir,
      cliOverrides: envOverrides,
    });

    const rawYaml = readFileSync(configPath, "utf-8");
    const parsedConfig = parseConfig(rawYaml, envVars);

    const validation = validateConfig(parsedConfig);
    if ("errors" in validation) {
      throw new Error(
        `Config validation failed:\n${validation.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`,
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

    const isDefaultBranchEnv = envId === safeBranch && !req.prefix;
    if (isDefaultBranchEnv) {
      // Run from the actual project directory (has node_modules, deps installed)
      worktreePath = gitRoot;
      serviceCwd = configDir;
    } else {
      const worktreeManager = new WorktreeManager(gitRoot);
      worktreeManager.ensureGitignore();
      worktreePath = worktreeManager.create(envId);
      const relativeConfigDir = configDir.startsWith(gitRoot)
        ? configDir.slice(gitRoot.length + 1)
        : "";
      serviceCwd = relativeConfigDir
        ? resolve(worktreePath, relativeConfigDir)
        : worktreePath;
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
    }

    // First pass: resolve infra env vars (postgres/redis URLs) so they are available
    // when building service env vars for process services
    const infraEnvVars: Record<string, string> = {};
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
            console.log(`[spawntree-daemon]   Forking database "${dbName}" from ${resolvedForkFrom}...`);
            await pgRunner.forkFrom(dbName, resolvedForkFrom);
          }

          infraEnvVars.DATABASE_URL = `postgresql://postgres@localhost:${pgRunner.port}/${dbName}`;
          infraEnvVars.DB_HOST = "127.0.0.1";
          infraEnvVars.DB_PORT = String(pgRunner.port);
          infraEnvVars.DB_NAME = dbName;
          console.log(`[spawntree-daemon]   Postgres db "${dbName}" ready at port ${pgRunner.port}`);
        } else {
          console.log(`[spawntree-daemon]   Skipping Docker Postgres — DATABASE_URL already set externally`);
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
          console.log(`[spawntree-daemon]   Redis db index ${dbIndex} ready at port ${redisRunner.port}`);
        } else {
          console.log(`[spawntree-daemon]   Skipping Docker Redis — REDIS_URL already set externally`);
        }
      }
    }

    for (const name of serviceOrder) {
      const serviceConfig = config.services[name];

      // Infra services (postgres, redis) are managed by InfraManager, not ProcessRunner
      if (serviceConfig.type === "postgres" || serviceConfig.type === "redis") {
        console.log(`[spawntree-daemon]   ${name} (${serviceConfig.type}) managed by infra layer — skipping process start`);
        continue;
      }

      const serviceIndex = serviceNames.indexOf(name);
      const port = this.portRegistry.getPhysicalPort(basePort, serviceIndex);

      const serviceEnvVars = this.buildServiceEnvVars(
        name,
        serviceConfig,
        { ...envVars, ...infraEnvVars },
        envId,
        serviceCwd,
        basePort,
        config,
        serviceNames,
      );

      const resolvedConfig = this.resolveServiceConfig(serviceConfig, serviceEnvVars);

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
      try {
        await service.start();

        if (service.healthcheck) {
          const timeout = serviceConfig.healthcheck?.timeout ?? 30;
          const healthy = await this.waitForHealthy(service, timeout * 1000);
          if (!healthy) {
            throw new Error(`Healthcheck failed for "${name}" after ${timeout}s`);
          }
        }

        console.log(`[spawntree-daemon]   ${name} started`);
      } catch (err) {
        // Stop already-started services before bubbling
        // (only process services are in the map)
        await this.stopServices(services, serviceOrder.slice(0, serviceOrder.indexOf(name)));
        // Free redis db indices
        for (const [svcName, dbIdx] of redisDbIndices.entries()) {
          try {
            const redisRunner = await this.infraManager.ensureRedis();
            await redisRunner.flushDb(dbIdx);
          } catch { /* best-effort cleanup */ }
          void svcName;
        }
        this.portRegistry.free(envKey);
        if (!isDefaultBranchEnv) {
          const wm = new WorktreeManager(gitRoot);
          wm.remove(envId);
        }
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

    await this.stopServices(managed.services, [...managed.serviceOrder].reverse());
    this.persistRepoState(repoId);
  }

  // ---------------------------------------------------------------------------
  // deleteEnv
  // ---------------------------------------------------------------------------

  async deleteEnv(repoId: string, envId: string): Promise<void> {
    const managed = this.getManaged(repoId, envId);
    const envKey = `${repoId}:${envId}`;

    console.log(`[spawntree-daemon] Deleting env ${envId}`);

    // Stop services
    await this.stopServices(managed.services, [...managed.serviceOrder].reverse());

    // Free Redis db indices (flush and de-allocate)
    if (managed.redisDbIndices.size > 0) {
      try {
        const redisRunner = await this.infraManager.ensureRedis();
        for (const [, dbIndex] of managed.redisDbIndices.entries()) {
          try {
            await redisRunner.flushDb(dbIndex);
          } catch (err) {
            console.error(
              `[spawntree-daemon] Failed to flush redis db ${dbIndex}: ${err instanceof Error ? err.message : err}`,
            );
          }
          redisRunner.freeDbIndex(envKey);
        }
      } catch (err) {
        console.error(
          `[spawntree-daemon] Failed to access redis for cleanup: ${err instanceof Error ? err.message : err}`,
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
          `[spawntree-daemon] Failed to drop postgres db "${dbName}": ${err instanceof Error ? err.message : err}`,
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
      ENV_NAME: envId,
      STATE_DIR: `${worktreePath}/.spawntree/state/${envId}`,
    };

    // Inject service discovery env vars for process services.
    // Postgres/Redis infra URLs are already in baseEnvVars (injected by the infra layer).
    for (const [otherName, otherConfig] of Object.entries(config.services)) {
      // Skip infra-managed services — their URLs come from baseEnvVars
      if (otherConfig.type === "postgres" || otherConfig.type === "redis") continue;

      const otherIndex = serviceNames.indexOf(otherName);
      const otherPort = this.portRegistry.getPhysicalPort(basePort, otherIndex);
      const upperName = otherName.toUpperCase().replace(/-/g, "_");

      vars[`${upperName}_HOST`] = "127.0.0.1";
      vars[`${upperName}_PORT`] = String(otherPort);
      vars[`${upperName}_URL`] = `http://127.0.0.1:${otherPort}`;
    }

    // Resolve per-service environment overrides using the now-computed vars
    const serviceConfig = config.services[name];
    const resolvedEnv: Record<string, string> | undefined = serviceConfig.environment
      ? Object.fromEntries(
          Object.entries(serviceConfig.environment).map(([k, v]) => [
            k,
            substituteVars(v, vars),
          ]),
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
    return {
      ...serviceConfig,
      command: serviceConfig.command
        ? substituteVars(serviceConfig.command, envVars)
        : serviceConfig.command,
      healthcheck: serviceConfig.healthcheck
        ? {
            ...serviceConfig.healthcheck,
            url: substituteVars(serviceConfig.healthcheck.url, envVars),
          }
        : serviceConfig.healthcheck,
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
      case "container":
        throw new Error(
          `Service type "container" is not yet supported. Use type: "process" for custom processes, ` +
            `or type: "postgres" / "redis" for managed infra services.`,
        );
      case "postgres":
      case "redis":
        // These are managed by InfraManager and should never reach createService()
        throw new Error(
          `Internal error: infra service "${config.type}" should not reach createService().`,
        );
      default:
        throw new Error(`Unknown service type: ${(config as ServiceConfig).type}`);
    }
  }

  private async stopServices(
    services: Map<string, Service>,
    order: string[],
  ): Promise<void> {
    for (const name of order) {
      const service = services.get(name);
      if (service && service.status() !== "stopped") {
        console.log(`[spawntree-daemon]   Stopping ${name}...`);
        try {
          await service.stop();
        } catch (err) {
          console.error(
            `[spawntree-daemon]   Failed to stop ${name}: ${err instanceof Error ? err.message : err}`,
          );
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
      const pid =
        service instanceof ProcessRunner ? service.pid : undefined;

      const info: ServiceInfo = {
        name,
        type: serviceConfig.type,
        status,
        port,
        url: `http://127.0.0.1:${port}`,
      };
      if (pid !== undefined) info.pid = pid;
      return info;
    });

    return {
      envId: managed.envId,
      repoId: managed.repoId,
      repoPath: managed.repoPath,
      branch: managed.branch,
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
            const pid =
              service instanceof ProcessRunner ? service.pid : undefined;
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
        ? [...repoEnvs.values()][0]?.repoPath ?? ""
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
