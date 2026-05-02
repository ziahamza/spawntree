import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Clone, GitPathInfo, GitRemote, Repo, Worktree } from "spawntree-core";

export interface RemoteInfo {
  provider: string;
  owner: string;
  repo: string;
  url: string;
}

export interface GitWorktreeInfo {
  path: string;
  branch: string;
  headRef: string;
}

export interface PathProbeResult {
  path: string;
  exists: boolean;
  isGitRepo: boolean;
  canScanChildren: boolean;
  childRepoCount: number;
}

export function normalizeInputPath(rawPath: string) {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    throw new Error("path is required");
  }
  return resolve(trimmed);
}

export function validateGitRepo(dir: string) {
  return gitOutput(dir, ["rev-parse", "--show-toplevel"]);
}

export function currentBranch(dir: string) {
  try {
    const branch = gitOutput(dir, ["branch", "--show-current"]);
    return branch || "detached";
  } catch {
    return "detached";
  }
}

export function deriveCloneId(path: string) {
  return createHash("sha256").update(path).digest("hex").slice(0, 12) as Clone["id"];
}

export function probePath(rawPath: string): PathProbeResult {
  const path = normalizeInputPath(rawPath);
  const result: PathProbeResult = {
    path,
    exists: false,
    isGitRepo: false,
    canScanChildren: false,
    childRepoCount: 0,
  };

  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return result;
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    throw new Error("path is not a directory");
  }

  result.exists = true;

  try {
    const gitRoot = validateGitRepo(path);
    result.path = resolve(gitRoot);
    result.isGitRepo = true;
    return result;
  } catch {
    result.canScanChildren = true;
    result.childRepoCount = findImmediateGitRepos(path).length;
    return result;
  }
}

export function findImmediateGitRepos(parent: string) {
  const seen = new Set<string>();
  const repos: Array<string> = [];

  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const child = resolve(join(parent, entry.name));
    try {
      const gitRoot = resolve(validateGitRepo(child));
      if (gitRoot === child && !seen.has(gitRoot)) {
        seen.add(gitRoot);
        repos.push(gitRoot);
      }
    } catch {
      continue;
    }
  }

  repos.sort((left, right) => left.localeCompare(right));
  return repos;
}

export function parseRemoteUrl(rawUrl: string): RemoteInfo {
  const url = rawUrl.trim();
  if (url.length === 0) {
    return { provider: "local", owner: "", repo: "", url: "" };
  }

  const sshMatch = url.match(/^[\w.-]+@([\w.-]+):([\w./-]+?)(?:\.git)?$/);
  let host = "";
  let path = "";

  if (sshMatch) {
    host = sshMatch[1];
    path = sshMatch[2];
  } else {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      path = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    } catch {
      return { provider: "local", owner: "", repo: basename(url), url };
    }
  }

  const provider = hostToProvider(host);
  const [owner, repo] = path.split("/", 2);

  return {
    provider,
    owner: owner ?? "",
    repo: repo ?? basename(path),
    url,
  };
}

export function detectRemotes(dir: string): Array<GitRemote> {
  const output = gitOutput(dir, ["remote", "-v"]);
  const seen = new Set<string>();
  const remotes: Array<GitRemote> = [];

  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3 || parts[2].includes("(push)")) {
      continue;
    }
    const [name, url] = parts;
    if (!seen.has(name)) {
      seen.add(name);
      remotes.push({ name, url });
    }
  }

  return remotes;
}

export function detectRepoInfo(dir: string) {
  const remotes = detectRemotes(dir);
  if (remotes.length === 0) {
    return {
      info: {
        provider: "local",
        owner: "",
        repo: sanitizeId(basename(dir)),
        url: "",
      },
      remotes,
    };
  }

  const origin = remotes.find((remote) => remote.name === "origin") ?? remotes[0];
  return {
    info: parseRemoteUrl(origin.url),
    remotes,
  };
}

export function canonicalRepoId(info: RemoteInfo) {
  if (info.provider === "local") {
    return `local/${info.repo || "repo"}`;
  }
  return `${info.provider}/${info.owner}/${info.repo}`;
}

export function repoSlug(info: RemoteInfo) {
  return sanitizeId(canonicalRepoId(info).replaceAll("/", "-")) as Repo["slug"];
}

export function tryGhMetadata(owner: string, repo: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(owner) || !/^[a-zA-Z0-9._-]+$/.test(repo)) {
    return { defaultBranch: "", description: "" };
  }

  try {
    const output = execFileSync(
      "gh",
      ["api", `repos/${owner}/${repo}`, "--jq", '.default_branch + "\n" + (.description // "")'],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    const [defaultBranch = "", description = ""] = output.split("\n", 2);
    return { defaultBranch, description };
  } catch {
    return { defaultBranch: "", description: "" };
  }
}

