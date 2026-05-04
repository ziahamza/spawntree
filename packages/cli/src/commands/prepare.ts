import type { Command } from "commander";
import { existsSync } from "node:fs";
import { getClient, getRepoPath, resolveConfigFileForRepo } from "../daemon-bridge.ts";

export function registerPrepareCommand(program: Command): void {
  program
    .command("prepare")
    .description("Run idempotent clone/worktree setup")
    .option("--profile <name>", "Config profile", "default")
    .option("--force", "Run even when prepare state is current")
    .action(async (options) => {
      let repoPath: string;
      try {
        repoPath = getRepoPath();
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
      const configFile = resolveConfigFileForRepo(repoPath, program.opts().configFile);

      let client;
      try {
        client = await getClient();
      } catch (err) {
        console.error("Failed to connect to daemon:", err instanceof Error ? err.message : err);
        process.exit(1);
      }

      try {
        const result = await client.prepare({
          repoPath,
          profile: options.profile,
          force: Boolean(options.force),
          ...(existsSync(configFile) ? { configFile } : {}),
        });
        if (!result.ran) {
          console.log(`Prepare ${result.status.state}: ${result.status.profile}`);
          return;
        }
        if (result.output) {
          process.stdout.write(result.output);
        }
        console.log(`Prepare complete: ${result.status.profile}`);
      } catch (err) {
        console.error("Prepare failed:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}
