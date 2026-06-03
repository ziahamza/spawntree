import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { packageFileFor } from "./skip-unpublished.mjs";

// Run from the repo root: `node --test .github/scripts/skip-unpublished.test.mjs`
test("packageFileFor resolves a real package by name", () => {
  assert.equal(packageFileFor("spawntree-daemon"), join("packages", "daemon", "package.json"));
});

test("packageFileFor returns null for an unknown package", () => {
  assert.equal(packageFileFor("does-not-exist"), null);
});