export function listGitWorktrees(dir: string): Array<GitWorktreeInfo> {
  const output = gitOutput(dir, ["worktree", "list", "--porcelain"]);
  if (!output) {
    return [];
  }

  const worktrees: Array<GitWorktreeInfo> = [];
  let current: GitWorktreeInfo | undefined;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) {
        worktrees.push(current);
      }
      current = {
        path: line.slice("worktree ".length),
        branch: "",
        headRef: "",
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("HEAD ")) {
      current.headRef = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.branch = "";
    }
  }

  if (current) {
    worktrees.push(current);
  }

  return worktrees;
}

export function defaultBranchName(dir: string) {
  try {
    const output = gitOutput(dir, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    return output.replace(/^refs\/remotes\/origin\//, "");
  } catch {
    for (const branch of ["main", "master"]) {
      try {
        gitOutput(dir, ["rev-parse", "--verify", `origin/${branch}`]);
        return branch;
      } catch {
        // keep looking
      }
    }
    return currentBranch(dir) || "main";
  }
}

export function findWorktreeForBranch(dir: string, branch: string) {
  const worktrees = listGitWorktrees(dir);
  const match = worktrees.find((worktree) => worktree.branch === branch);
  if (!match) {
    throw new Error(`no checked-out worktree found for default branch "${branch}"`);
  }
  return match.path;
}

export function discoverWorktrees(clonePath: string, cloneId: Clone["id"]): Array<Worktree> {
  const discoveredAt = new Date().toISOString();
  return listGitWorktrees(clonePath).map((worktree) => ({
    path: worktree.path,
    cloneId,
    branch: worktree.branch,
    headRef: worktree.headRef,
    discoveredAt,
  }));
}

export function inspectGitPath(
  path: string,
  defaultBranch: string,
  hasPathEnvs: boolean,
): GitPathInfo {
  validateGitRepo(path);

  const branch = currentBranch(path);
  const headRef = gitOutput(path, ["rev-parse", "HEAD"]);
  const { branchName: baseRefName, resolvedRef: baseRefResolved } = resolveBaseRef(
    path,
    defaultBranch,
  );

  let mergeBase = "";
  let insertions = 0;
  let deletions = 0;
  let isMergedIntoBase = false;
  let isBaseOutOfDate = false;
  const isBaseBranch = branch === baseRefName;

  if (baseRefResolved) {
    try {
      mergeBase = gitOutput(path, ["merge-base", "HEAD", baseRefResolved]);
    } catch {
      mergeBase = "";
    }
    ({ insertions, deletions } = diffStatAgainstBase(path, mergeBase));
    const baseHead = gitOutputAllowEmpty(path, ["rev-parse", baseRefResolved]);

    if (isBaseBranch) {
      isBaseOutOfDate = headRef !== "" && baseHead !== "" && headRef !== baseHead;
    } else {
      isBaseOutOfDate = mergeBase !== "" && baseHead !== "" && mergeBase !== baseHead;
      isMergedIntoBase = gitIsAncestor(path, "HEAD", baseRefResolved);
    }
  }

  const statusOutput = gitOutputAllowEmpty(path, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  const hasUncommittedChanges = statusOutput.trim().length > 0;
  const activityAt = estimateGitActivityAt(path, headRef, statusOutput);

  return {
    branch,
    headRef,
    activityAt,
    insertions,
    deletions,
    hasUncommittedChanges,
    isMergedIntoBase,
    isBaseOutOfDate,
    isBaseBranch,
    canArchive:
      !isPrimaryWorktreePath(path) && !hasPathEnvs && isMergedIntoBase && !hasUncommittedChanges,
    baseRefName: displayBaseRefName(baseRefResolved, baseRefName) || undefined,
  };
}

export function removeGitWorktree(path: string) {
  if (isPrimaryWorktreePath(path)) {
    throw new Error("cannot archive the primary clone");
  }

  const worktrees = listGitWorktrees(path);
  let execDir =
    worktrees.find((worktree) => isPrimaryWorktreePath(worktree.path))?.path ??
    worktrees.find((worktree) => resolve(worktree.path) !== resolve(path))?.path;

  if (!execDir) {
    execDir = validateGitRepo(path);
  }

  const output = gitOutputAllowEmpty(execDir, ["worktree", "remove", path]);
  if (output.toLowerCase().includes("fatal")) {
    throw new Error(output);
  }
  gitOutputAllowEmpty(execDir, ["worktree", "prune"]);
}

function resolveBaseRef(path: string, defaultBranch: string) {
  const candidates: Array<{ branchName: string; ref: string }> = [];
  const addCandidates = (branchName: string) => {
    if (!branchName) {
      return;
    }
    candidates.push(
      { branchName, ref: `refs/remotes/upstream/${branchName}` },
      { branchName, ref: `refs/remotes/origin/${branchName}` },
      { branchName, ref: `refs/heads/${branchName}` },
    );
  };

  addCandidates(defaultBranch);
  addCandidates("main");
  addCandidates("master");

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.ref)) {
      continue;
    }
    seen.add(candidate.ref);
    if (gitRefExists(path, candidate.ref)) {
      return {
        branchName: candidate.branchName,
        resolvedRef: candidate.ref,
      };
    }
  }

  return { branchName: "", resolvedRef: "" };
}

