import { execFileSync } from "node:child_process";

export interface GitMetadata {
  branch: string | null;
  headCommit: string | null;
  remoteUrl: string | null;
}

export function detectGitMetadata(cwd: string): GitMetadata {
  return {
    branch: runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    headCommit: runGit(["rev-parse", "HEAD"], cwd),
    remoteUrl: runGit(["config", "--get", "remote.origin.url"], cwd),
  };
}

function runGit(args: string[], cwd: string): string | null {
  try {
    const output = execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}
