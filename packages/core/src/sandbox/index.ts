/**
 * Public sandbox API for spawntree. Exported from `spawntree-core`.
 *
 * Sessions normally run as host processes; a *sandbox* runs the agent inside a
 * container/VM behind a pluggable provider. See `types.ts` for the contracts.
 * Dependency-pure interfaces + registry live here; concrete providers (Docker,
 * Apple `container`) live in the daemon and register themselves before boot:
 *
 *   ```ts
 *   import { SandboxRegistry } from "spawntree-core";
 *   const registry = new SandboxRegistry();
 *   registry.register(dockerSandboxProvider);
 *   registry.register(appleContainerSandboxProvider);
 *   ```
 *
 * The daemon's `SandboxManager` then activates providers from persisted config
 * on boot and routes session spawns into them.
 */
export * from "./types.ts";
export { HostSpawner, hostSpawner } from "./host-spawner.ts";
export { SandboxRegistry } from "./registry.ts";
export { loadSandboxConfig, saveSandboxConfig } from "./config.ts";
