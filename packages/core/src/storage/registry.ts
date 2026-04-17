import type { PrimaryStorageProvider, ReplicatorProvider } from "./types.ts";

/**
 * Central registry of storage providers. Built-ins register themselves when
 * their modules are imported. Third-party providers call the registration
 * methods before the daemon boots its active configuration.
 *
 * The registry is intentionally a simple map; it doesn't instantiate
 * providers or hold connections. Those responsibilities live in the
 * `StorageManager` (daemon-side).
 */
export class StorageRegistry {
  private readonly primaries = new Map<string, PrimaryStorageProvider>();
  private readonly replicators = new Map<string, ReplicatorProvider>();

  registerPrimary(provider: PrimaryStorageProvider): void {
    if (this.primaries.has(provider.id)) {
      throw new Error(`Primary storage provider already registered: "${provider.id}"`);
    }
    this.primaries.set(provider.id, provider);
  }

  registerReplicator(provider: ReplicatorProvider): void {
    if (this.replicators.has(provider.id)) {
      throw new Error(`Replicator provider already registered: "${provider.id}"`);
    }
    this.replicators.set(provider.id, provider);
  }

  getPrimary(id: string): PrimaryStorageProvider | undefined {
    return this.primaries.get(id);
  }

  getReplicator(id: string): ReplicatorProvider | undefined {
    return this.replicators.get(id);
  }

  listPrimaries(): PrimaryStorageProvider[] {
    return [...this.primaries.values()];
  }

  listReplicators(): ReplicatorProvider[] {
    return [...this.replicators.values()];
  }
}
