import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/**
 * Runtime smoke: boot the daemon as a subprocess on a random port,
 * then hit the key surfaces a user would actually touch. Catches
 * regressions that build-time checks can't:
 *   - daemon starts but hangs
 *   - bundle is present but index.html references a missing asset
 *   - SPA fallback misroutes /sessions to 404
 *   - a new API route accidentally shadows /sessions
 *   - documented error codes drift (e.g. UNKNOWN_PROVIDER starts
 *     returning 500 instead of 400)
 *
 * Assumes `pnpm build` has already produced the daemon dist.
 * CI runs build before test, so this Just Works in CI.
 *
 * Lifecycle: one daemon per test file (beforeAll/afterAll), one fetch
 * per `it` block. Vitest default concurrency puts each test file in
 * its own worker, so even parallel vitest runs don't collide here.
 */

const daemonRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const daemonEntry = resolve(daemonRoot, "dist/server-main.js");

/** Ask the kernel for a free ephemeral port. Not 100% race-free, good enough here. */
async function pickPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

async function waitForReady(origin: string, maxMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/health`);
      if (res.ok && (await res.text()).trim() === "ok") return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const BUILD_NEEDED_MSG =
  "Daemon entrypoint missing. Run `pnpm build` first — smoke tests exercise the compiled daemon.";

describe("dashboard smoke (requires prior `pnpm build`)", () => {
  if (!existsSync(daemonEntry)) {
    it.skip(`daemon not built (${daemonEntry}) — run \`pnpm build\` first`, () => {});
    return;
  }

  let proc: ChildProcess;
  let origin: string;
  let stderrLines: string[] = [];

  beforeAll(async () => {
    const port = await pickPort();
    origin = `http://127.0.0.1:${port}`;

    proc = spawn("node", [daemonEntry], {
      env: { ...process.env, SPAWNTREE_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    stderrLines = [];
    proc.stderr?.on("data", (d: Buffer) => stderrLines.push(d.toString()));

    const ready = await waitForReady(origin);
    if (!ready) {
      proc.kill("SIGTERM");
      const tail = stderrLines.join("").split("\n").slice(-40).join("\n");
      throw new Error(
        `daemon did not become ready on ${origin} within 20s.\n--- daemon stderr (tail) ---\n${tail}`,
      );
    }
  }, 30_000);

  afterAll(async () => {
    proc?.kill("SIGTERM");
    await once(proc, "exit").catch(() => {});
  });

  it("GET /health returns 'ok'", async () => {
    const res = await fetch(`${origin}/health`);
    expect(res.ok).toBe(true);
    expect((await res.text()).trim()).toBe("ok");
  });

  it("GET /api/v1/daemon returns JSON with version", async () => {
    const res = await fetch(`${origin}/api/v1/daemon`);
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { version?: string };
    expect(typeof json.version).toBe("string");
  });

  it("GET /api/v1/sessions returns {sessions: [...]}", async () => {
    const res = await fetch(`${origin}/api/v1/sessions`);
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { sessions?: unknown };
    expect(Array.isArray(json.sessions)).toBe(true);
  });

  it("GET / serves the real dashboard (not the 'Web bundle not found' fallback)", async () => {
    const res = await fetch(`${origin}/`);
    expect(res.ok).toBe(true);
    const body = await res.text();
    expect(body.includes("Web bundle not found")).toBe(false);
    expect(body.includes("<html")).toBe(true);
    expect(body.includes("/assets/")).toBe(true);
  });

  it("GET /sessions falls back to SPA HTML (not 404)", async () => {
    const res = await fetch(`${origin}/sessions`);
    expect(res.ok).toBe(true);
    const body = await res.text();
    expect(body.includes("<html")).toBe(true);
    expect(body.includes("/assets/")).toBe(true);
  });

  it("GET /sessions/any-fake-id falls back to SPA HTML", async () => {
    const res = await fetch(`${origin}/sessions/some-fake-id`);
    expect(res.ok).toBe(true);
    expect((await res.text()).includes("<html")).toBe(true);
  });

  it("GET /api/v1/sessions/unknown returns JSON 404 (never SPA)", async () => {
    const res = await fetch(`${origin}/api/v1/sessions/unknown-id`);
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error?: unknown };
    expect(typeof json.error).toBe("string");
  });

  it("POST /api/v1/sessions with unknown provider returns 400 UNKNOWN_PROVIDER", async () => {
    const res = await fetch(`${origin}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "nonsense-provider", cwd: "/tmp" }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code?: string };
    expect(json.code).toBe("UNKNOWN_PROVIDER");
  });

  it("GET /assets/* serves real JS with correct content-type", async () => {
    // Find a real asset path from the HTML.
    const html = await fetch(`${origin}/`).then((r) => r.text());
    const match = html.match(/\/assets\/[a-zA-Z0-9._-]+\.js/);
    expect(match, "no asset referenced in index.html").not.toBeNull();
    const res = await fetch(`${origin}${match![0]}`);
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type") ?? "").toContain("javascript");
  });
});
