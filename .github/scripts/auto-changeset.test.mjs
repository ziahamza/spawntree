import { test } from "node:test";
import assert from "node:assert/strict";
import { maxBump } from "./auto-changeset.mjs";
import { extractBump } from "./auto-changeset.mjs";
import { computeRange } from "./auto-changeset.mjs";
import { filesToPackages } from "./auto-changeset.mjs";
import { computeBumps } from "./auto-changeset.mjs";
import { renderChangeset } from "./auto-changeset.mjs";
import { parseGitLog } from "./auto-changeset.mjs";

test("maxBump picks the higher-ranked bump", () => {
  assert.equal(maxBump("patch", "minor"), "minor");
  assert.equal(maxBump("major", "patch"), "major");
  assert.equal(maxBump(null, "patch"), "patch");
  assert.equal(maxBump("minor", null), "minor");
  assert.equal(maxBump(null, null), null);
});

test("extractBump maps conventional types to bumps", () => {
  assert.equal(extractBump(["feat(daemon): add thing"]), "minor");
  assert.equal(extractBump(["fix: correct thing"]), "patch");
  assert.equal(extractBump(["perf(core): speed"]), "patch");
  assert.equal(extractBump(["docs: readme"]), null);
  assert.equal(extractBump(["chore: noop"]), null);
});

test("extractBump detects breaking changes as major", () => {
  assert.equal(extractBump(["feat(api)!: drop field"]), "major");
  assert.equal(extractBump(["fix: x\n\nBREAKING CHANGE: removed y"]), "major");
  assert.equal(extractBump(["fix: x\n\nBREAKING-CHANGE: removed y"]), "major");
});

test("extractBump scans squash bodies (highest wins)", () => {
  const squash = [
    "Sync from gitenv main\n\n" +
      "* fix(daemon): add bin\n" +
      "* feat(daemon): resumable migration\n",
  ];
  assert.equal(extractBump(squash), "minor");
});

test("computeRange uses before..after normally", () => {
  assert.equal(computeRange("aaa", "bbb", null), "aaa..bbb");
});

test("computeRange falls back to last tag on zero/empty before", () => {
  const zero = "0".repeat(40);
  assert.equal(computeRange(zero, "bbb", "v1.2.3"), "v1.2.3..bbb");
  assert.equal(computeRange("", "bbb", "v1.0.0"), "v1.0.0..bbb");
});

test("computeRange falls back to single commit when no tag", () => {
  assert.equal(computeRange("", "bbb", null), "bbb~1..bbb");
  assert.equal(computeRange(null, null, null), "HEAD~1..HEAD");
});

const META = [
  { dir: "daemon", name: "spawntree-daemon", private: false },
  { dir: "core", name: "spawntree-core", private: false },
  { dir: "web", name: "spawntree-web", private: true },
];

test("filesToPackages maps packages/<dir>/** to package names", () => {
  const files = [
    "packages/daemon/src/storage/manager.ts",
    "packages/daemon/package.json",
    "packages/core/src/index.ts",
    "docs/RELEASE.md",
    "README.md",
  ];
  assert.deepEqual(filesToPackages(files, META).sort(), ["spawntree-core", "spawntree-daemon"]);
});

test("filesToPackages ignores unknown dirs and root files", () => {
  assert.deepEqual(filesToPackages(["packages/unknown/x.ts", "package.json"], META), []);
});

const META2 = [
  { dir: "daemon", name: "spawntree-daemon", private: false, ignored: false },
  { dir: "core", name: "spawntree-core", private: false, ignored: false },
  { dir: "browser", name: "spawntree-browser", private: false, ignored: false },
  { dir: "web", name: "spawntree-web", private: true, ignored: false },
  { dir: "cloud", name: "@spawntree/cloud", private: true, ignored: true },
];
const onNpm = (name) => ["spawntree-daemon", "spawntree-core"].includes(name);

test("computeBumps assigns highest bump per package", () => {
  const commits = [
    { message: "feat(daemon): a", files: ["packages/daemon/src/a.ts"] },
    { message: "fix(daemon): b", files: ["packages/daemon/src/b.ts"] },
  ];
  const { bumps } = computeBumps({ commits, packagesMeta: META2, isOnNpm: onNpm });
  assert.equal(bumps.get("spawntree-daemon"), "minor");
});

test("computeBumps patch-fallbacks a touched-but-unbumped public package", () => {
  const commits = [{ message: "chore: tidy", files: ["packages/core/src/x.ts"] }];
  const { bumps } = computeBumps({ commits, packagesMeta: META2, isOnNpm: onNpm });
  assert.equal(bumps.get("spawntree-core"), "patch");
});

test("computeBumps skips private and ignored packages", () => {
  const commits = [
    { message: "feat: x", files: ["packages/web/src/x.ts", "packages/cloud/src/y.ts"] },
  ];
  const { bumps } = computeBumps({ commits, packagesMeta: META2, isOnNpm: onNpm });
  assert.equal(bumps.size, 0);
});

test("computeBumps excludes brand-new (not-on-npm) packages and reports them", () => {
  const commits = [{ message: "feat(browser): new", files: ["packages/browser/src/x.ts"] }];
  const { bumps, skippedNew } = computeBumps({ commits, packagesMeta: META2, isOnNpm: onNpm });
  assert.equal(bumps.has("spawntree-browser"), false);
  assert.deepEqual(skippedNew, ["spawntree-browser"]);
});

test("computeBumps ignores commits that touch no package (e.g. merge commits)", () => {
  const commits = [{ message: "Merge pull request #1", files: [] }];
  const { bumps, skippedNew } = computeBumps({ commits, packagesMeta: META2, isOnNpm: onNpm });
  assert.equal(bumps.size, 0);
  assert.deepEqual(skippedNew, []);
});

test("renderChangeset writes frontmatter + summary", () => {
  const bumps = new Map([
    ["spawntree-daemon", "minor"],
    ["spawntree-core", "patch"],
  ]);
  const out = renderChangeset(bumps, "Automated release");
  assert.match(out, /^---\n"spawntree-daemon": minor\n"spawntree-core": patch\n---\n\nAutomated release\n$/);
});

test("parseGitLog parses hash, message, and files", () => {
  const raw =
    "\x01abc123\x02feat(daemon): add bin\n\nbody line\x03" +
    "packages/daemon/package.json\npackages/daemon/src/x.ts\n" +
    "\x01def456\x02fix(core): tweak\x03packages/core/src/y.ts\n";
  const commits = parseGitLog(raw);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].hash, "abc123");
  assert.match(commits[0].message, /feat\(daemon\): add bin/);
  assert.deepEqual(commits[0].files, ["packages/daemon/package.json", "packages/daemon/src/x.ts"]);
  assert.equal(commits[1].hash, "def456");
  assert.deepEqual(commits[1].files, ["packages/core/src/y.ts"]);
});

test("parseGitLog tolerates empty input and stray fragments", () => {
  assert.deepEqual(parseGitLog(""), []);
  assert.deepEqual(parseGitLog("\n"), []);
});

import { isChangesetFile } from "./auto-changeset.mjs";

test("isChangesetFile recognises changeset markdown, not README or config", () => {
  assert.equal(isChangesetFile("auto-abc123.md"), true);
  assert.equal(isChangesetFile("brave-lions-jump.md"), true);
  assert.equal(isChangesetFile("README.md"), false);
  assert.equal(isChangesetFile("config.json"), false);
});
