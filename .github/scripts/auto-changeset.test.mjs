import { test } from "node:test";
import assert from "node:assert/strict";
import { maxBump } from "./auto-changeset.mjs";
import { extractBump } from "./auto-changeset.mjs";
import { computeRange } from "./auto-changeset.mjs";
import { filesToPackages } from "./auto-changeset.mjs";

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
