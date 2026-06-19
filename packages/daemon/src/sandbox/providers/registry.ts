import { SandboxRegistry } from "spawntree-core";
import { appleContainerSandboxProvider } from "./apple-container.ts";
import { dockerSandboxProvider } from "./docker.ts";

/**
 * The built-in sandbox providers, mirroring storage's `defaultRegistry()`.
 * Both register unconditionally; `SandboxManager` filters by `isAvailable()`
 * at runtime (Docker on any host with a daemon; Apple `container` on
 * Apple-silicon macOS 26+), so multiple providers coexist on one machine.
 */
export function defaultSandboxRegistry(): SandboxRegistry {
  const registry = new SandboxRegistry();
  registry.register(dockerSandboxProvider);
  registry.register(appleContainerSandboxProvider);
  return registry;
}
