import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

export class ProxyServer {
  private routes = new Map<string, number>(); // hostname → target port
  private server: ReturnType<typeof createServer> | null = null;
  private readonly port: number;

  constructor(port: number = 9080) {
    this.port = port;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, "127.0.0.1", () => resolve());
      this.server!.on("error", reject);
    });

    console.log(`[spawntree-daemon] Proxy server listening on http://127.0.0.1:${this.port}`);
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this.server = null;
    console.log("[spawntree-daemon] Proxy server stopped");
  }

  register(hostname: string, targetPort: number): void {
    this.routes.set(hostname, targetPort);
    console.log(`[spawntree-daemon] Proxy route registered: ${hostname} → :${targetPort}`);
  }

  unregister(hostname: string): void {
    this.routes.delete(hostname);
    console.log(`[spawntree-daemon] Proxy route removed: ${hostname}`);
  }

  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  get proxyPort(): number {
    return this.port;
  }

  registeredHostnames(): string[] {
    return [...this.routes.keys()];
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Strip port from Host header (e.g. "api-main.myrepo.localhost:9080" → "api-main.myrepo.localhost")
    const host = (req.headers.host ?? "").split(":")[0];

    const targetPort = this.routes.get(host);
    if (targetPort === undefined) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`[spawntree-daemon] No route for host: ${host}\n`);
      return;
    }

    this.proxyTo(targetPort, req, res);
  }

  private proxyTo(port: number, req: IncomingMessage, res: ServerResponse): void {
    const options = {
      hostname: "127.0.0.1",
      port,
      path: req.url ?? "/",
      method: req.method,
      headers: { ...req.headers },
    };

    // Override the host header so the upstream sees the right thing
    options.headers["host"] = `127.0.0.1:${port}`;

    const proxyReq = httpRequest(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`[spawntree-daemon] Upstream error: ${err.message}\n`);
      }
    });

    // Pipe request body (POST/PUT etc.)
    req.pipe(proxyReq, { end: true });
  }
}
