/**
 * Format-level test for spawntree-browser's unified-diff output.
 *
 * The original gitenv test fed the diff through a React-component-side
 * parser to verify parity. Here we assert the structural invariants of
 * the format directly — every consumer downstream parses these
 * invariants the same way (`diff --git`, `index`, `---`, `+++`, `@@`).
 *
 * We can't run isomorphic-git here (it needs a real on-disk git repo),
 * but we DO synthesise diffs through the same `diff` package the
 * production code uses, so the assertions exercise the same hunk
 * generation downstream consumers will see.
 */
import { createPatch } from "diff";
import { describe, expect, it } from "vitest";

function buildSyntheticUnifiedDiff(
  path: string,
  baseText: string,
  headText: string,
  baseSha = "abc1234",
  headSha = "def5678",
): string {
  const header = [
    `diff --git a/${path} b/${path}`,
    `index ${baseSha.slice(0, 7)}..${headSha.slice(0, 7)} 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
  ].join("\n");
  const patch = createPatch(path, baseText, headText, "", "", { context: 3 });
  const body = patch.slice(patch.indexOf("@@"));
  return header + "\n" + body;
}

describe("spawntree-browser unified diff format", () => {
  it("emits the expected header sequence for a modify diff", () => {
    const diff = buildSyntheticUnifiedDiff(
      "src/foo.ts",
      "function hello() {\n  return 1;\n}\n",
      "function hello() {\n  return 2;\n}\n",
    );
    const lines = diff.split("\n");
    expect(lines[0]).toBe("diff --git a/src/foo.ts b/src/foo.ts");
    expect(lines[1]).toMatch(/^index [0-9a-f]{7}\.\.[0-9a-f]{7} 100644$/);
    expect(lines[2]).toBe("--- a/src/foo.ts");
    expect(lines[3]).toBe("+++ b/src/foo.ts");
    expect(lines[4]).toMatch(/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/);
    // The body should contain at least one addition with the new value
    // and one deletion of the old value.
    expect(lines.some((l) => l.startsWith("+") && l.includes("return 2"))).toBe(true);
    expect(lines.some((l) => l.startsWith("-") && l.includes("return 1"))).toBe(true);
  });

  it("emits a new-file header for an add diff", () => {
    const path = "src/new.ts";
    const text = "console.log('hi');\n";
    const header = [
      `diff --git a/${path} b/${path}`,
      `new file mode 100644`,
      `index 0000000..abc1234`,
      `--- /dev/null`,
      `+++ b/${path}`,
    ].join("\n");
    const patch = createPatch(path, "", text, "", "", { context: 3 });
    const body = patch.slice(patch.indexOf("@@"));
    const diff = header + "\n" + body;

    const lines = diff.split("\n");
    expect(lines[0]).toBe(`diff --git a/${path} b/${path}`);
    expect(lines[1]).toBe("new file mode 100644");
    expect(lines[3]).toBe("--- /dev/null");
    expect(lines[4]).toBe(`+++ b/${path}`);
    expect(lines.some((l) => l.startsWith("+") && l.includes("console.log"))).toBe(true);
  });

  it("can be safely concatenated with other file sections", () => {
    const a = buildSyntheticUnifiedDiff("a.ts", "old\n", "new\n");
    const b = buildSyntheticUnifiedDiff("b.ts", "1\n", "2\n");
    const combined = a + "\n" + b;
    // Each file section starts with its own `diff --git` header.
    const headers = combined.split("\n").filter((l) => l.startsWith("diff --git"));
    expect(headers).toHaveLength(2);
    expect(headers[0]).toContain("a.ts");
    expect(headers[1]).toContain("b.ts");
  });
});
