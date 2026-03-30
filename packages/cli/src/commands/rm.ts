import type { Command } from "commander";
import { getClient, getCurrentRepoId } from "../daemon-bridge.js";

export function registerRmCommand(program: Command): void {
  program
    .command("rm")
    .description("Remove an environment (full teardown)")
    .argument("<env-id>", "Environment ID to remove")
    .action(async (envId: string) => {
      let repoId: string;

      try {
        repoId = getCurrentRepoId();
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
        await client.deleteEnv(repoId, envId);
        console.log("Environment removed.");
      } catch (err) {
        console.error("Failed to remove environment:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}
