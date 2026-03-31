import {
  createProxyServer,
  RouteStore,
  syncHostsFile,
  formatUrl,
  parseHostname,
  type ProxyServer,
  type RouteInfo,
} from "portless";
import { spawntreeHome } from "../state/global-state.js";
import { resolve } from "node:path";

const DEFAULT_PROXY_PORT = 1355;
const TLD = "localhost";

export class ProxyManager {
  private proxy: ProxyServer | null = null;
  private routeStore: RouteStore;
  private routes = new Map<string, number>();
  private started = false;
  readonly proxyPort: number;

  constructor(port: number = DEFAULT_PROXY_PORT) {
    this.proxyPort = port;
    this.routeStore = new RouteStore(resolve(spawntreeHome(), "proxy"), {
      onWarning: (msg) => console.log(`[spawntree-proxy] ${msg}`),
    });
    this.routeStore.ensureDir();
  }

  async ensureRunning(): Promise<void> {
    if (this.started) return;

    this.proxy = createProxyServer({
      getRoutes: () => this.getRouteList(),
      proxyPort: this.proxyPort,
      tld: TLD,
    });

    await new Promise<void>((resolve, reject) => {
      this.proxy!.on("error", (err: Error) => {
        if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
          console.log(`[spawntree-proxy] Port ${this.proxyPort} in use, reusing existing proxy`);
          this.proxy = null;
          this.started = true;
          resolve();
        } else {
          reject(err);
        }
      });

      (this.proxy as any).listen(this.proxyPort, "127.0.0.1", () => {
        console.log(`[spawntree-proxy] Listening on port ${this.proxyPort}`);
        this.started = true;
        resolve();
      });
    });
  }

  register(repoId: string, envId: string, serviceName: string, targetPort: number): string {
    const hostname = parseHostname(`${serviceName}-${envId}`, TLD);

    this.routes.set(hostname, targetPort);

    try {
      this.routeStore.addRoute(hostname, targetPort, process.pid, true);
    } catch {
      // non-fatal
    }

    try {
      syncHostsFile([...this.routes.keys()]);
    } catch {
      // needs sudo, expected to fail
    }

    return formatUrl(hostname, this.proxyPort);
  }

  unregister(repoId: string, envId: string, serviceName: string): void {
    const hostname = parseHostname(`${serviceName}-${envId}`, TLD);
    this.routes.delete(hostname);
    try { this.routeStore.removeRoute(hostname); } catch { /* non-fatal */ }
  }

  unregisterAll(repoId: string, envId: string): void {
    const suffix = `-${envId}.${TLD}`;
    for (const hostname of [...this.routes.keys()]) {
      if (hostname.endsWith(suffix)) {
        this.routes.delete(hostname);
        try { this.routeStore.removeRoute(hostname); } catch { /* non-fatal */ }
      }
    }
  }

  async stop(): Promise<void> {
    if (this.proxy) {
      await new Promise<void>((resolve) => {
        (this.proxy as any).close(() => resolve());
      });
      this.proxy = null;
    }
    for (const hostname of this.routes.keys()) {
      try { this.routeStore.removeRoute(hostname); } catch { /* non-fatal */ }
    }
    this.routes.clear();
    this.started = false;
  }

  private getRouteList(): RouteInfo[] {
    return [...this.routes.entries()].map(([hostname, port]) => ({ hostname, port }));
  }
}
