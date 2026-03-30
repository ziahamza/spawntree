import type { Command } from "commander";
import { resolve } from "node:path";
import { WorktreeManager, StateManager, PortAllocator } from "@spawntree/core";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show environment status")
    .option("--all", "Show all environments for this repo")
    .action((options) => {
      let repoRoot: string;
      try {
        repoRoot = WorktreeManager.validateGitRepo(process.cwd());
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }

      const spawntreeDir = resolve(repoRoot, ".spawntree");
      const stateManager = new StateManager(spawntreeDir);

      if (options.all) {
        const envs = stateManager.listEnvs();
        if (envs.length === 0) {
          console.log("No environments found.");
          return;
        }

        for (const envName of envs) {
          printEnvStatus(stateManager, envName);
        }
      } else {
        const envName = WorktreeManager.currentBranch(repoRoot);
        const state = stateManager.readState(envName);
        if (!state) {
          console.log(`No environment running for branch "${envName}".`);
          console.log('Run "spawntree up" to start one.');
          return;
        }
        printEnvStatus(stateManager, envName);
      }
    });
}

function printEnvStatus(stateManager: StateManager, envName: string): void {
  const state = stateManager.readState(envName);
  if (!state) return;

  const pids = stateManager.readPids(envName);
  const alive = Object.entries(pids).filter(([_, pid]) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

  console.log(`\n  Environment: ${envName}`);
  console.log(`  Branch:      ${state.branch}`);
  console.log(`  Port range:  ${state.basePort}-${state.basePort + 99}`);
  console.log(`  Created:     ${state.createdAt}`);
  console.log(`  Services:`);

  for (const [name, pid] of Object.entries(pids)) {
    const isAlive = alive.some(([n]) => n === name);
    const status = isAlive ? "running" : "stopped";
    console.log(`    ${name}: ${status} (pid ${pid})`);
  }

  if (Object.keys(pids).length === 0) {
    console.log("    (no services tracked)");
  }
}
