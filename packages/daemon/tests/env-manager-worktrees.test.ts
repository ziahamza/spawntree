import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvManager } from "../src/managers/env-manager.ts";
import { InfraManager } from "../src/managers/infra-manager.ts";
import { LogStreamer } from "../src/managers/log-streamer.ts";
import { PortRegistry } from "../src/managers/port-registry.ts";
import { ProxyManager } from "../src/managers/proxy-manager.ts";

describe("EnvManager worktree hardening", () => {
  let tmp: string;
  let originalHome: string | undefined;
  let proxyManager: ProxyManager;
  let manager: EnvManager;
  const envs: Array<{ repoId: string; envId: string }> = [];

  beforeEach(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-env-manager-"));
    originalHome = process.env["SPAWNTREE_HOME"];
    process.env["SPAWNTREE_HOME"] = resolve(tmp, "home");
    proxyManager = new ProxyManager(await freePort());
    manager = new EnvManager(
      new PortRegistry(),
      new LogStreamer(),
      new InfraManager(),
      proxyManager,
    );
  });

  afterEach(async () => {
    for (const env of [...envs].reverse()) {
      try {
        await manager.deleteEnv(env.repoId, env.envId);
      } catch {
        // best-effort cleanup; individual assertions should surface failures
      }
    }
    envs.length = 0;
    await proxyManager.stop();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    if (originalHome === undefined) {
      delete process.env["SPAWNTREE_HOME"];
    } else {
      process.env["SPAWNTREE_HOME"] = originalHome;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("starts multiple current worktrees in parallel without port or route conflicts", async () => {
    const repo = createRepo("parallel", configWithHealthcheck());
    const worktreeA = addWorktree(repo, "feature-a");
    const worktreeB = addWorktree(repo, "feature-b");
    const worktreeC = addWorktree(repo, "feature-c");

    const started = await Promise.all(
      [worktreeA, worktreeB, worktreeC].map((repoPath) =>
        manager.createEnv({ repoPath, worktreeStrategy: "current" }),
      ),
    );
    envs.push(...started.map((env) => ({ repoId: env.repoId, envId: env.envId })));

    expect(new Set(started.map((env) => env.envId)).size).toBe(3);
    expect(new Set(started.map((env) => env.basePort)).size).toBe(3);
    expect(started.map((env) => realpathSync(env.worktreePath ?? env.repoPath)).sort()).toEqual(
      [worktreeA, worktreeB, worktreeC].map((path) => realpathSync(path)).sort(),
    );

    for (const env of started) {
      const service = env.services.find((candidate) => candidate.name === "app");
      expect(service?.status).toBe("running");
      expect(service?.routes?.some((route) => route.kind === "proxy")).toBe(true);
      const direct = service?.routes?.find((route) => route.kind === "direct");
      expect(direct?.targetPort).toBe(service?.port);
      const res = await fetch(`${direct?.url}/health`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(env.envId);
    }
  });

  it("adds a generic TCP healthcheck for port-backed services that omit one", async () => {
    const repo = createRepo("default-health", configWithoutHealthcheck());
    const env = await manager.createEnv({ repoPath: repo, worktreeStrategy: "current" });
    envs.push({ repoId: env.repoId, envId: env.envId });

    const service = env.services.find((candidate) => candidate.name === "app");
    expect(service?.status).toBe("running");
    expect(service?.routes?.find((route) => route.kind === "direct")?.targetPort).toBe(
      service?.port,
    );
  });

  it("fails before spawn when service config still has unresolved variables", async () => {
    const repo = createRepo(
      "missing-var",
      `services:
  app:
    type: process
    command: node server.mjs --token \${MISSING_SECRET}
    port: 3000
`,
    );

    await expect(
      manager.createEnv({ repoPath: repo, worktreeStrategy: "current" }),
    ).rejects.toThrow(/MISSING_SECRET/);
  });

  it("rejects detached HEAD for implicit env names", async () => {
    const repo = createRepo("detached", configWithHealthcheck());
    execFileSync("git", ["checkout", "--detach", "HEAD"], { cwd: repo, stdio: "pipe" });

    await expect(
      manager.createEnv({ repoPath: repo, worktreeStrategy: "current" }),
    ).rejects.toThrow(/Detached HEAD/);
  });

  it("recreates a stopped env instead of returning stale stopped services", async () => {
    const repo = createRepo("restart", configWithHealthcheck());
    const first = await manager.createEnv({ repoPath: repo, worktreeStrategy: "current" });
    envs.push({ repoId: first.repoId, envId: first.envId });

    await manager.downEnv(first.repoId, first.envId);
    const second = await manager.createEnv({ repoPath: repo, worktreeStrategy: "current" });

    const service = second.services.find((candidate) => candidate.name === "app");
    expect(second.envId).toBe(first.envId);
    expect(service?.status).toBe("running");
    const direct = service?.routes?.find((route) => route.kind === "direct");
    expect((await fetch(`${direct?.url}/health`)).status).toBe(200);
  });

  function createRepo(name: string, config: string): string {
    const repo = resolve(tmp, name);
    execFileSync("git", ["init", "--initial-branch=main", repo], { stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "spawntree@example.test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "SpawnTree Test"], { cwd: repo });
    writeFileSync(resolve(repo, "server.mjs"), serverSource());
    writeFileSync(resolve(repo, "spawntree.yaml"), config);
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "pipe" });
    return repo;
  }

  function addWorktree(repo: string, branch: string): string {
    const path = resolve(tmp, branch);
    execFileSync("git", ["worktree", "add", "-b", branch, path], { cwd: repo, stdio: "pipe" });
    return path;
  }
});

function configWithHealthcheck(): string {
  return `services:
  app:
    type: process
    command: node server.mjs
    port: 3000
    healthcheck:
      url: http://127.0.0.1:\${PORT}/health
      timeout: 5
`;
}

function configWithoutHealthcheck(): string {
  return `services:
  app:
    type: process
    command: node server.mjs
    port: 3000
`;
}

function serverSource(): string {
  return `import { createServer } from "node:http";

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(process.env.ENV_NAME ?? "missing-env");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ env: process.env.ENV_NAME, port: process.env.PORT }));
});

server.listen(Number(process.env.PORT), "127.0.0.1");
`;
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("No TCP address allocated"));
        return;
      }
      const port = address.port;
      server.close(() => resolvePromise(port));
    });
  });
}
