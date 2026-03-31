#!/usr/bin/env node

import { Command } from "commander";
import { registerUpCommand } from "./commands/up.js";
import { registerDownCommand } from "./commands/down.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerRmCommand } from "./commands/rm.js";
import { registerInitCommand } from "./commands/init.js";
import { getClient, getCurrentRepoId, getCurrentEnvId, getRepoPath } from "./daemon-bridge.js";

const program = new Command();

program
  .name("spawntree")
  .description("Isolated environment orchestrator")
  .version("0.1.0")
  .option("--config-file <path>", "Path to spawntree.yaml", "spawntree.yaml")
  .option("--lock-file <path>", "Path to lock file");

registerUpCommand(program);
registerDownCommand(program);
registerStatusCommand(program);
registerLogsCommand(program);
registerRmCommand(program);
registerInitCommand(program);

// ---------------------------------------------------------------------------
// infra subcommands
// ---------------------------------------------------------------------------

const infraCmd = program
  .command("infra")
  .description("Manage shared infrastructure (Postgres, Redis)");

infraCmd
  .command("status")
  .description("Show infrastructure status")
  .action(async () => {
    let client;
    try {
      client = await getClient();
    } catch (err) {
      console.error("Failed to connect to daemon:", err instanceof Error ? err.message : err);
      process.exit(1);
    }

    try {
      const status = await client.getInfraStatus();

      console.log("\nPostgres instances:");
      if (status.postgres.length === 0) {
        console.log("  (none)");
      } else {
        for (const pg of status.postgres) {
          console.log(`  version=${pg.version}  status=${pg.status}  port=${pg.port}`);
          if (pg.databases.length > 0) {
            console.log(`    databases: ${pg.databases.join(", ")}`);
          }
        }
      }

      console.log("\nRedis:");
      if (!status.redis) {
        console.log("  (none)");
      } else {
        console.log(
          `  status=${status.redis.status}  port=${status.redis.port}  dbs=${status.redis.allocatedDbIndices}`,
        );
      }
    } catch (err) {
      console.error("Failed to get infra status:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

infraCmd
  .command("stop")
  .description("Stop shared infrastructure")
  .option("--target <target>", "Target to stop: postgres | redis | all", "all")
  .option("--version <version>", "Postgres version (when target=postgres)")
  .action(async (options) => {
    let client;
    try {
      client = await getClient();
    } catch (err) {
      console.error("Failed to connect to daemon:", err instanceof Error ? err.message : err);
      process.exit(1);
    }

    try {
      const target = options.target as "postgres" | "redis" | "all";
      if (!["postgres", "redis", "all"].includes(target)) {
        console.error(`Invalid target "${target}". Must be postgres, redis, or all.`);
        process.exit(1);
      }
      await client.stopInfra({ target, version: options.version });
      console.log(`Infrastructure (${target}) stopped.`);
    } catch (err) {
      console.error("Failed to stop infra:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// db subcommands
// ---------------------------------------------------------------------------

const dbCmd = program
  .command("db")
  .description("Database template management (dump / restore)");

dbCmd
  .command("dump <name>")
  .description("Dump the current environment's database to a named template")
  .option("--db <dbName>", "Database service name", "db")
  .option("--prefix <prefix>", "Named prefix for the environment")
  .action(async (name: string, options) => {
    let repoId: string;
    let repoPath: string;
    let envId: string;

    try {
      repoId = getCurrentRepoId();
      repoPath = getRepoPath();
      envId = getCurrentEnvId(options.prefix);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }

    let client;
    try {
      client = await getClient();
    } catch (err) {
      console.error("Failed to connect to daemon:", err instanceof Error ? err.message : err);
      process.exit(1);
    }

    try {
      const { template } = await client.dumpDb({
        repoPath,
        envId,
        dbName: options.db,
        templateName: name,
      });
      console.log(`Database dumped to template "${template.name}" (${formatBytes(template.size)}).`);
    } catch (err) {
      console.error("Failed to dump database:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

dbCmd
  .command("restore <name>")
  .description("Restore a named database template into the current environment")
  .option("--db <dbName>", "Database service name", "db")
  .option("--prefix <prefix>", "Named prefix for the environment")
  .action(async (name: string, options) => {
    let repoId: string;
    let repoPath: string;
    let envId: string;

    try {
      repoId = getCurrentRepoId();
      repoPath = getRepoPath();
      envId = getCurrentEnvId(options.prefix);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }

    let client;
    try {
      client = await getClient();
    } catch (err) {
      console.error("Failed to connect to daemon:", err instanceof Error ? err.message : err);
      process.exit(1);
    }

    try {
      await client.restoreDb({
        repoPath,
        envId,
        dbName: options.db,
        templateName: name,
      });
      console.log(`Template "${name}" restored to environment "${envId}".`);
    } catch (err) {
      console.error("Failed to restore database:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------

program.parse();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
