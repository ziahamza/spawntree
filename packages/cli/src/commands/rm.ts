import type { Command } from "commander";
import { resolve } from "node:path";
import { WorktreeManager, StateManager, PortAllocator } from "spawntree-core";

export function registerRmCommand(program: Command): void {
  program
    .command("rm")
    .description("Remove an environment (full teardown)")
    .argument("<env-name>", "Environment name to remove")
    .option("--force", "Skip confirmation", false)
    .action(async (envName: string) => {
      let repoRoot: string;
      try {
        repoRoot = WorktreeManager.validateGitRepo(process.cwd());
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }

      const spawntreeDir = resolve(repoRoot, ".spawntree");
      const stateManager = new StateManager(spawntreeDir);
      const portAllocator = new PortAllocator(spawntreeDir);
      const worktreeManager = new WorktreeManager(repoRoot);

      // Kill any running processes first
      const pids = stateManager.readPids(envName);
      for (const [serviceName, pid] of Object.entries(pids)) {
        console.log(`Killing ${serviceName} (pid ${pid})...`);
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead
        }
      }

      // Free port allocation
      portAllocator.free(envName);
      console.log("Freed port allocation.");

      // Remove git worktree
      worktreeManager.remove(envName);
      console.log("Removed git worktree.");

      // Remove all state
      stateManager.removeAll(envName);
      console.log("Cleaned state, logs, and PIDs.");

      console.log(`\nEnvironment "${envName}" removed.`);
    });
}
