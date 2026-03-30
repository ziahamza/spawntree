import { ProxyServer } from "../proxy/proxy-server.js";

export class ProxyManager {
  private proxy: ProxyServer;
  private started = false;

  constructor(port?: number) {
    this.proxy = new ProxyServer(port);
  }

  async ensureRunning(): Promise<void> {
    if (this.started) return;
    await this.proxy.start();
    this.started = true;
  }

  /**
   * Register a route and return the clean URL for the service.
   * hostname = `<serviceName>-<envId>.<repoId>.localhost`
   */
  register(repoId: string, envId: string, serviceName: string, targetPort: number): string {
    const hostname = `${serviceName}-${envId}.${repoId}.localhost`;
    this.proxy.register(hostname, targetPort);
    return `http://${hostname}:${this.proxy.proxyPort}`;
  }

  unregister(repoId: string, envId: string, serviceName: string): void {
    const hostname = `${serviceName}-${envId}.${repoId}.localhost`;
    this.proxy.unregister(hostname);
  }

  unregisterAll(repoId: string, envId: string): void {
    // Unregister all routes matching this repo+env prefix
    // The hostname pattern is `<service>-<envId>.<repoId>.localhost`
    const suffix = `.${repoId}.localhost`;
    const envSuffix = `-${envId}${suffix}`;

    for (const hostname of this.proxy.registeredHostnames()) {
      if (hostname.endsWith(envSuffix)) {
        this.proxy.unregister(hostname);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.proxy.stop();
    this.started = false;
  }
}
