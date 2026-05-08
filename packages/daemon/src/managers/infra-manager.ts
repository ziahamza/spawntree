import type { InfraStatusResponse, PostgresInstanceInfo, RedisInstanceInfo } from "spawntree-core";
import { spawntreeHome } from "spawntree-core";
import { PostgresRunner } from "../runners/postgres-runner.ts";
import { RedisRunner } from "../runners/redis-runner.ts";

// Fixed well-known ports for shared infra (outside the dynamic range 10000+)
// These are chosen to not conflict with the dynamic per-env port allocations.
const POSTGRES_BASE_PORT = 15432; // PG default 5432 shifted
const REDIS_PORT = 16379; // Redis default 6379 shifted

function postgresPort(version: string): number {
  // Major version number offset so pg14→15432, pg15→15433, pg16→15434, pg17→15435
  const major = parseInt(version, 10);
  if (Number.isNaN(major)) return POSTGRES_BASE_PORT;
  return POSTGRES_BASE_PORT + (major - 14);
}

/**
 * InfraManager owns all shared PostgresRunner and RedisRunner instances.
 * It is a singleton created once in server-main.ts and injected into EnvManager.
 */
export class InfraManager {
  private postgresRunners: Map<string, PostgresRunner> = new Map(); // version → runner
  private redisRunner: RedisRunner | null = null;

  // --------------------------------------------------------------------------
  // ensurePostgres
  // --------------------------------------------------------------------------

  async ensurePostgres(version = "17"): Promise<PostgresRunner> {
    let runner = this.postgresRunners.get(version);

    if (!runner) {
      const port = postgresPort(version);
      runner = new PostgresRunner(version, port);
      this.postgresRunners.set(version, runner);
    }

    if (runner.status() !== "running") {
      await runner.ensureRunning();
    }

    return runner;
  }

  // --------------------------------------------------------------------------
  // ensureRedis
  // --------------------------------------------------------------------------

  async ensureRedis(): Promise<RedisRunner> {
    if (!this.redisRunner) {
      this.redisRunner = new RedisRunner(REDIS_PORT);
    }

    if (this.redisRunner.status() !== "running") {
      await this.redisRunner.ensureRunning();
    }

    return this.redisRunner;
  }

  // --------------------------------------------------------------------------
  // stop helpers
  // --------------------------------------------------------------------------

  async stopAll(): Promise<void> {
    await Promise.all([this.stopAllPostgres(), this.stopRedis()]);
  }

  async stopPostgres(version?: string): Promise<void> {
    if (version) {
      const runner = this.postgresRunners.get(version);
      if (runner) await runner.stop();
    } else {
      await this.stopAllPostgres();
    }
  }

  async stopRedis(): Promise<void> {
    if (this.redisRunner) await this.redisRunner.stop();
  }

  private async stopAllPostgres(): Promise<void> {
    await Promise.all([...this.postgresRunners.values()].map((r) => r.stop()));
  }

  // --------------------------------------------------------------------------
  // getStatus
  // --------------------------------------------------------------------------

  async getStatus(): Promise<InfraStatusResponse> {
    const postgresInfos: PostgresInstanceInfo[] = [];

    for (const [version, runner] of this.postgresRunners.entries()) {
      let databases: string[] = [];
      try {
        if (runner.status() === "running") {
          databases = await runner.listDatabases();
        }
      } catch {
        // Ignore errors fetching DB list
      }

      postgresInfos.push({
        version,
        status: runner.status(),
        port: runner.port,
        dataDir: `${spawntreeHome()}/postgres/${version}/data`,
        databases,
      });
    }

    let redisInfo: RedisInstanceInfo | undefined;
    if (this.redisRunner) {
      redisInfo = {
        status: this.redisRunner.status(),
        port: this.redisRunner.port,
        allocatedDbIndices: this.redisRunner.allocatedDbCount(),
      };
    }

    return {
      postgres: postgresInfos,
      redis: redisInfo,
    };
  }
}
