import { parse as parseYaml } from "yaml";
import { substituteVars } from "./substitution.ts";

export interface ServiceConfig {
  type: "process" | "container" | "postgres" | "redis" | "external";
  command?: string;
  port?: number;
  image?: string;
  url?: string; // external: the upstream URL to proxy to
  toolchain?: Record<string, string>;
  healthcheck?: {
    url: string;
    timeout?: number;
    interval?: number;
  };
  depends_on?: string[];
  environment?: Record<string, string>;
  fork_from?: string;
  volumes?: Array<{
    host: string;
    container: string;
    mode?: "ro" | "rw";
  }>;
}

export interface PrepareConfig {
  command: string;
  inputs?: string[];
}

export interface ProfileConfig {
  extends?: string | string[];
  services?: Record<string, Partial<ServiceConfig> | ServiceConfig>;
  environment?: Record<string, string>;
  prepare?: Partial<PrepareConfig> | PrepareConfig;
}

export interface ProxyConfig {
  port: number;
}

export interface SpawntreeConfig {
  proxy?: ProxyConfig;
  prepare?: PrepareConfig;
  environment?: Record<string, string>;
  profiles?: Record<string, ProfileConfig>;
  services: Record<string, ServiceConfig>;
}

export interface ParseConfigOptions {
  profile?: string;
}

export function parseConfig(
  yamlContent: string,
  envVars: Record<string, string>,
  options: ParseConfigOptions = {},
): SpawntreeConfig {
  const raw = parseYaml(yamlContent) as Record<string, unknown>;
  const resolvedProfile = resolveProfile(raw, options.profile);
  const profileEnvVars = stringRecord(resolvedProfile.environment);
  const mergedEnvVars = {
    ...envVars,
    ...profileEnvVars,
  };
  const substituted = substituteVarsInObject(resolvedProfile, mergedEnvVars);
  return substituted as SpawntreeConfig;
}

function resolveProfile(
  raw: Record<string, unknown>,
  requestedProfile?: string,
): Record<string, unknown> {
  const profiles = asRecord(raw.profiles);
  const hasProfiles = Object.keys(profiles).length > 0;
  if (!hasProfiles && requestedProfile === "default") {
    return { ...raw };
  }
  const profileName = requestedProfile ?? (hasProfiles && profiles.default ? "default" : undefined);

  if (!profileName) {
    return { ...raw };
  }

  const resolved: Record<string, unknown> = {
    ...raw,
    services: { ...asRecord(raw.services) },
    environment: { ...stringRecord(raw.environment) },
  };
  delete resolved.profiles;

  const seen = new Set<string>();
  for (const name of profileChain(profiles, profileName, seen)) {
    const profile = asRecord(profiles[name]);
    mergeProfile(resolved, profile);
  }

  return resolved;
}

function profileChain(
  profiles: Record<string, unknown>,
  profileName: string,
  seen: Set<string>,
): string[] {
  if (seen.has(profileName)) {
    throw new Error(`Profile extends cycle detected at "${profileName}"`);
  }
  if (!(profileName in profiles)) {
    throw new Error(`Unknown profile "${profileName}"`);
  }
  const profile = asRecord(profiles[profileName]);

  seen.add(profileName);
  const parents = profile.extends
    ? Array.isArray(profile.extends)
      ? profile.extends
      : [profile.extends]
    : [];
  const chain = parents.flatMap((parent) =>
    typeof parent === "string" ? profileChain(profiles, parent, seen) : [],
  );
  chain.push(profileName);
  seen.delete(profileName);
  return chain;
}

function mergeProfile(target: Record<string, unknown>, profile: Record<string, unknown>): void {
  target.environment = {
    ...stringRecord(target.environment),
    ...stringRecord(profile.environment),
  };

  if (profile.prepare && typeof profile.prepare === "object") {
    target.prepare = {
      ...asRecord(target.prepare),
      ...asRecord(profile.prepare),
    };
  }

  const services = asRecord(profile.services);
  if (services) {
    const targetServices = { ...asRecord(target.services) };
    for (const [name, service] of Object.entries(services)) {
      targetServices[name] = mergeServiceConfig(targetServices[name], service);
    }
    target.services = targetServices;
  }
}

function mergeServiceConfig(base: unknown, overlay: unknown): Record<string, unknown> {
  const baseRecord = asRecord(base);
  const overlayRecord = asRecord(overlay);
  return {
    ...baseRecord,
    ...overlayRecord,
    environment:
      baseRecord.environment || overlayRecord.environment
        ? {
            ...stringRecord(baseRecord.environment),
            ...stringRecord(overlayRecord.environment),
          }
        : undefined,
    healthcheck:
      baseRecord.healthcheck || overlayRecord.healthcheck
        ? {
            ...asRecord(baseRecord.healthcheck),
            ...asRecord(overlayRecord.healthcheck),
          }
        : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, inner] of Object.entries(asRecord(value))) {
    if (typeof inner === "string") {
      result[key] = inner;
    }
  }
  return result;
}

function substituteVarsInObject(obj: unknown, vars: Record<string, string>): unknown {
  if (typeof obj === "string") {
    return substituteVars(obj, vars);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => substituteVarsInObject(item, vars));
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteVarsInObject(value, vars);
    }
    return result;
  }
  return obj;
}
