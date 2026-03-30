import type { Command } from "commander";
import { resolve } from "node:path";
import { existsSync, readdirSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { WorktreeManager } from "spawntree-core";

export function registerLogsCommand(program: Command): void {
  program
    .command("logs")
    .description("Tail service logs")
    .argument("[service]", "Service name (omit for all services)")
    .option("-f, --follow", "Follow log output", false)
    .action(async (service?: string, options?: { follow: boolean }) => {
      let repoRoot: string;
      try {
        repoRoot = WorktreeManager.validateGitRepo(process.cwd());
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }

      const envName = WorktreeManager.currentBranch(repoRoot);
      const logDir = resolve(repoRoot, ".spawntree", "logs", envName);

      if (!existsSync(logDir)) {
        console.error(`No logs found for environment "${envName}".`);
        process.exit(1);
      }

      if (service) {
        const logFile = resolve(logDir, `${service}.log`);
        if (!existsSync(logFile)) {
          console.error(`No log file found for service "${service}".`);
          process.exit(1);
        }
        await tailFile(logFile, service);
      } else {
        const files = readdirSync(logDir).filter((f) => f.endsWith(".log"));
        if (files.length === 0) {
          console.log("No log files found.");
          return;
        }
        for (const file of files) {
          const svcName = file.replace(".log", "");
          await tailFile(resolve(logDir, file), svcName);
        }
      }
    });
}

const COLORS = [
  "\x1b[36m", // cyan
  "\x1b[33m", // yellow
  "\x1b[32m", // green
  "\x1b[35m", // magenta
  "\x1b[34m", // blue
];
const RESET = "\x1b[0m";
let colorIndex = 0;

async function tailFile(path: string, serviceName: string): Promise<void> {
  const color = COLORS[colorIndex++ % COLORS.length];
  const stream = createReadStream(path, { encoding: "utf-8" });
  const rl = createInterface({ input: stream });

  for await (const line of rl) {
    console.log(`${color}[${serviceName}]${RESET} ${line}`);
  }
}
