#!/usr/bin/env node
/**
 * Runtime smoke test for the daemon + bundled dashboard.
 *
 * Boots the daemon on a random localhost port, hits the key surfaces
 * a user would touch (dashboard HTML, SPA fallback routes, API), and
 * fails the build if any of them don't respond correctly.
 *
 * This catches the regressions that build-time assertions can't:
 *   - daemon starts but hangs
 *   - bundle is present but index.html references a missing asset
 *   - SPA fallback misroutes /sessions to a 404
 *   - a newly-added API route shadows a static path
 *
 * Runs in CI after `pnpm build`. Also usable locally:
 *   node scripts/smoke-dashboard.mjs
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "node:net";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const daemonEntry = resolve(root, "packages/daemon/dist/server-main.js");

if (!existsSync(daemonEntry)) {
  console.error(`✗ daemon entry missing: ${daemonEntry}`);
  console.error("  run `pnpm build` first");
  process.exit(1);
}

/**
 * Pick a free ephemeral port. We bind a socket, read the OS-assigned
 * port, then close. Not 100% race-free but good enough for CI.
 */
async function pickPort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((r) => server.close(r));
  return port;
}

const port = await pickPort();
const origin = `http://127.0.0.1:${port}`;
console.log(`[smoke] picked port ${port}`);

const proc = spawn("node", [daemonEntry], {
  env: { ...process.env, SPAWNTREE_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});

const stdoutLines = [];
const stderrLines = [];
proc.stdout.on("data", (d) => stdoutLines.push(d.toString()));
proc.stderr.on("data", (d) => stderrLines.push(d.toString()));

let failed = false;
function fail(message) {
  console.error(`✗ ${message}`);
  failed = true;
}

/**
 * Poll until the daemon responds on /health, or give up after a bounded
 * retry count. In dev machines this is instant, in CI it can take a
 * couple seconds for node start + Effect runtime to initialize.
 */
async function waitForReady(maxMs = 15_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/health`);
      if (res.ok) {
        const body = await res.text();
        if (body.trim() === "ok") return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

try {
  const ready = await waitForReady();
  if (!ready) {
    fail("daemon did not become ready within 15s");
    throw new Error("daemon startup timeout");
  }
  console.log(`[smoke] daemon up on ${origin}`);

  console.log("[smoke] checks:");

  await check("GET /health returns 'ok'", async () => {
    const res = await fetch(`${origin}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if (body.trim() !== "ok") throw new Error(`body: ${body}`);
  });

  await check("GET /api/v1/daemon returns JSON with version", async () => {
    const res = await fetch(`${origin}/api/v1/daemon`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (typeof json.version !== "string") throw new Error("no version field");
  });

  await check("GET /api/v1/sessions returns {sessions}", async () => {
    const res = await fetch(`${origin}/api/v1/sessions`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json.sessions)) throw new Error("no sessions array");
  });

  await check("GET / serves the dashboard HTML (not fallback)", async () => {
    const res = await fetch(`${origin}/`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if (body.includes("Web bundle not found")) {
      throw new Error("got 'Web bundle not found' fallback — bundle missing");
    }
    if (!body.includes("<html")) throw new Error("not HTML");
    if (!body.includes("/assets/")) throw new Error("no /assets/ references in HTML");
  });

  await check("GET /sessions falls back to SPA (dashboard HTML, not 404)", async () => {
    const res = await fetch(`${origin}/sessions`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if (!body.includes("<html")) throw new Error("not HTML");
    if (!body.includes("/assets/")) throw new Error("no /assets/ references");
  });

  await check("GET /sessions/any-id falls back to SPA", async () => {
    const res = await fetch(`${origin}/sessions/some-fake-id`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if (!body.includes("<html")) throw new Error("not HTML");
  });

  await check("GET /api/v1/sessions/unknown returns 404 (not SPA)", async () => {
    const res = await fetch(`${origin}/api/v1/sessions/unknown-id`);
    if (res.status !== 404) throw new Error(`expected 404, got ${res.status}`);
    const json = await res.json();
    if (typeof json.error !== "string") throw new Error("expected error JSON");
  });

  await check("POST /api/v1/sessions with invalid provider returns 400", async () => {
    const res = await fetch(`${origin}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "nonsense-provider", cwd: "/tmp" }),
    });
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
    const json = await res.json();
    if (json.code !== "UNKNOWN_PROVIDER") {
      throw new Error(`expected code UNKNOWN_PROVIDER, got ${json.code}`);
    }
  });

  await check("GET /assets/* serves static files", async () => {
    // Find a real asset path from the HTML.
    const html = await fetch(`${origin}/`).then((r) => r.text());
    const match = html.match(/\/assets\/[a-zA-Z0-9._-]+\.js/);
    if (!match) throw new Error("no asset referenced in HTML");
    const res = await fetch(`${origin}${match[0]}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${match[0]}`);
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("javascript")) throw new Error(`wrong content-type: ${ct}`);
  });
} finally {
  proc.kill("SIGTERM");
  await once(proc, "exit").catch(() => {});
}

if (failed) {
  console.error("\n[smoke] ✗ one or more checks failed");
  if (stderrLines.length > 0) {
    console.error("\n--- daemon stderr (last 40 lines) ---");
    console.error(stderrLines.join("").split("\n").slice(-40).join("\n"));
  }
  process.exit(1);
}

console.log("\n[smoke] ✓ all dashboard + API checks passed");
