import type { Command } from "commander";
import type { EnvInfo, ServiceInfo } from "spawntree-core";
import { getClient, getCurrentProfileEnvId, getCurrentRepoId } from "../daemon-bridge.ts";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show environment status")
    .option("--all", "Show all environments")
    .option("--prefix <name>", "Named prefix for the environment")
    .option("--profile <name>", "Config profile", "default")
    .action(async (options) => {
      let repoId: string;
      let envId: string;

      try {
        repoId = getCurrentRepoId();
        envId = getCurrentProfileEnvId(options.prefix, options.profile);
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
        if (options.all) {
          const { envs } = await client.listEnvs();
          if (envs.length === 0) {
            console.log("No environments found.");
            return;
          }
          for (const env of envs) {
            printEnvStatus(env);
          }
        } else {
          const { env } = await client.getEnv(repoId, envId);
          printEnvStatus(env);
        }
      } catch (err) {
        console.error("Failed to get status:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}

function printEnvStatus(env: EnvInfo): void {
  console.log(`\n  Environment: ${env.envId}`);
  console.log(`  Repo:        ${env.repoId}`);
  console.log(`  Branch:      ${env.branch}`);
  if (env.profile) console.log(`  Profile:     ${env.profile}`);
  if (env.worktreePath) console.log(`  Worktree:    ${env.worktreePath}`);
  console.log(`  Port range:  ${env.basePort}-${env.basePort + 99}`);
  console.log(`  Created:     ${env.createdAt}`);
  console.log(`  Services:`);

  if (env.services.length === 0) {
    console.log("    (no services tracked)");
    return;
  }

  // Compute column widths
  const nameWidth = Math.max(4, ...env.services.map((s) => s.name.length));
  const typeWidth = Math.max(4, ...env.services.map((s) => s.type.length));
  const statusWidth = Math.max(6, ...env.services.map((s) => s.status.length));

  // Header
  const header = `    ${"NAME".padEnd(nameWidth)}  ${"TYPE".padEnd(typeWidth)}  ${"STATUS".padEnd(statusWidth)}  PORT`;
  console.log(header);
  console.log(
    `    ${"-".repeat(nameWidth)}  ${"-".repeat(typeWidth)}  ${"-".repeat(statusWidth)}  ----`,
  );

  for (const svc of env.services) {
    const statusColored = colorStatus(svc.status);
    // Replace the plain status text with the colored version, keeping padding
    const statusDisplay = statusColored + " ".repeat(Math.max(0, statusWidth - svc.status.length));
    const port = svc.port > 0 ? String(svc.port) : "-";
    console.log(
      `    ${svc.name.padEnd(nameWidth)}  ${svc.type.padEnd(typeWidth)}  ${statusDisplay}  ${port}`,
    );
  }
}

function colorStatus(status: ServiceInfo["status"]): string {
  const RESET = "\x1b[0m";
  switch (status) {
    case "running":
      return `\x1b[32m${status}${RESET}`;
    case "starting":
      return `\x1b[33m${status}${RESET}`;
    case "failed":
      return `\x1b[31m${status}${RESET}`;
    case "stopped":
      return `\x1b[90m${status}${RESET}`;
    default:
      return status;
  }
}
