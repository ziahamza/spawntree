import type { Service, ServiceStatus } from "./services/interface.js";
import type { SpawntreeConfig, ServiceConfig } from "./config/parser.js";
import { ProcessRunner } from "./services/process.js";
import { PortAllocator } from "./env/ports.js";

export interface OrchestratorOptions {
  config: SpawntreeConfig;
  envName: string;
  envVars: Record<string, string>;
  cwd: string;
  logDir: string;
  basePort: number;
}

export class Orchestrator {
  private services: Map<string, Service> = new Map();
  private readonly config: SpawntreeConfig;
  private readonly envName: string;
  private readonly envVars: Record<string, string>;
  private readonly cwd: string;
  private readonly logDir: string;
  private readonly basePort: number;

  constructor(options: OrchestratorOptions) {
    this.config = options.config;
    this.envName = options.envName;
    this.envVars = options.envVars;
    this.cwd = options.cwd;
    this.logDir = options.logDir;
    this.basePort = options.basePort;
  }

  /**
   * Start all services in dependency order.
   */
  async start(): Promise<void> {
    const order = this.topologicalSort();
    const serviceNames = Object.keys(this.config.services);

    for (const name of order) {
      const serviceConfig = this.config.services[name];
      const serviceIndex = serviceNames.indexOf(name);
      const port = PortAllocator.physicalPort(this.basePort, serviceIndex);

      const serviceEnvVars: Record<string, string> = {
        ...this.envVars,
        PORT: String(port),
        ENV_NAME: this.envName,
        STATE_DIR: `${this.cwd}/.spawntree/state/${this.envName}`,
      };

      // Inject service discovery env vars for all other services
      for (const [otherName, otherConfig] of Object.entries(this.config.services)) {
        const otherIndex = serviceNames.indexOf(otherName);
        const otherPort = PortAllocator.physicalPort(this.basePort, otherIndex);
        const upperName = otherName.toUpperCase();

        serviceEnvVars[`${upperName}_HOST`] = "127.0.0.1";
        serviceEnvVars[`${upperName}_PORT`] = String(otherPort);
        serviceEnvVars[`${upperName}_URL`] = `http://127.0.0.1:${otherPort}`;

        if (otherConfig.type === "postgres") {
          serviceEnvVars.DATABASE_URL = `postgresql://localhost:${otherPort}/spawntree_${this.envName}`;
          serviceEnvVars.DB_HOST = "127.0.0.1";
          serviceEnvVars.DB_PORT = String(otherPort);
          serviceEnvVars.DB_NAME = `spawntree_${this.envName}`;
        }

        if (otherConfig.type === "redis") {
          serviceEnvVars.REDIS_URL = `redis://127.0.0.1:${otherPort}`;
          serviceEnvVars.REDIS_HOST = "127.0.0.1";
          serviceEnvVars.REDIS_PORT = String(otherPort);
        }
      }

      // Add per-service environment overrides
      if (serviceConfig.environment) {
        Object.assign(serviceEnvVars, serviceConfig.environment);
      }

      const service = this.createService(name, serviceConfig, serviceEnvVars);
      this.services.set(name, service);

      console.log(`Starting ${name}...`);
      try {
        await service.start();

        // Run healthcheck if available
        if (service.healthcheck) {
          const timeout = serviceConfig.healthcheck?.timeout ?? 30;
          const healthy = await this.waitForHealthy(service, timeout * 1000);
          if (!healthy) {
            throw new Error(`Healthcheck failed for "${name}" after ${timeout}s`);
          }
        }

        console.log(`  ${name} started (port ${port})`);
      } catch (err) {
        console.error(`  ${name} failed: ${err instanceof Error ? err.message : err}`);
        // Abort services that depend on this one
        throw err;
      }
    }
  }

  /**
   * Stop all services in reverse dependency order.
   */
  async stop(): Promise<void> {
    const order = this.topologicalSort().reverse();

    for (const name of order) {
      const service = this.services.get(name);
      if (service && service.status() !== "stopped") {
        console.log(`Stopping ${name}...`);
        await service.stop();
      }
    }
  }

  /**
   * Get status of all services.
   */
  getStatus(): Record<string, ServiceStatus> {
    const result: Record<string, ServiceStatus> = {};
    for (const [name, service] of this.services) {
      result[name] = service.status();
    }
    return result;
  }

  /**
   * Get a service's PID (if it's a ProcessRunner).
   */
  getPid(name: string): number | undefined {
    const service = this.services.get(name);
    if (service instanceof ProcessRunner) {
      return service.pid;
    }
    return undefined;
  }

  /**
   * Topological sort of services by depends_on.
   * Returns service names in start order.
   */
  private topologicalSort(): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected involving "${name}"`);
      }

      visiting.add(name);

      const deps = this.config.services[name]?.depends_on ?? [];
      for (const dep of deps) {
        visit(dep);
      }

      visiting.delete(name);
      visited.add(name);
      result.push(name);
    };

    for (const name of Object.keys(this.config.services)) {
      visit(name);
    }

    return result;
  }

  private createService(
    name: string,
    config: ServiceConfig,
    envVars: Record<string, string>,
  ): Service {
    switch (config.type) {
      case "process":
        return new ProcessRunner({
          name,
          config,
          envVars,
          cwd: this.cwd,
          logDir: this.logDir,
        });
      case "container":
      case "postgres":
      case "redis":
        // v0.1.1: these will have their own runners
        throw new Error(
          `Service type "${config.type}" is not yet supported in v0.1.0. ` +
            `Use type: "process" for now.`,
        );
      default:
        throw new Error(`Unknown service type: ${config.type}`);
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
}
