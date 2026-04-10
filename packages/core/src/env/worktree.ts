import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export class WorktreeManager {
  private readonly repoRoot: string;
  private readonly spawntreeDir: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    this.spawntreeDir = resolve(repoRoot, ".spawntree");
  }

  /**
   * Validate that we're inside a git repository.
   * Throws with a clear error if not.
   */
  static validateGitRepo(dir: string): string {
    try {
      const root = execSync("git rev-parse --show-toplevel", {
        cwd: dir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return root;
    } catch {
      throw new Error(
        `Not a git repository: ${dir}\nspawntree requires a git repository for environment isolation.`,
      );
    }
  }

  /**
   * Get the current git branch name.
   */
  static currentBranch(dir: string): string {
    try {
      return execSync("git branch --show-current", {
        cwd: dir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      return "detached";
    }
  }

  /**
   * Ensure .spawntree/ is in .gitignore.
   */
  ensureGitignore(): void {
    const gitignorePath = resolve(this.repoRoot, ".gitignore");
    const excludePath = resolve(this.repoRoot, ".git", "info", "exclude");

    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, "utf-8");
      if (!content.includes(".spawntree/")) {
        appendFileSync(gitignorePath, "\n.spawntree/\n");
      }
    } else {
      appendFileSync(excludePath, "\n.spawntree/\n");
    }
  }

  /**
   * Create a git worktree for the given environment.
   * Returns the path to the worktree directory.
   */
  create(envName: string): string {
    const worktreePath = resolve(this.spawntreeDir, "envs", envName);

    if (existsSync(worktreePath)) {
      return worktreePath;
    }

    try {
      execSync(
        `git worktree add "${worktreePath}" HEAD --detach`,
        {
          cwd: this.repoRoot,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create worktree for "${envName}": ${msg}`, { cause: err });
    }

    return worktreePath;
  }

  /**
   * Remove a git worktree for the given environment.
   */
  remove(envName: string): void {
    const worktreePath = resolve(this.spawntreeDir, "envs", envName);

    if (!existsSync(worktreePath)) return;

    try {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: this.repoRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // Fallback: just remove the directory
      rmSync(worktreePath, { recursive: true, force: true });
      try {
        execSync("git worktree prune", {
          cwd: this.repoRoot,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Check if a worktree exists for the given environment.
   */
  exists(envName: string): boolean {
    return existsSync(resolve(this.spawntreeDir, "envs", envName));
  }

  /**
   * Get the worktree path for the given environment.
   */
  path(envName: string): string {
    return resolve(this.spawntreeDir, "envs", envName);
  }
}
