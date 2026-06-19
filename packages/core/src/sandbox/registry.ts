import type { SandboxProvider } from "./types.ts";

/**
 * Central registry of sandbox providers. Built-ins register themselves when
 * their modules are imported; third-party providers call `register(...)`
 * before the daemon boots its active configuration.
 *
 * Like `StorageRegistry`, this is intentionally a simple map: it doesn't
 * instantiate providers or hold live sandboxes. Those responsibilities live in
 * the daemon-side `SandboxManager`.
 */
export class SandboxRegistry {
  private readonly providers = new Map<string, SandboxProvider>();

  register(provider: SandboxProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Sandbox provider already registered: "${provider.id}"`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): SandboxProvider | undefined {
    return this.providers.get(id);
  }

  list(): SandboxProvider[] {
    return [...this.providers.values()];
  }
}
