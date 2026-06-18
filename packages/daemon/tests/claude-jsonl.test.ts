import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDiscoverableClaudeSessions } from "../src/sessions/claude-jsonl.ts";

describe("listDiscoverableClaudeSessions (head-only cwd read)", () => {
  let tmp: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-jsonl-"));
    // Point Claude transcript discovery at the temp dir, not the dev's real
    // ~/.claude/projects.
    originalHome = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = tmp;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = originalHome;
  });

  it("reads cwd from the first line without depending on the whole (large) transcript", () => {
    const projectDir = join(tmp, "projects", "-home-test-proj");
    mkdirSync(projectDir, { recursive: true });
    // The cwd is on the first line; the rest of the file is a multi-MB body the
    // reader must not need to load. The old implementation read the whole file
    // (tens of MB per session, for every session) on the discovery pass.
    const firstLine = JSON.stringify({ type: "user", cwd: "/home/test/proj", message: "hi" });
    const hugeBody = `\n${JSON.stringify({ type: "assistant", text: "x".repeat(2_000_000) })}\n`;
    writeFileSync(join(projectDir, "sess-1.jsonl"), firstLine + hugeBody);

    const found = listDiscoverableClaudeSessions();
    expect(found).toHaveLength(1);
    expect(found[0]?.sessionId).toBe("sess-1");
    expect(found[0]?.cwd).toBe("/home/test/proj");
  });

  it("skips a transcript whose lines carry no cwd", () => {
    const projectDir = join(tmp, "projects", "-no-cwd");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "no-cwd.jsonl"),
      `${JSON.stringify({ type: "system" })}\n${JSON.stringify({ type: "user" })}\n`,
    );
    expect(listDiscoverableClaudeSessions()).toHaveLength(0);
  });

  it("returns an empty list when the projects root doesn't exist", () => {
    // CLAUDE_CONFIG_DIR is the fresh tmp with no projects/ dir yet.
    expect(listDiscoverableClaudeSessions()).toEqual([]);
  });
});
