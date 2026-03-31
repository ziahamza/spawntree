import type { Command } from "commander";
import { getClient, getCurrentRepoId, getCurrentEnvId } from "../daemon-bridge.js";
import type { LogLine } from "spawntree-core";

const SERVICE_COLORS: Record<string, string> = {};
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
  if (!SERVICE_COLORS[service]) {
    SERVICE_COLORS[service] = COLOR_PALETTE[colorIndex++ % COLOR_PALETTE.length];
  }
  return SERVICE_COLORS[service];
}

export function registerLogsCommand(program: Command): void {
  program
    .command("logs")
    .description("Stream service logs")
    .argument("[service]", "Service name (omit for all services)")
    .option("-f, --follow", "Follow log output (default: true when no service filter)", false)
    .option("--prefix <name>", "Named prefix for the environment")
    .action(async (service?: string, options?: { follow: boolean; prefix?: string }) => {
      let repoId: string;
      let envId: string;

      try {
        repoId = getCurrentRepoId();
        envId = getCurrentEnvId(options?.prefix);
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

      const services = service ? [service] : undefined;

      try {
        for await (const line of client.streamLogs(repoId, envId, services)) {
          printLogLine(line);
        }
      } catch (err) {
        console.error("Log stream error:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}

function printLogLine(line: LogLine): void {
  const color = colorForService(line.service);
  const prefix = `${color}[${line.service}]${RESET}`;
  process.stdout.write(`${prefix} ${line.line}\n`);
}
