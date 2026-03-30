import type { Command } from "commander";
import { resolve } from "node:path";
import { WorktreeManager, StateManager } from "@spawntree/core";

export function registerDownCommand(program: Command): void {
  program
    .command("down")
    .description("Stop the environment")
    .argument("[env-name]", "Environment name (default: current branch)")
    .action(async (envNameArg?: string) => {
      let repoRoot: string;
      try {
        repoRoot = WorktreeManager.validateGitRepo(process.cwd());
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }

      const envName = envNameArg || WorktreeManager.currentBranch(repoRoot);
      const spawntreeDir = resolve(repoRoot, ".spawntree");
      const stateManager = new StateManager(spawntreeDir);

      const state = stateManager.readState(envName);
      if (!state) {
        console.error(`No running environment found: ${envName}`);
        process.exit(1);
      }

      // Kill all tracked processes
      const pids = stateManager.readPids(envName);
      for (const [serviceName, pid] of Object.entries(pids)) {
        console.log(`Stopping ${serviceName} (pid ${pid})...`);
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already dead
        }
      }

      // Wait a moment for graceful shutdown, then force kill
      await new Promise((r) => setTimeout(r, 2000));

      for (const [serviceName, pid] of Object.entries(pids)) {
        try {
          process.kill(pid, 0); // check if alive
          console.log(`  Force killing ${serviceName}...`);
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead
        }
      }

      // Clean up PID files
      stateManager.cleanStalePids(envName);

      console.log(`Environment "${envName}" stopped.`);
    });
}
