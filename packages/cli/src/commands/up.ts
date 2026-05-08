import type { Command } from "commander";
import { existsSync } from "node:fs";
import type { LogLine } from "spawntree-core";
import { localConfigPathForRepo } from "spawntree-core";
import {
  getClient,
  getCurrentProfileEnvId,
  getCurrentRepoId,
  getRepoPath,
  isCurrentHeadDetached,
  resolveConfigFileForRepo,
} from "../daemon-bridge.ts";

const COLORS: Record<string, string> = {};
const COLOR_PALETTE = [
  "\x1b[36m", // cyan
  "\x1b[33m", // yellow
  "\x1b[32m", // green
  "\x1b[35m", // magenta
  "\x1b[34m", // blue
];
const RESET = "\x1b[0m";
let colorIndex = 0;

function colorForService(service: string): string {
  if (!COLORS[service]) {
    COLORS[service] = COLOR_PALETTE[colorIndex++ % COLOR_PALETTE.length];
  }
  return COLORS[service];
}

export function registerUpCommand(program: Command): void {
  program
    .command("up")
    .description("Start the environment")
    .option("--prefix <name>", "Named prefix for additional environments")
    .option("--env-name <name>", "Explicit environment name")
    .option("--profile <name>", "Config profile", "default")
    .option("--worktree-strategy <strategy>", "current | isolated | auto", "auto")
    .option("--no-prepare", "Skip automatic prepare")
    .option("--env <vars...>", "Override environment variables (KEY=VALUE)")
    .action(async (options) => {
      let repoId: string;
      let repoPath: string;
      let envId: string;
      let configFile: string;

      try {
        repoId = getCurrentRepoId();
        repoPath = getRepoPath();
        const requestedConfigFile = resolveConfigFileForRepo(repoPath, program.opts().configFile);
        const localConfigFile = localConfigPathForRepo(repoPath);
        configFile = existsSync(requestedConfigFile) ? requestedConfigFile : localConfigFile;
        if (isCurrentHeadDetached() && !options.envName && !options.prefix) {
          throw new Error(
            "Detached HEAD detected. Create or switch to a branch before running SpawnTree, or pass --env-name for an advanced detached-commit environment.",
          );
        }
        envId = options.envName || getCurrentProfileEnvId(options.prefix, options.profile);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }

      if (!existsSync(configFile)) {
        console.error(`Config file not found: ${configFile}`);
        console.error('Run "spawntree init" to create one.');
        process.exit(1);
      }

      if (!["current", "isolated", "auto"].includes(options.worktreeStrategy)) {
        console.error('Invalid --worktree-strategy. Use "current", "isolated", or "auto".');
        process.exit(1);
      }

      // Parse CLI env overrides
      const envOverrides: Record<string, string> = {};
      if (options.env) {
        for (const entry of options.env as string[]) {
          const eqIdx = entry.indexOf("=");
          if (eqIdx === -1) {
            console.error(`Invalid --env format: "${entry}". Use KEY=VALUE.`);
            process.exit(1);
          }
          envOverrides[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
        }
      }

      printStartupPlan({
        repoPath,
        envId,
        profile: options.profile,
        worktreeStrategy: options.worktreeStrategy,
        prepare: options.prepare,
        configFile,
        prefix: options.prefix,
      });
      console.log("Starting daemon...");

      let client;
      try {
        client = await getClient();
      } catch (err) {
        console.error("Failed to connect to daemon:", err instanceof Error ? err.message : err);
        process.exit(1);
      }

      try {
        await client.registerRepo({ repoPath, configPath: configFile });
        const { env } = await client.createEnv({
          repoPath,
          envId,
          prefix: options.prefix,
          profile: options.profile,
          worktreeStrategy: options.worktreeStrategy,
          runPrepare: options.prepare,
          envOverrides: Object.keys(envOverrides).length > 0 ? envOverrides : undefined,
          configFile,
        });

        console.log(
          `Environment "${env.envId}" created. Port range: ${env.basePort}-${env.basePort + 99}`,
        );
        console.log("Streaming logs (Ctrl+C to stop)...\n");
      } catch (err) {
        console.error("Failed to create environment:", err instanceof Error ? err.message : err);
        process.exit(1);
      }

      // Set up Ctrl+C handler to stop the environment
      let stopping = false;
      const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        console.log("\nShutting down...");
        try {
          await client.downEnv(repoId, envId);
          console.log("Environment stopped.");
        } catch {
          // ignore errors on shutdown
        }
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // Stream logs until interrupted
      try {
        for await (const logLine of client.streamLogs(repoId, envId, undefined, {
          follow: true,
          lines: 0,
        })) {
          printLogLine(logLine);
        }
      } catch (err) {
        if (!stopping) {
          console.error("Log stream error:", err instanceof Error ? err.message : err);
          process.exit(1);
        }
      }
    });
}

function printStartupPlan(input: {
  repoPath: string;
  envId: string;
  profile: string;
  worktreeStrategy: string;
  prepare: boolean;
  configFile: string;
  prefix?: string;
}): void {
  console.log("SpawnTree is starting an environment");
  console.log(`  repo: ${input.repoPath}`);
  console.log(`  env: ${input.envId}`);
  console.log(`  profile: ${input.profile}`);
  console.log(`  worktree strategy: ${input.worktreeStrategy}`);
  console.log(`  prepare: ${input.prepare ? "auto" : "skipped"}`);
  console.log(`  config: ${input.configFile}`);
  if (input.prefix) {
    console.log(`  prefix: ${input.prefix}`);
  }
}

function printLogLine(line: LogLine): void {
  const color = colorForService(line.service);
  const prefix = `${color}[${line.service}]${RESET}`;
  process.stdout.write(`${prefix} ${line.line}\n`);
}
