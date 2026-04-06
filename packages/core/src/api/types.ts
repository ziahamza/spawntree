import type { EnvInfo } from "./schemas.js";

export * from "./schemas.js";

export interface RepoInfo {
  repoId: string;
  repoPath: string;
  envs: Array<EnvInfo>;
}

export function deriveRepoId(repoPath: string): string {
  const parts = repoPath.split("/");
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const segment = parts[i];
    if (segment && segment.length > 0) {
      return segment.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    }
  }
  return "unknown";
}
