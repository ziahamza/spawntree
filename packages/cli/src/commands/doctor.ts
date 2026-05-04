import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getRepoPath, isDaemonRunning, resolveConfigFileForRepo } from "../daemon-bridge.ts";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check local SpawnTree prerequisites")
    .option("--profile <name>", "Config profile", "default")
    .action(async (options) => {
      const checks: Check[] = [];
      checks.push(commandCheck("git", ["--version"]));
      checks.push(commandCheck("node", ["--version"]));
      checks.push(commandCheck("pnpm", ["--version"]));
      checks.push(commandCheck("mise", ["--version"], false));

      let repoPath: string | null = null;
      try {
        repoPath = getRepoPath();
        checks.push({ name: "git repo", ok: true, detail: repoPath });
      } catch (err) {
        checks.push({
          name: "git repo",
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      if (repoPath) {
        const configFile = resolveConfigFileForRepo(repoPath, program.opts().configFile);
        checks.push({
          name: "config",
          ok: existsSync(configFile),
          detail: configFile,
        });
        checks.push({
          name: ".env",
          ok: existsSync(resolve(repoPath, ".env")),
          detail: resolve(repoPath, ".env"),
        });
      }

      const daemonRunning = await isDaemonRunning();
      checks.push({
        name: "daemon",
        ok: daemonRunning,
        detail: daemonRunning ? "running" : "not running",
      });

      if (options.profile && options.profile !== "default") {
        checks.push(commandCheck("docker", ["version", "--format", "{{.Server.Version}}"], false));
      }

      for (const check of checks) {
        console.log(`${check.ok ? "ok" : "fail"}  ${check.name}  ${check.detail}`);
      }

      if (checks.some((check) => !check.ok)) {
        process.exit(1);
      }
    });
}

function commandCheck(command: string, args: string[], required = true): Check {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { name: command, ok: true, detail: output.split("\n")[0] ?? "found" };
  } catch {
    return {
      name: command,
      ok: !required,
      detail: required ? "missing" : "missing optional dependency",
    };
  }
}
