import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Service, ServiceStatus, ServiceConfig } from "spawntree-core";

/**
 * ExternalRunner proxies requests to a remote URL, rewriting CORS headers
 * so the external service feels local. Supports HTTP, SSE, and WebSocket.
 *
 * Usage in spawntree.yaml:
 *   api:
 *     type: external
 *     url: https://api.staging.example.com
 *     port: 3000  # logical port hint
 *
 * spawntree allocates a local port and runs a proxy server on it.
 * All requests to localhost:<port> are forwarded to the upstream URL.
 * CORS headers are rewritten so browsers treat it as same-origin.
 */
export interface ExternalRunnerOptions {
  name: string;
  config: ServiceConfig;
  allocatedPort: number;
}

export class ExternalRunner implements Service {
  readonly name: string;
  readonly type = "external" as const;
  private _status: ServiceStatus = "stopped";
  private server: ReturnType<typeof createServer> | null = null;
  private readonly upstreamUrl: URL;
  private readonly allocatedPort: number;
  private readonly isHttps: boolean;

  constructor(options: ExternalRunnerOptions) {
    this.name = options.name;
    this.allocatedPort = options.allocatedPort;
    this.upstreamUrl = new URL(options.config.url || "http://localhost");
    this.isHttps = this.upstreamUrl.protocol === "https:";
  }

  async start(): Promise<void> {
    this._status = "starting";

    this.server = createServer((req, res) => this.proxyRequest(req, res));

    // WebSocket upgrade
    this.server.on("upgrade", (req, socket, head) => {
      this.proxyWebSocket(req, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(this.allocatedPort, "127.0.0.1", () => {
        this._status = "running";
        console.log(`[spawntree-daemon] [external:${this.name}] Proxying localhost:${this.allocatedPort} → ${this.upstreamUrl.origin}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this._status = "stopped";
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }

  status(): ServiceStatus {
    return this._status;
  }

  async healthcheck(): Promise<boolean> {
    // Check upstream is reachable
    try {
      const res = await fetch(this.upstreamUrl.origin, {
        method: "HEAD",
        signal: AbortSignal.timeout(5000),
      });
      return res.status < 500;
    } catch {
      return false;
    }
  }

  get pid(): undefined {
    return undefined;
  }

  private proxyRequest(req: IncomingMessage, res: ServerResponse): void {
    const targetPath = req.url || "/";
    const targetUrl = new URL(targetPath, this.upstreamUrl.origin);

    // Build upstream request headers
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!value) continue;
      // Rewrite host header to upstream
      if (key === "host") {
        headers[key] = this.upstreamUrl.host;
        continue;
      }
      // Rewrite origin to upstream (for CORS preflight)
      if (key === "origin") {
        headers[key] = this.upstreamUrl.origin;
        continue;
      }
      // Rewrite referer to upstream
      if (key === "referer") {
        const refUrl = new URL(value as string);
        refUrl.hostname = this.upstreamUrl.hostname;
        refUrl.port = this.upstreamUrl.port;
        refUrl.protocol = this.upstreamUrl.protocol;
        headers[key] = refUrl.toString();
        continue;
      }
      headers[key] = value as string;
    }

    const reqFn = this.isHttps ? httpsRequest : httpRequest;
    const proxyReq = reqFn(
      {
        hostname: this.upstreamUrl.hostname,
        port: this.upstreamUrl.port || (this.isHttps ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        // Rewrite CORS headers to allow the local origin
        const responseHeaders: Record<string, string | string[] | undefined> = { ...proxyRes.headers };

        // Replace upstream origin with local origin in CORS headers
        const localOrigin = `http://127.0.0.1:${this.allocatedPort}`;
        if (responseHeaders["access-control-allow-origin"]) {
          const acaoVal = responseHeaders["access-control-allow-origin"] as string;
          if (acaoVal !== "*") {
            responseHeaders["access-control-allow-origin"] = localOrigin;
          }
        } else {
          // Add permissive CORS for local dev
          responseHeaders["access-control-allow-origin"] = "*";
        }
        responseHeaders["access-control-allow-credentials"] = "true";
        responseHeaders["access-control-allow-methods"] = "GET, POST, PUT, DELETE, PATCH, OPTIONS";
        responseHeaders["access-control-allow-headers"] = req.headers["access-control-request-headers"] || "*";

        // Don't cache (local dev)
        delete responseHeaders["x-frame-options"];

        // Stream SSE properly: disable buffering
        if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
          responseHeaders["cache-control"] = "no-cache";
          responseHeaders["connection"] = "keep-alive";
        }

        res.writeHead(proxyRes.statusCode || 502, responseHeaders);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`External proxy error (${this.name}): ${err.message}`);
      }
    });

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
        "access-control-allow-headers": req.headers["access-control-request-headers"] || "*",
        "access-control-max-age": "86400",
      });
      res.end();
      proxyReq.destroy();
      return;
    }

    req.pipe(proxyReq);
  }

  private proxyWebSocket(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    const targetPath = req.url || "/";
    const wsProtocol = this.isHttps ? "wss:" : "ws:";
    const targetUrl = new URL(targetPath, `${wsProtocol}//${this.upstreamUrl.host}`);

    const reqFn = this.isHttps ? httpsRequest : httpRequest;
    const proxyReq = reqFn({
      hostname: this.upstreamUrl.hostname,
      port: this.upstreamUrl.port || (this.isHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: "GET",
      headers: {
        ...req.headers,
        host: this.upstreamUrl.host,
      },
    });

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      let rawResponse = `HTTP/1.1 101 Switching Protocols\r\n`;
      for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
        rawResponse += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
      }
      rawResponse += "\r\n";
      socket.write(rawResponse);
      if (proxyHead.length > 0) socket.write(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });

    proxyReq.on("error", () => socket.destroy());
    proxyReq.end();
  }
}
