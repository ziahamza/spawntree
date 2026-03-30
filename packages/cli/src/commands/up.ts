import type { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  parseConfig,
  loadEnv,
  validateConfig,
  WorktreeManager,
  PortAllocator,
  StateManager,
  Orchestrator,
} from "spawntree-core";

export function registerUpCommand(program: Command): void {
  program
    .command("up")
    .description("Start the environment")
    .option("--prefix <name>", "Named prefix for additional environments")
    .option("--env <vars...>", "Override environment variables (KEY=VALUE)")
    .action(async (options) => {
      const configFile = resolve(process.cwd(), program.opts().configFile);
      const lockFile = program.opts().lockFile;

      if (!existsSync(configFile)) {
        console.error(`Config file not found: ${configFile}`);
        console.error('Run "spawntree init" to create one.');
        process.exit(1);
      }

      const configDir = dirname(configFile);

      // Validate git repo
      let repoRoot: string;
      try {
        repoRoot = WorktreeManager.validateGitRepo(configDir);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }

      // Resolve env name
      const branch = WorktreeManager.currentBranch(repoRoot);
      const envName = options.prefix
        ? `${branch}-${options.prefix}`
        : branch;

      console.log(`Environment: ${envName}`);

      // Parse CLI env overrides
      const cliOverrides: Record<string, string> = {};
      if (options.env) {
        for (const entry of options.env as string[]) {
          const eqIdx = entry.indexOf("=");
          if (eqIdx === -1) {
            console.error(`Invalid --env format: "${entry}". Use KEY=VALUE.`);
            process.exit(1);
          }
          cliOverrides[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
        }
      }

      // Load env vars
      const envVars = loadEnv({
        envName,
        configDir,
        cliOverrides,
      });

      // Parse config
      const yamlContent = readFileSync(configFile, "utf-8");
      const config = parseConfig(yamlContent, envVars);

      // Validate
      const result = validateConfig(config);
      if ("errors" in result) {
        console.error("Config validation errors:");
        for (const err of result.errors) {
          console.error(`  ${err.path}: ${err.message}`);
        }
        process.exit(1);
      }

      const spawntreeDir = resolve(repoRoot, ".spawntree");

      // Set up environment
      const worktreeManager = new WorktreeManager(repoRoot);
      const portAllocator = new PortAllocator(spawntreeDir, lockFile);
      const stateManager = new StateManager(spawntreeDir);

      // Ensure .gitignore
      worktreeManager.ensureGitignore();

      // Clean stale PIDs (crash recovery)
      const cleaned = stateManager.cleanStalePids(envName);
      if (cleaned.length > 0) {
        console.log(`Cleaned up stale processes: ${cleaned.join(", ")}`);
      }

      // Create worktree
      const worktreePath = worktreeManager.create(envName);

      // Allocate ports
      const basePort = portAllocator.allocate(envName, process.pid);
      console.log(`Port range: ${basePort}-${basePort + 99}`);

      // Create state/log dirs
      stateManager.createStateDir(envName);
      const logDir = stateManager.createLogDir(envName);

      // Save state
      stateManager.saveState(envName, {
        envName,
        branch,
        basePort,
        pids: {},
        createdAt: new Date().toISOString(),
      });

      // Start orchestrator
      const orchestrator = new Orchestrator({
        config: result.config,
        envName,
        envVars,
        cwd: worktreePath,
        logDir,
        basePort,
      });

      // Handle Ctrl+C
      const shutdown = async () => {
        console.log("\nShutting down...");
        await orchestrator.stop();

        // Save PIDs (empty after stop)
        stateManager.saveState(envName, {
          envName,
          branch,
          basePort,
          pids: {},
          createdAt: new Date().toISOString(),
        });

        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      try {
        await orchestrator.start();

        // Save PIDs
        const pids: Record<string, number> = {};
        for (const name of Object.keys(result.config.services)) {
          const pid = orchestrator.getPid(name);
          if (pid !== undefined) {
            pids[name] = pid;
            stateManager.savePid(envName, name, pid);
          }
        }

        stateManager.saveState(envName, {
          envName,
          branch,
          basePort,
          pids,
          createdAt: new Date().toISOString(),
        });

        console.log("\nAll services started. Press Ctrl+C to stop.");

        // Keep process alive in foreground
        await new Promise(() => {});
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        await orchestrator.stop();
        process.exit(1);
      }
    });
}
