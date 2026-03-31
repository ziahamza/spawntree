import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";

export class ProxyServer {
  private routes = new Map<string, number>();
  private server: ReturnType<typeof createServer> | null = null;
  readonly port: number;

  constructor(port: number = 1355) {
    this.port = port;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = createServer((req, res) => this.handleRequest(req, res));

    // WebSocket upgrade
    this.server.on("upgrade", (req, socket, head) => {
      const host = (req.headers.host || "").split(":")[0];
      const targetPort = this.routes.get(host);
      if (!targetPort) {
        socket.destroy();
        return;
      }

      const proxyReq = request({
        hostname: "127.0.0.1",
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          "x-forwarded-host": req.headers.host || "",
          "x-forwarded-proto": "http",
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
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(this.port, "127.0.0.1", () => {
        console.log(`[spawntree-proxy] Listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }

  register(hostname: string, targetPort: number): void {
    this.routes.set(hostname, targetPort);
  }

  unregister(hostname: string): void {
    this.routes.delete(hostname);
  }

  registeredHostnames(): string[] {
    return [...this.routes.keys()];
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const host = (req.headers.host || "").split(":")[0];
    const targetPort = this.routes.get(host);

    if (!targetPort) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`No route for host: ${host}\nActive routes:\n${[...this.routes.entries()].map(([h, p]) => `  ${h} → ${p}`).join("\n")}`);
      return;
    }

    const proxyReq = request(
      {
        hostname: "127.0.0.1",
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          "x-forwarded-host": req.headers.host || "",
          "x-forwarded-proto": "http",
          "x-forwarded-for": req.socket.remoteAddress || "",
        },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Proxy error: ${err.message}`);
    });

    req.pipe(proxyReq);
  }
}
