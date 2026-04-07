import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { LogLine } from "spawntree-core";
import { logDir } from "../state/global-state.ts";

const SSE_BUFFER_SIZE = 100;

interface ServiceBuffer {
  lines: LogLine[];
  subscribers: Set<(line: LogLine) => void>;
  writeStream: ReturnType<typeof createWriteStream>;
}

function bufferKey(repoId: string, envId: string, service: string): string {
  return `${repoId}:${envId}:${service}`;
}

export interface SubscribeOptions {
  service?: string;
  follow?: boolean;
  lines?: number;
}

/**
 * Manages log write-through to disk and live SSE fanout.
 *
 * Logs are written to:
 *   ~/.spawntree/repos/<repoId>/logs/<envId>/<service>.log
 *
 * Up to SSE_BUFFER_SIZE recent lines are kept in memory per service
 * for replay to new SSE subscribers.
 */
export class LogStreamer {
  private buffers: Map<string, ServiceBuffer> = new Map();

  /**
   * Add a log line for a service. Writes to disk and notifies SSE subscribers.
   */
  addLine(
    repoId: string,
    envId: string,
    service: string,
    stream: "stdout" | "stderr" | "system",
    line: string,
  ): void {
    const key = bufferKey(repoId, envId, service);
    let buf = this.buffers.get(key);

    if (!buf) {
      const dir = logDir(repoId, envId);
      const filePath = resolve(dir, `${service}.log`);
      const writeStream = createWriteStream(filePath, { flags: "a" });
      buf = {
        lines: [],
        subscribers: new Set(),
        writeStream,
      };
      this.buffers.set(key, buf);
    }

    const logLine: LogLine = {
      ts: new Date().toISOString(),
      service,
      stream,
      line,
    };

    // Write to disk
    buf.writeStream.write(JSON.stringify(logLine) + "\n");

    // Buffer for SSE replay
    buf.lines.push(logLine);
    if (buf.lines.length > SSE_BUFFER_SIZE) {
      buf.lines.shift();
    }

    // Notify live subscribers
    for (const subscriber of buf.subscribers) {
      subscriber(logLine);
    }
  }

  /**
   * Subscribe to live log lines for an env (optionally filtered to a single service).
   * Returns a ReadableStream that emits SSE-formatted events.
   */
  subscribe(repoId: string, envId: string, opts: SubscribeOptions): ReadableStream {
    const { service: filterService, follow = true, lines: historyLines = 50 } = opts;

    // Track subscribed keys for cleanup
    const subscribedKeys: string[] = [];
    let sendFn: ((logLine: LogLine) => void) | null = null;

    return new ReadableStream({
      start: (controller) => {
        const send = (logLine: LogLine) => {
          if (filterService && logLine.service !== filterService) return;
          const data = `data: ${JSON.stringify(logLine)}\n\n`;
          try {
            controller.enqueue(new TextEncoder().encode(data));
          } catch {
            // controller may be closed — clean up subscriber
            this.removeSubscriber(subscribedKeys, send);
          }
        };
        sendFn = send;

        // Replay buffered history
        const services = filterService
          ? [filterService]
          : this.getServicesForEnv(repoId, envId);

        for (const svc of services) {
          const key = bufferKey(repoId, envId, svc);
          const buf = this.buffers.get(key);
          if (buf) {
            for (const logLine of buf.lines.slice(-historyLines)) {
              send(logLine);
            }
          }
        }

        if (!follow) {
          controller.close();
          return;
        }

        // Subscribe to live lines
        const subscribeTo = (svc: string) => {
          const key = bufferKey(repoId, envId, svc);
          let buf = this.buffers.get(key);
          if (!buf) {
            const dir = logDir(repoId, envId);
            const filePath = resolve(dir, `${svc}.log`);
            const writeStream = createWriteStream(filePath, { flags: "a" });
            buf = { lines: [], subscribers: new Set(), writeStream };
            this.buffers.set(key, buf);
          }
          buf.subscribers.add(send);
          subscribedKeys.push(key);
        };

        if (filterService) {
          subscribeTo(filterService);
        } else {
          for (const svc of services) {
            subscribeTo(svc);
          }
        }
      },

      // Called when the client disconnects or stream is cancelled
      cancel: () => {
        if (sendFn) {
          this.removeSubscriber(subscribedKeys, sendFn);
        }
      },
    });
  }

  private removeSubscriber(keys: string[], send: (logLine: LogLine) => void): void {
    for (const key of keys) {
      this.buffers.get(key)?.subscribers.delete(send);
    }
  }

  /**
   * Register a new service for an env (so subscribe-all can discover it).
   */
  initService(repoId: string, envId: string, service: string): void {
    const key = bufferKey(repoId, envId, service);
    if (!this.buffers.has(key)) {
      const dir = logDir(repoId, envId);
      const filePath = resolve(dir, `${service}.log`);
      const writeStream = createWriteStream(filePath, { flags: "a" });
      this.buffers.set(key, {
        lines: [],
        subscribers: new Set(),
        writeStream,
      });
    }
  }

  /**
   * Read historical log lines from disk.
   * Returns an array of parsed LogLine objects.
   */
  async readHistory(
    repoId: string,
    envId: string,
    service?: string,
    lines = 200,
  ): Promise<LogLine[]> {
    const services = service
      ? [service]
      : this.getServicesForEnv(repoId, envId);

    const all: LogLine[] = [];

    for (const svc of services) {
      const dir = logDir(repoId, envId);
      const filePath = resolve(dir, `${svc}.log`);

      if (!existsSync(filePath)) continue;

      const svcLines = await readLastLines(filePath, lines);
      for (const raw of svcLines) {
        try {
          all.push(JSON.parse(raw) as LogLine);
        } catch {
          // skip malformed lines
        }
      }
    }

    // Sort chronologically
    all.sort((a, b) => a.ts.localeCompare(b.ts));
    return all.slice(-lines);
  }

  /**
   * Close write streams for all services of an env (called on env teardown).
   */
  closeEnv(repoId: string, envId: string): void {
    for (const [key, buf] of this.buffers.entries()) {
      if (key.startsWith(`${repoId}:${envId}:`)) {
        buf.writeStream.end();
        buf.subscribers.clear();
        this.buffers.delete(key);
      }
    }
  }

  private getServicesForEnv(repoId: string, envId: string): string[] {
    const prefix = `${repoId}:${envId}:`;
    const services: string[] = [];
    for (const key of this.buffers.keys()) {
      if (key.startsWith(prefix)) {
        services.push(key.slice(prefix.length));
      }
    }
    return services;
  }
}

/**
 * Read the last N lines from a file efficiently.
 */
async function readLastLines(filePath: string, n: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      if (line.trim()) {
        lines.push(line);
        if (lines.length > n * 2) {
          lines.splice(0, lines.length - n);
        }
      }
    });

    rl.on("close", () => resolve(lines.slice(-n)));
    rl.on("error", reject);
  });
}
