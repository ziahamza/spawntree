import { test } from "node:test";
import assert from "node:assert/strict";
import { maxBump } from "./auto-changeset.mjs";

test("maxBump picks the higher-ranked bump", () => {
  assert.equal(maxBump("patch", "minor"), "minor");
  assert.equal(maxBump("major", "patch"), "major");
  assert.equal(maxBump(null, "patch"), "patch");
  assert.equal(maxBump("minor", null), "minor");
  assert.equal(maxBump(null, null), null);
});
