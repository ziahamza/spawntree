import { ProxyServer } from "../proxy/proxy-server.js";

const DEFAULT_PROXY_PORT = 1355;

export class ProxyManager {
  private proxy: ProxyServer;
  private started = false;

  constructor(port: number = DEFAULT_PROXY_PORT) {
    this.proxy = new ProxyServer(port);
  }

  get proxyPort(): number {
    return this.proxy.port;
  }

  async ensureRunning(): Promise<void> {
    if (this.started) return;

    try {
      await this.proxy.start();
      this.started = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        console.log(`[spawntree-proxy] Port ${this.proxy.port} in use (portless or another instance running)`);
        this.started = true; // port is handled by something else, proceed
      } else {
        throw err;
      }
    }
  }

  /**
   * Register a service and return its clean URL.
   * Pattern: <serviceName>-<envId>.localhost:<proxyPort>
   */
  register(repoId: string, envId: string, serviceName: string, targetPort: number): string {
    const hostname = `${serviceName}-${envId}.localhost`;
    this.proxy.register(hostname, targetPort);
    return `http://${hostname}:${this.proxy.port}`;
  }

  unregister(repoId: string, envId: string, serviceName: string): void {
    const hostname = `${serviceName}-${envId}.localhost`;
    this.proxy.unregister(hostname);
  }

  unregisterAll(repoId: string, envId: string): void {
    const suffix = `-${envId}.localhost`;
    for (const hostname of this.proxy.registeredHostnames()) {
      if (hostname.endsWith(suffix)) {
        this.proxy.unregister(hostname);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.started) {
      await this.proxy.stop();
      this.started = false;
    }
  }
}
