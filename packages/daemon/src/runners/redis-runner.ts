import Dockerode from "dockerode";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { InfraStatus } from "spawntree-core";
import { spawntreeHome } from "../state/global-state.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function redisDataDir(): string {
  const dir = resolve(spawntreeHome(), "redis", "data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const REDIS_IMAGE = "redis:7-alpine";
const REDIS_CONTAINER_NAME = "spawntree-redis";

// Execute a command inside a running container and return stdout.
async function execInContainer(
  container: Dockerode.Container,
  cmd: string[],
): Promise<string> {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];

    stream.on("data", (chunk: Buffer) => {
      // Docker multiplexed stream: strip 8-byte header per frame
      let offset = 0;
      while (offset < chunk.length) {
        if (chunk.length - offset < 8) {
          chunks.push(chunk.slice(offset));
          break;
        }
        const streamType = chunk[offset];
        const size = chunk.readUInt32BE(offset + 4);
        const payload = chunk.slice(offset + 8, offset + 8 + size);
        if (streamType !== 2) chunks.push(payload);
        offset += 8 + size;
      }
    });

    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// RedisRunner
// ---------------------------------------------------------------------------

export class RedisRunner {
  readonly port: number;
  private containerId?: string;
  private docker: Dockerode;
  private _status: InfraStatus = "stopped";
  private dbIndexMap: Map<string, number> = new Map(); // envKey → dbIndex
  private nextDbIndex: number = 1; // 0 reserved for manual/default use

  constructor(port: number) {
    this.port = port;
    this.docker = new Dockerode();
  }

  // --------------------------------------------------------------------------
  // ensureRunning
  // --------------------------------------------------------------------------

  async ensureRunning(): Promise<void> {
    this._status = "starting";
    console.log(`[spawntree-daemon] [redis] Ensuring container is running on port ${this.port}...`);

    try {
      // Look for existing container by label
      const containers = await this.docker.listContainers({
        all: true,
        filters: JSON.stringify({
          label: [
            "spawntree.managed=true",
            "spawntree.type=redis",
          ],
        }),
      });

      if (containers.length > 0) {
        const info = containers[0];
        const containerId = info.Id;
        const container = this.docker.getContainer(containerId);

        if (info.State === "running") {
          console.log(`[spawntree-daemon] [redis] Reusing running container ${containerId.slice(0, 12)}`);
          this.containerId = containerId;
          this._status = "running";
          return;
        }

        // Stopped — start it
        console.log(`[spawntree-daemon] [redis] Starting stopped container ${containerId.slice(0, 12)}...`);
        await container.start();
        this.containerId = containerId;
        await this.waitForReady(30_000);
        this._status = "running";
        return;
      }

      // No container exists — pull image if needed and create + start
      await this.pullImageIfNeeded();
      await this.createAndStart();
    } catch (err) {
      this._status = "error";
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("connect ENOENT") || msg.includes("connect ECONNREFUSED")) {
        throw new Error(
          `[spawntree-daemon] Docker is not running or not installed. `
            + `Please start Docker Desktop or install Docker Engine. (${msg})`,
        );
      }
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // stop
  // --------------------------------------------------------------------------

  async stop(): Promise<void> {
    if (!this.containerId) return;
    console.log(`[spawntree-daemon] [redis] Stopping container...`);
    try {
      const container = this.docker.getContainer(this.containerId);
      await container.stop();
      this._status = "stopped";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("not running") && !msg.includes("404")) throw err;
      this._status = "stopped";
    }
  }

  // --------------------------------------------------------------------------
  // status
  // --------------------------------------------------------------------------

  status(): InfraStatus {
    return this._status;
  }

  // --------------------------------------------------------------------------
  // DB index allocation
  // --------------------------------------------------------------------------

  allocateDbIndex(envKey: string): number {
    const existing = this.dbIndexMap.get(envKey);
    if (existing !== undefined) return existing;

    const idx = this.nextDbIndex++;
    this.dbIndexMap.set(envKey, idx);
    console.log(`[spawntree-daemon] [redis] Allocated db index ${idx} for ${envKey}`);
    return idx;
  }

  freeDbIndex(envKey: string): void {
    const idx = this.dbIndexMap.get(envKey);
    if (idx !== undefined) {
      this.dbIndexMap.delete(envKey);
      console.log(`[spawntree-daemon] [redis] Freed db index ${idx} for ${envKey}`);
    }
  }

  allocatedDbCount(): number {
    return this.dbIndexMap.size;
  }

  // --------------------------------------------------------------------------
  // flushDb
  // --------------------------------------------------------------------------

  async flushDb(dbIndex: number): Promise<void> {
    if (!this.containerId) {
      throw new Error("Redis container is not running. Call ensureRunning() first.");
    }
    console.log(`[spawntree-daemon] [redis] Flushing db index ${dbIndex}...`);
    const container = this.docker.getContainer(this.containerId);
    await execInContainer(container, [
      "redis-cli",
      "-n",
      String(dbIndex),
      "FLUSHDB",
    ]);
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async pullImageIfNeeded(): Promise<void> {
    console.log(`[spawntree-daemon] [redis] Checking image ${REDIS_IMAGE}...`);
    try {
      await this.docker.getImage(REDIS_IMAGE).inspect();
      console.log(`[spawntree-daemon] [redis] Image ${REDIS_IMAGE} already present`);
      return;
    } catch {
      // Need to pull
    }

    console.log(`[spawntree-daemon] [redis] Pulling image ${REDIS_IMAGE}...`);
    const pullStream = await this.docker.pull(REDIS_IMAGE);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        pullStream,
        (err: Error | null) => {
          if (err) reject(err);
          else {
            console.log(`[spawntree-daemon] [redis] Image ${REDIS_IMAGE} pulled`);
            resolve();
          }
        },
        (event: Record<string, unknown>) => {
          if (event.status) {
            console.log(
              `[spawntree-daemon] [redis] pull: ${event.status}${event.progress ? " " + event.progress : ""}`,
            );
          }
        },
      );
    });
  }

  private async createAndStart(): Promise<void> {
    const dataDir = redisDataDir();

    console.log(`[spawntree-daemon] [redis] Creating container from ${REDIS_IMAGE}...`);

    const container = await this.docker.createContainer({
      Image: REDIS_IMAGE,
      name: REDIS_CONTAINER_NAME,
      Cmd: ["redis-server", "--databases", "512", "--appendonly", "yes"],
      Labels: {
        "spawntree.managed": "true",
        "spawntree.type": "redis",
      },
      ExposedPorts: { "6379/tcp": {} },
      HostConfig: {
        PortBindings: {
          "6379/tcp": [{ HostIp: "127.0.0.1", HostPort: String(this.port) }],
        },
        Binds: [`${dataDir}:/data`],
        RestartPolicy: { Name: "unless-stopped" },
      },
    });

    await container.start();
    this.containerId = container.id;
    console.log(`[spawntree-daemon] [redis] Container started: ${container.id.slice(0, 12)}`);

    await this.waitForReady(30_000);
    this._status = "running";
  }

  private async waitForReady(timeoutMs: number): Promise<void> {
    console.log(`[spawntree-daemon] [redis] Waiting for redis-cli PING...`);
    const start = Date.now();
    const interval = 1000;

    while (Date.now() - start < timeoutMs) {
      try {
        const container = this.docker.getContainer(this.containerId!);
        const out = await execInContainer(container, ["redis-cli", "PING"]);
        if (out.trim() === "PONG") {
          console.log(`[spawntree-daemon] [redis] Ready!`);
          return;
        }
      } catch {
        // Not yet ready
      }
      await new Promise((r) => setTimeout(r, interval));
    }

    throw new Error(`Redis did not become ready within ${timeoutMs / 1000}s`);
  }
}
