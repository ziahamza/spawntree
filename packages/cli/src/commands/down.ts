import type { Command } from "commander";
import { getClient, getCurrentRepoId, getCurrentEnvId } from "../daemon-bridge.js";

export function registerDownCommand(program: Command): void {
  program
    .command("down")
    .description("Stop the environment")
    .argument("[env-id]", "Environment ID (default: current branch)")
    .option("--prefix <name>", "Named prefix for the environment")
    .action(async (envIdArg?: string, options?: { prefix?: string }) => {
      let repoId: string;
      let envId: string;

      try {
        repoId = getCurrentRepoId();
        envId = envIdArg ?? getCurrentEnvId(options?.prefix);
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
        await client.downEnv(repoId, envId);
        console.log("Environment stopped.");
      } catch (err) {
        console.error("Failed to stop environment:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}
