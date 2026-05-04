import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  localConfigPathForRepo,
  loadEnv,
  parseConfig,
  type PrepareStatus,
  spawntreeHome,
  validateConfig,
  WorktreeManager,
} from "spawntree-core";

interface PrepareStateFile {
  checksum: string;
  preparedAt: string;
}

export interface PrepareRequest {
  repoPath: string;
  configFile?: string;
  profile?: string;
  force?: boolean;
}

export interface PrepareRunResult {
  status: PrepareStatus;
  ran: boolean;
  exitCode?: number;
  output?: string;
}

export class PrepareManager {
  getStatus(request: PrepareRequest): PrepareStatus {
    const context = this.resolveContext(request);
    if (!context.prepareCommand) {
      return {
        repoPath: context.gitRoot,
        worktreePath: context.gitRoot,
        configPath: context.configPath,
        profile: context.profile,
        checksum: context.checksum,
        state: "unconfigured",
        statePath: context.statePath,
      };
    }

    const state = readPrepareState(context.statePath);
    const preparedAt = state?.preparedAt;
    const statusState =
      state?.checksum === context.checksum ? "ready" : state ? "stale" : "missing";
    return {
      repoPath: context.gitRoot,
      worktreePath: context.gitRoot,
      configPath: context.configPath,
      profile: context.profile,
      checksum: context.checksum,
      state: statusState,
      command: context.prepareCommand,
      ...(preparedAt ? { preparedAt } : {}),
      statePath: context.statePath,
    };
  }

  async run(request: PrepareRequest): Promise<PrepareRunResult> {
    const context = this.resolveContext(request);
    const status = this.getStatus(request);
    if (!context.prepareCommand) {
      return { status, ran: false };
    }
    if (status.state === "ready" && !request.force) {
      return { status, ran: false };
    }

    const env = {
      ...process.env,
      ...context.envVars,
      SPAWNTREE_PROFILE: context.profile,
      SPAWNTREE_CONFIG: context.configPath,
    };
    Object.assign(env, context.config.environment);

    const { exitCode, output } = await runShell(context.prepareCommand, context.gitRoot, env);
    if (exitCode !== 0) {
      return {
        status: this.getStatus(request),
        ran: true,
        exitCode,
        output,
      };
    }

    mkdirSync(resolve(context.statePath, ".."), { recursive: true });
    const preparedAt = new Date().toISOString();
    writeFileSync(
      context.statePath,
      JSON.stringify({ checksum: context.checksum, preparedAt }, null, 2) + "\n",
    );
    return {
      status: this.getStatus(request),
      ran: true,
      exitCode,
      output,
    };
  }

  private resolveContext(request: PrepareRequest) {
    const gitRoot = WorktreeManager.validateGitRepo(request.repoPath);
    const profile = request.profile || "default";
    const configPath = resolveConfigPath(gitRoot, request.configFile);
    const configDir = resolve(configPath, "..");
    const envVars = loadEnv({ envName: profile, configDir, cliOverrides: {} });
    const rawYaml = readFileSync(configPath, "utf8");
    const config = parseConfig(rawYaml, envVars, { profile });
    const validation = validateConfig(config);
    if ("errors" in validation) {
      throw new Error(
        `Config validation failed:\n${validation.errors
          .map((error) => `  ${error.path}: ${error.message}`)
          .join("\n")}`,
      );
    }
    const checksum = checksumPrepare({
      rawYaml,
      configPath,
      profile,
      command: validation.config.prepare?.command,
      inputs: validation.config.prepare?.inputs ?? [],
      cwd: gitRoot,
    });
    const statePath = resolve(
      spawntreeHome(),
      "prepare",
      `${hashShort(gitRoot)}-${safeSlug(profile)}.json`,
    );
    return {
      gitRoot,
      config,
      configPath,
      envVars,
      profile,
      prepareCommand: validation.config.prepare?.command,
      checksum,
      statePath,
    };
  }
}

function resolveConfigPath(repoPath: string, configFile?: string): string {
  if (configFile) {
    return configFile.startsWith("/") ? configFile : resolve(repoPath, configFile);
  }
  const repoConfig = resolve(repoPath, "spawntree.yaml");
  if (existsSync(repoConfig)) return repoConfig;
  const localConfig = localConfigPathForRepo(repoPath);
  if (existsSync(localConfig)) return localConfig;
  return repoConfig;
}

function checksumPrepare(input: {
  rawYaml: string;
  configPath: string;
  profile: string;
  command?: string;
  inputs: string[];
  cwd: string;
}): string {
  const hash = createHash("sha256");
  hash.update(input.rawYaml);
  hash.update("\0");
  hash.update(input.configPath);
  hash.update("\0");
  hash.update(input.profile);
  hash.update("\0");
  hash.update(input.command ?? "");
  for (const item of input.inputs) {
    const path = item.startsWith("/") ? item : resolve(input.cwd, item);
    hash.update("\0");
    hash.update(item);
    if (!existsSync(path)) {
      hash.update(":missing");
      continue;
    }
    const stat = statSync(path);
    hash.update(`:${stat.mtimeMs}:${stat.size}:${stat.isDirectory() ? "dir" : "file"}`);
    if (stat.isFile()) {
      hash.update(readFileSync(path));
    }
  }
  return hash.digest("hex");
}

function readPrepareState(path: string): PrepareStateFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PrepareStateFile;
  } catch {
    return null;
  }
}

async function runShell(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; output: string }> {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 24_000) {
        output = output.slice(output.length - 24_000);
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => {
      resolvePromise({ exitCode: 1, output: error.message });
    });
    child.once("exit", (code) => {
      resolvePromise({ exitCode: code ?? 1, output });
    });
  });
}

function hashShort(value: string): string {
  return createHash("sha256").update(resolve(value)).digest("hex").slice(0, 12);
}

function safeSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-|-$/g, "") || "default"
  );
}