function gitRefExists(path: string, ref: string) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd: path,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function gitIsAncestor(path: string, fromRef: string, toRef: string) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", fromRef, toRef], {
      cwd: path,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function diffStatAgainstBase(path: string, mergeBase: string) {
  if (!mergeBase) {
    return { insertions: 0, deletions: 0 };
  }

  const output = gitOutputAllowEmpty(path, ["diff", "--numstat", mergeBase, "HEAD"]);
  let insertions = 0;
  let deletions = 0;

  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) {
      continue;
    }
    if (fields[0] !== "-") {
      insertions += Number.parseInt(fields[0] ?? "0", 10) || 0;
    }
    if (fields[1] !== "-") {
      deletions += Number.parseInt(fields[1] ?? "0", 10) || 0;
    }
  }

  return { insertions, deletions };
}

function estimateGitActivityAt(path: string, headRef: string, statusOutput: string) {
  let latest = 0;

  if (headRef) {
    const unixRaw = gitOutputAllowEmpty(path, ["log", "-1", "--format=%ct", "HEAD"]);
    const unix = Number.parseInt(unixRaw, 10);
    if (Number.isFinite(unix)) {
      latest = Math.max(latest, unix * 1000);
    }
  }

  const gitDir = gitOutputAllowEmpty(path, ["rev-parse", "--git-dir"]);
  if (gitDir) {
    const absoluteGitDir = isAbsolute(gitDir) ? gitDir : resolve(path, gitDir);
    latest = Math.max(latest, fileModTime(join(absoluteGitDir, "index")));
    latest = Math.max(latest, fileModTime(join(absoluteGitDir, "logs", "HEAD")));
  }

  for (const changedFile of changedFilesFromPorcelain(path, statusOutput)) {
    latest = Math.max(latest, fileModTime(changedFile));
  }

  return new Date(latest || Date.now()).toISOString();
}

function changedFilesFromPorcelain(root: string, statusOutput: string) {
  const seen = new Set<string>();
  const paths: Array<string> = [];

  for (const line of statusOutput.split("\n")) {
    if (line.length < 4) {
      continue;
    }
    let pathPart = line.slice(3).trim();
    const renamed = pathPart.lastIndexOf(" -> ");
    if (renamed >= 0) {
      pathPart = pathPart.slice(renamed + 4);
    }
    pathPart = pathPart.replace(/^"+|"+$/g, "");
    if (!pathPart) {
      continue;
    }
    const absolutePath = resolve(root, pathPart);
    if (!seen.has(absolutePath)) {
      seen.add(absolutePath);
      paths.push(absolutePath);
    }
  }

  return paths;
}

function fileModTime(path: string) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function displayBaseRefName(resolvedRef: string, branchName: string) {
  if (!resolvedRef) {
    return branchName;
  }
  return resolvedRef.replace(/^refs\/remotes\//, "").replace(/^refs\/heads\//, "");
}

function isPrimaryWorktreePath(path: string) {
  try {
    return statSync(join(path, ".git")).isDirectory();
  } catch {
    return false;
  }
}

function sanitizeId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

function hostToProvider(host: string) {
  const lower = host.toLowerCase();
  if (lower.includes("github")) {
    return "github";
  }
  if (lower.includes("gitlab")) {
    return "gitlab";
  }
  if (lower.includes("bitbucket")) {
    return "bitbucket";
  }
  return "git";
}

function gitOutput(dir: string, args: Array<string>) {
  const output = execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.trim();
}

function gitOutputAllowEmpty(dir: string, args: Array<string>) {
  try {
    return gitOutput(dir, args);
  } catch (error) {
    const message = (error as Error & { stderr?: Buffer | string }).stderr;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
    if (Buffer.isBuffer(message) && message.toString("utf8").trim().length > 0) {
      return message.toString("utf8").trim();
    }
    return "";
  }
}
