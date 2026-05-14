import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findGitRepos, probePath } from "../src/catalog/git.ts";

const roots: Array<string> = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "spawntree-git-"));
  roots.push(root);
  return root;
}

function initRepo(path: string) {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: path });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("catalog git discovery", () => {
  it("finds repos nested below watched folders", () => {
    const root = tempRoot();
    const repoA = join(root, "GitStartHQ", "gitenv");
    const repoB = join(root, "ziahamza", "spawntree");
    initRepo(repoA);
    initRepo(repoB);

    expect(findGitRepos(root)).toEqual([realpathSync(repoA), realpathSync(repoB)]);
    expect(probePath(root).childRepoCount).toBe(2);
  });
});
