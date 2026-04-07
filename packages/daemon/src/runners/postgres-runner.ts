import Dockerode from "dockerode";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InfraStatus } from "spawntree-core";
import { spawntreeHome } from "../state/global-state.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pgDataDir(version: string): string {
  const dir = resolve(spawntreeHome(), "postgres", version, "data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function pgTemplateDir(): string {
  const dir = resolve(spawntreeHome(), "postgres", "templates");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function dockerfileContent(version: string): string {
  return [
    `FROM postgres:${version}`,
    `RUN apt-get update && apt-get install -y --no-install-recommends \\`,
    `    postgresql-${version}-pgvector \\`,
    `    postgresql-${version}-cron \\`,
    `    postgresql-${version}-postgis-3 \\`,
    `    && rm -rf /var/lib/apt/lists/*`,
    `# pg_trgm and uuid-ossp are built-in contrib modules, just need CREATE EXTENSION`,
  ].join("\n") + "\n";
}

const IMAGE_TAG_PREFIX = "spawntree-postgres";
const CONTAINER_NAME_PREFIX = "spawntree-postgres";

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
    const errChunks: Buffer[] = [];

    stream.on("data", (chunk: Buffer) => {
      // Docker multiplexed stream: first byte is stream type, bytes 4-7 = size
      // Strip the 8-byte header per frame
      let offset = 0;
      while (offset < chunk.length) {
        if (chunk.length - offset < 8) {
          // Incomplete header — treat as raw data
          chunks.push(chunk.slice(offset));
          break;
        }
        const streamType = chunk[offset];
        const size = chunk.readUInt32BE(offset + 4);
        const payload = chunk.slice(offset + 8, offset + 8 + size);
        if (streamType === 2) {
          errChunks.push(payload);
        } else {
          chunks.push(payload);
        }
        offset += 8 + size;
      }
    });

    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// PostgresRunner
// ---------------------------------------------------------------------------

export class PostgresRunner {
  readonly version: string;
  readonly port: number;
  private containerId?: string;
  private docker: Dockerode;
  private _status: InfraStatus = "stopped";

  constructor(version: string, port: number) {
    this.version = version;
    this.port = port;
    this.docker = new Dockerode();
  }

  // --------------------------------------------------------------------------
  // ensureRunning
  // --------------------------------------------------------------------------

  async ensureRunning(): Promise<void> {
    this._status = "starting";
    console.log(`[spawntree-daemon] [postgres:${this.version}] Ensuring container is running on port ${this.port}...`);

    try {
      // Look for existing container by label
      const containers = await this.docker.listContainers({
        all: true,
        filters: JSON.stringify({
          label: [
            "spawntree.managed=true",
            "spawntree.type=postgres",
            `spawntree.version=${this.version}`,
          ],
        }),
      });

      if (containers.length > 0) {
        const info = containers[0];
        const containerId = info.Id;
        const container = this.docker.getContainer(containerId);

        if (info.State === "running") {
          console.log(
            `[spawntree-daemon] [postgres:${this.version}] Reusing running container ${containerId.slice(0, 12)}`,
          );
          this.containerId = containerId;
          this._status = "running";
          return;
        }

        // Stopped — start it
        console.log(
          `[spawntree-daemon] [postgres:${this.version}] Starting stopped container ${containerId.slice(0, 12)}...`,
        );
        await container.start();
        this.containerId = containerId;
        await this.waitForReady(60_000);
        this._status = "running";
        return;
      }

      // No container exists — build image if needed, then create + start
      await this.buildImageIfNeeded();
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
    console.log(`[spawntree-daemon] [postgres:${this.version}] Stopping container...`);
    try {
      const container = this.docker.getContainer(this.containerId);
      await container.stop();
      this._status = "stopped";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Ignore "not running" errors
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
  // Database management
  // --------------------------------------------------------------------------

  async databaseExists(dbName: string): Promise<boolean> {
    const container = this.requireContainer();
    const safeName = dbName.replace(/'/g, "''");
    const out = await execInContainer(container, [
      "psql",
      "-U",
      "postgres",
      "-tAc",
      `SELECT 1 FROM pg_database WHERE datname='${safeName}'`,
    ]);
    return out.trim() === "1";
  }

  async createDatabase(dbName: string): Promise<void> {
    const exists = await this.databaseExists(dbName);
    if (exists) {
      console.log(`[spawntree-daemon] [postgres:${this.version}] Database "${dbName}" already exists`);
      return;
    }
    console.log(`[spawntree-daemon] [postgres:${this.version}] Creating database "${dbName}"...`);
    const container = this.requireContainer();
    const safeName = dbName.replace(/'/g, "''");
    await execInContainer(container, [
      "psql",
      "-U",
      "postgres",
      "-c",
      `CREATE DATABASE "${safeName}"`,
    ]);
  }

  async dropDatabase(dbName: string): Promise<void> {
    const exists = await this.databaseExists(dbName);
    if (!exists) return;
    console.log(`[spawntree-daemon] [postgres:${this.version}] Dropping database "${dbName}"...`);
    const container = this.requireContainer();
    const safeName = dbName.replace(/'/g, "''");
    await execInContainer(container, [
      "psql",
      "-U",
      "postgres",
      "-c",
      `DROP DATABASE "${safeName}"`,
    ]);
  }

  async listDatabases(): Promise<string[]> {
    const container = this.requireContainer();
    const out = await execInContainer(container, [
      "psql",
      "-U",
      "postgres",
      "-tAc",
      "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
    ]);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  // --------------------------------------------------------------------------
  // Fork / Template operations
  // --------------------------------------------------------------------------

  /**
   * Populate dbName by dumping from sourceUrl and restoring locally.
   * sourceUrl is a standard postgres connection string.
   */
  async forkFrom(dbName: string, sourceUrl: string): Promise<void> {
    console.log(`[spawntree-daemon] [postgres:${this.version}] Forking "${dbName}" from ${sourceUrl}...`);
    const container = this.requireContainer();

    // Dump from source into the container via pg_dump piped to pg_restore
    // We run pg_dump on the host and pipe into pg_restore inside the container
    // using dockerode exec with stdin
    const exec = await container.exec({
      Cmd: [
        "bash",
        "-c",
        `pg_restore -U postgres -d "${dbName}" --no-owner --no-acl -v`,
      ],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });

    // Actually, we use a two-step approach: pg_dump from source host → pipe → pg_restore in container
    // Since pg_dump runs on the host, we spawn it and stream into the exec
    const { spawn } = await import("node:child_process");
    const dumpProcess = spawn("pg_dump", [
      "--format=custom",
      "--no-owner",
      "--no-acl",
      sourceUrl,
    ]);

    const stream = await exec.start({ hijack: true, stdin: true });

    await new Promise<void>((resolve, reject) => {
      dumpProcess.stdout.pipe(stream);
      dumpProcess.on("error", reject);
      dumpProcess.on("close", (code) => {
        stream.end();
        if (code !== 0) reject(new Error(`pg_dump failed with code ${code}`));
        else resolve();
      });
      stream.on("error", reject);
      stream.on("end", resolve);
    });
  }

  async dumpToTemplate(dbName: string, templateName: string): Promise<void> {
    console.log(`[spawntree-daemon] [postgres:${this.version}] Dumping "${dbName}" to template "${templateName}"...`);
    const templatePath = resolve(pgTemplateDir(), `${templateName}.dump`);
    const container = this.requireContainer();

    // pg_dump -Fc inside container, pipe out to host file
    const exec = await container.exec({
      Cmd: ["pg_dump", "-U", "postgres", "--format=custom", "--no-owner", "--no-acl", dbName],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    const { createWriteStream } = await import("node:fs");
    const fileStream = createWriteStream(templatePath);

    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => {
        // Strip docker multiplexed stream headers
        let offset = 0;
        while (offset < chunk.length) {
          if (chunk.length - offset < 8) {
            fileStream.write(chunk.slice(offset));
            break;
          }
          const streamType = chunk[offset];
          const size = chunk.readUInt32BE(offset + 4);
          const payload = chunk.slice(offset + 8, offset + 8 + size);
          if (streamType === 1) fileStream.write(payload);
          offset += 8 + size;
        }
      });
      stream.on("end", () => {
        fileStream.end();
        resolve();
      });
      stream.on("error", reject);
      fileStream.on("error", reject);
    });

    console.log(`[spawntree-daemon] [postgres:${this.version}] Template saved: ${templatePath}`);
  }

  async restoreFromTemplate(dbName: string, templateName: string): Promise<void> {
    console.log(
      `[spawntree-daemon] [postgres:${this.version}] Restoring "${dbName}" from template "${templateName}"...`,
    );
    const templatePath = resolve(pgTemplateDir(), `${templateName}.dump`);

    if (!existsSync(templatePath)) {
      throw new Error(`Template "${templateName}" not found at ${templatePath}`);
    }

    await this.createDatabase(dbName);
    const container = this.requireContainer();

    const exec = await container.exec({
      Cmd: ["pg_restore", "-U", "postgres", "-d", dbName, "--no-owner", "--no-acl"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: true });

    const { createReadStream } = await import("node:fs");
    const fileStream = createReadStream(templatePath);

    await new Promise<void>((resolve, reject) => {
      fileStream.pipe(stream);
      fileStream.on("error", reject);
      stream.on("end", resolve);
      stream.on("error", reject);
    });
  }

  listTemplates(): Array<{ name: string; size: number; createdAt: string; }> {
    const dir = pgTemplateDir();
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".dump"))
        .map((f) => {
          const filePath = resolve(dir, f);
          const s = statSync(filePath);
          return {
            name: f.replace(/\.dump$/, ""),
            size: s.size,
            createdAt: s.birthtime.toISOString(),
          };
        });
    } catch {
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private requireContainer(): Dockerode.Container {
    if (!this.containerId) {
      throw new Error(
        `Postgres ${this.version} container is not running. Call ensureRunning() first.`,
      );
    }
    return this.docker.getContainer(this.containerId);
  }

  private imageTag(): string {
    return `${IMAGE_TAG_PREFIX}:${this.version}`;
  }

  private containerName(): string {
    return `${CONTAINER_NAME_PREFIX}-${this.version}`;
  }

  private async buildImageIfNeeded(): Promise<void> {
    const tag = this.imageTag();
    console.log(`[spawntree-daemon] [postgres:${this.version}] Checking image ${tag}...`);

    // Check if image already exists
    try {
      await this.docker.getImage(tag).inspect();
      console.log(`[spawntree-daemon] [postgres:${this.version}] Image ${tag} already exists`);
      return;
    } catch {
      // Image doesn't exist, build it
    }

    await this.buildImage();
  }

  private async buildImage(): Promise<void> {
    const tag = this.imageTag();
    console.log(`[spawntree-daemon] [postgres:${this.version}] Building image ${tag}...`);

    // Write Dockerfile
    const dockerfileDir = resolve(spawntreeHome(), "postgres");
    mkdirSync(dockerfileDir, { recursive: true });
    const dockerfilePath = resolve(dockerfileDir, `Dockerfile.${this.version}`);
    writeFileSync(dockerfilePath, dockerfileContent(this.version));

    // Build via dockerode using the Dockerfile directory as context
    const buildStream = await this.docker.buildImage(
      { context: dockerfileDir, src: [`Dockerfile.${this.version}`] },
      { t: tag, dockerfile: `Dockerfile.${this.version}` },
    );

    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        buildStream,
        (err: Error | null, output: unknown[]) => {
          if (err) {
            reject(err);
          } else {
            // Check for error in output
            const lastLine = output[output.length - 1] as Record<string, unknown> | undefined;
            if (lastLine?.error) {
              reject(new Error(String(lastLine.error)));
            } else {
              console.log(`[spawntree-daemon] [postgres:${this.version}] Image ${tag} built successfully`);
              resolve();
            }
          }
        },
        (event: Record<string, unknown>) => {
          if (event.stream) {
            const line = String(event.stream).trimEnd();
            if (line) console.log(`[spawntree-daemon] [postgres:${this.version}] build: ${line}`);
          }
        },
      );
    });
  }

  private async createAndStart(): Promise<void> {
    const tag = this.imageTag();
    const dataDir = pgDataDir(this.version);

    console.log(`[spawntree-daemon] [postgres:${this.version}] Creating container from ${tag}...`);

    const container = await this.docker.createContainer({
      Image: tag,
      name: this.containerName(),
      Env: ["POSTGRES_HOST_AUTH_METHOD=trust"],
      Labels: {
        "spawntree.managed": "true",
        "spawntree.type": "postgres",
        "spawntree.version": this.version,
      },
      ExposedPorts: { "5432/tcp": {} },
      HostConfig: {
        PortBindings: {
          "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: String(this.port) }],
        },
        Binds: [`${dataDir}:/var/lib/postgresql/data`],
        RestartPolicy: { Name: "unless-stopped" },
      },
    });

    await container.start();
    this.containerId = container.id;
    console.log(`[spawntree-daemon] [postgres:${this.version}] Container started: ${container.id.slice(0, 12)}`);

    await this.waitForReady(60_000);
    this._status = "running";
  }

  private async waitForReady(timeoutMs: number): Promise<void> {
    console.log(`[spawntree-daemon] [postgres:${this.version}] Waiting for pg_isready...`);
    const start = Date.now();
    const interval = 1000;

    while (Date.now() - start < timeoutMs) {
      try {
        const container = this.requireContainer();
        const out = await execInContainer(container, [
          "pg_isready",
          "-U",
          "postgres",
        ]);
        if (out.includes("accepting connections")) {
          console.log(`[spawntree-daemon] [postgres:${this.version}] Ready!`);
          return;
        }
      } catch {
        // Not yet ready
      }
      await new Promise((r) => setTimeout(r, interval));
    }

    throw new Error(
      `Postgres ${this.version} did not become ready within ${timeoutMs / 1000}s`,
    );
  }
}
